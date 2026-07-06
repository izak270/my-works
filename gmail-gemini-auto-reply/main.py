"""Gmail + Gemini auto-reply bot.

Polls a Gmail inbox over IMAP. For every new (unseen) email it asks Gemini
to draft a reply based on a configurable prompt, together with a confidence
score. If the confidence is at or above CONFIDENCE_THRESHOLD the reply is
sent straight back to the customer; otherwise the draft is emailed to
APPROVAL_EMAIL for a human to review and send manually.

All configuration comes from environment variables (see .env.example).
"""

import email
import email.utils
import imaplib
import json
import logging
import os
import re
import smtplib
import sys
import time
from email.header import decode_header, make_header
from email.message import EmailMessage

import requests
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("auto-reply")

# --- Configuration -----------------------------------------------------------

GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
APPROVAL_EMAIL = os.environ.get("APPROVAL_EMAIL", "")

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
CONFIDENCE_THRESHOLD = float(os.environ.get("CONFIDENCE_THRESHOLD", "0.8"))
POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))
PROMPT_FILE = os.environ.get("PROMPT_FILE", "prompt.txt")
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() in ("1", "true", "yes")

IMAP_HOST = "imap.gmail.com"
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "{model}:generateContent"
)

# Senders we must never answer automatically (avoids mail loops).
NO_REPLY_PATTERN = re.compile(
    r"(no-?reply|do-?not-?reply|mailer-daemon|postmaster)", re.IGNORECASE
)


def require_config() -> None:
    missing = [
        name
        for name, value in [
            ("GMAIL_ADDRESS", GMAIL_ADDRESS),
            ("GMAIL_APP_PASSWORD", GMAIL_APP_PASSWORD),
            ("GEMINI_API_KEY", GEMINI_API_KEY),
            ("APPROVAL_EMAIL", APPROVAL_EMAIL),
        ]
        if not value
    ]
    if missing:
        log.error("Missing required environment variables: %s", ", ".join(missing))
        sys.exit(1)


def load_prompt() -> str:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), PROMPT_FILE)
    if not os.path.exists(path):
        path = PROMPT_FILE
    with open(path, encoding="utf-8") as fh:
        return fh.read().strip()


# --- Email parsing -----------------------------------------------------------


def decode_str(value: str) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def extract_body(msg: email.message.Message) -> str:
    """Return the plain-text body, falling back to stripped HTML."""
    plain, html = "", ""
    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        if "attachment" in str(part.get("Content-Disposition", "")):
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        charset = part.get_content_charset() or "utf-8"
        try:
            text = payload.decode(charset, errors="replace")
        except LookupError:
            text = payload.decode("utf-8", errors="replace")
        if ctype == "text/plain" and not plain:
            plain = text
        elif ctype == "text/html" and not html:
            html = text
    if plain:
        return plain.strip()
    if html:
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        return re.sub(r"\s+", " ", text).strip()
    return ""


def should_skip(msg: email.message.Message, sender_addr: str) -> str | None:
    """Return a reason to skip this message, or None to process it."""
    if not sender_addr:
        return "no sender address"
    lowered = sender_addr.lower()
    if lowered == GMAIL_ADDRESS.lower():
        return "sent by ourselves"
    if lowered == APPROVAL_EMAIL.lower():
        return "sent by the approval address"
    if NO_REPLY_PATTERN.search(lowered):
        return "no-reply style sender"
    auto_submitted = str(msg.get("Auto-Submitted", "no")).lower()
    if auto_submitted not in ("", "no"):
        return f"auto-submitted: {auto_submitted}"
    if str(msg.get("Precedence", "")).lower() in ("bulk", "list", "junk"):
        return "bulk/list precedence"
    if msg.get("List-Id"):
        return "mailing list"
    return None


# --- Gemini ------------------------------------------------------------------

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "reply_body": {
            "type": "STRING",
            "description": "The full reply email body, ready to send to the customer.",
        },
        "confidence": {
            "type": "NUMBER",
            "description": "0-1 score: how confident you are the reply is correct, "
            "complete and safe to send without human review.",
        },
        "reasoning": {
            "type": "STRING",
            "description": "Short explanation of the confidence score.",
        },
    },
    "required": ["reply_body", "confidence", "reasoning"],
}


def draft_reply(system_prompt: str, sender: str, subject: str, body: str) -> dict:
    """Ask Gemini for a reply draft + confidence score. Returns the parsed dict."""
    user_content = (
        f"נתקבל מייל חדש שיש לענות עליו.\n"
        f"מאת: {sender}\n"
        f"נושא: {subject}\n"
        f"---\n"
        f"{body[:20000]}\n"
        f"---\n"
        "נסח תשובה מלאה למייל הזה לפי ההנחיות שקיבלת, וכן ציון ביטחון בין 0 ל-1 "
        "המשקף עד כמה בטוח שהתשובה נכונה ובטוחה לשליחה ללא בדיקה אנושית. "
        "אם חסר מידע, המייל דורש החלטה אנושית, או שאינך בטוח - תן ציון נמוך."
    )
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_content}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
            "temperature": 0.3,
        },
    }
    resp = requests.post(
        GEMINI_URL.format(model=GEMINI_MODEL),
        params={"key": GEMINI_API_KEY},
        json=payload,
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    result = json.loads(text)
    result["confidence"] = max(0.0, min(1.0, float(result.get("confidence", 0))))
    return result


# --- Sending -----------------------------------------------------------------


def send_email(msg: EmailMessage) -> None:
    if DRY_RUN:
        log.info("[DRY_RUN] Would send to %s: %s", msg["To"], msg["Subject"])
        return
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as smtp:
        smtp.starttls()
        smtp.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        smtp.send_message(msg)


def reply_subject(subject: str) -> str:
    return subject if subject.lower().startswith("re:") else f"Re: {subject}"


def send_customer_reply(original: email.message.Message, sender: str,
                        subject: str, reply_body: str) -> None:
    msg = EmailMessage()
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = sender
    msg["Subject"] = reply_subject(subject)
    orig_id = original.get("Message-ID")
    if orig_id:
        msg["In-Reply-To"] = orig_id
        msg["References"] = f"{original.get('References', '')} {orig_id}".strip()
    msg.set_content(reply_body)
    send_email(msg)


def send_for_approval(sender: str, subject: str, original_body: str,
                      result: dict) -> None:
    msg = EmailMessage()
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = APPROVAL_EMAIL
    msg["Subject"] = f"[דרוש אישור] {reply_subject(subject)}"
    msg.set_content(
        "התקבל מייל חדש והתשובה שנוסחה דורשת אישור אנושי.\n\n"
        f"ציון ביטחון: {result['confidence']:.2f} (סף: {CONFIDENCE_THRESHOLD})\n"
        f"נימוק: {result.get('reasoning', '')}\n\n"
        f"=== המייל המקורי (מאת {sender}) ===\n"
        f"נושא: {subject}\n\n"
        f"{original_body[:5000]}\n\n"
        "=== טיוטת התשובה המוצעת ===\n\n"
        f"{result['reply_body']}\n\n"
        "כדי לשלוח ללקוח: העתק את הטיוטה (או ערוך אותה) ושלח ידנית אל "
        f"{sender}."
    )
    send_email(msg)


def notify_failure(sender: str, subject: str, error: str) -> None:
    msg = EmailMessage()
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = APPROVAL_EMAIL
    msg["Subject"] = f"[שגיאה בבוט] {subject}"
    msg.set_content(
        f"לא הצלחתי לנסח תשובה למייל מאת {sender} (נושא: {subject}).\n\n"
        f"שגיאה: {error}\n\nיש לטפל במייל ידנית."
    )
    try:
        send_email(msg)
    except Exception:
        log.exception("Failed to send failure notification")


# --- Main loop ---------------------------------------------------------------


def process_message(raw_bytes: bytes, system_prompt: str) -> None:
    msg = email.message_from_bytes(raw_bytes)
    subject = decode_str(msg.get("Subject", "(ללא נושא)"))
    sender_name, sender_addr = email.utils.parseaddr(decode_str(msg.get("From", "")))
    sender_display = f"{sender_name} <{sender_addr}>" if sender_name else sender_addr

    skip_reason = should_skip(msg, sender_addr)
    if skip_reason:
        log.info("Skipping email from %s (%s)", sender_display, skip_reason)
        return

    body = extract_body(msg)
    if not body:
        log.info("Skipping email from %s (empty body)", sender_display)
        return

    log.info("Processing email from %s, subject: %s", sender_display, subject)
    try:
        result = draft_reply(system_prompt, sender_display, subject, body)
    except Exception as exc:
        log.exception("Gemini call failed")
        notify_failure(sender_display, subject, str(exc))
        return

    confidence = result["confidence"]
    log.info("Draft ready, confidence=%.2f (threshold %.2f)",
             confidence, CONFIDENCE_THRESHOLD)

    if confidence >= CONFIDENCE_THRESHOLD:
        send_customer_reply(msg, sender_addr, subject, result["reply_body"])
        log.info("Replied directly to %s", sender_addr)
    else:
        send_for_approval(sender_display, subject, body, result)
        log.info("Sent draft to approval address %s", APPROVAL_EMAIL)


def poll_once(system_prompt: str) -> None:
    imap = imaplib.IMAP4_SSL(IMAP_HOST)
    try:
        imap.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        imap.select("INBOX")
        status, data = imap.search(None, "UNSEEN")
        if status != "OK":
            log.warning("IMAP search failed: %s", status)
            return
        ids = data[0].split()
        if ids:
            log.info("Found %d new email(s)", len(ids))
        for msg_id in ids:
            # PEEK so a crash before processing leaves the mail unseen.
            status, msg_data = imap.fetch(msg_id, "(BODY.PEEK[])")
            if status != "OK" or not msg_data or msg_data[0] is None:
                log.warning("Failed to fetch message %s", msg_id)
                continue
            try:
                process_message(msg_data[0][1], system_prompt)
            finally:
                # Mark seen even on failure so we never loop on a bad email;
                # failures were already forwarded to the approval address.
                imap.store(msg_id, "+FLAGS", "\\Seen")
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def main() -> None:
    require_config()
    system_prompt = load_prompt()
    log.info("Starting Gmail auto-reply bot for %s (model=%s, threshold=%.2f, dry_run=%s)",
             GMAIL_ADDRESS, GEMINI_MODEL, CONFIDENCE_THRESHOLD, DRY_RUN)
    while True:
        try:
            poll_once(system_prompt)
        except Exception:
            log.exception("Polling cycle failed; retrying next cycle")
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
