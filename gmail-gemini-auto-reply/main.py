"""Gmail + Gemini auto-reply bot.

Polls a Gmail inbox over IMAP. For every new (unseen) email, Gemini decides
via function calling between two tools:

- reply_to_customer: the question is on-topic (per prompt.txt) and Gemini is
  confident -> the reply is sent straight back to the customer.
- request_human_approval: off-topic / uncertain -> the email plus a draft is
  forwarded to APPROVAL_EMAIL with a tracking token in the subject.

When the approver replies to an approval email (keeping the token in the
subject) with what to answer, the bot composes the final reply from that
instruction and sends it to the original customer.

All configuration comes from environment variables (see .env.example).
"""

import email
import email.utils
import imaplib
import json
import logging
import os
import re
import secrets
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
STATE_FILE = os.environ.get("STATE_FILE", "pending_approvals.json")
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() in ("1", "true", "yes")
# Process the inbox once and exit instead of looping forever. Used when an
# external scheduler (e.g. GitHub Actions cron) drives the polling.
RUN_ONCE = os.environ.get("RUN_ONCE", "false").lower() in ("1", "true", "yes")

IMAP_HOST = "imap.gmail.com"
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "{model}:generateContent"
)

# Marks approval-request emails we send, so we never mistake our own
# request for the approver's reply (relevant when the bot mailbox IS the
# approval mailbox).
BOT_HEADER = "X-Gemini-AutoReply"

# Senders we must never answer automatically (avoids mail loops).
NO_REPLY_PATTERN = re.compile(
    r"(no-?reply|do-?not-?reply|mailer-daemon|postmaster)", re.IGNORECASE
)

APPROVAL_TOKEN_PATTERN = re.compile(r"#([0-9a-f]{8})")

# Lines that start the quoted part of a reply; text above them is the
# approver's own answer.
QUOTE_START_PATTERN = re.compile(
    r"^(>|On .+ wrote:|-{2,}\s*Original Message|"
    r"בתאריך .+)",  # "בתאריך ..." (Gmail Hebrew)
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


def project_path(name: str) -> str:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
    return path if os.path.exists(path) or not os.path.exists(name) else name


def load_prompt() -> str:
    with open(project_path(PROMPT_FILE), encoding="utf-8") as fh:
        return fh.read().strip()


# --- Pending-approval state --------------------------------------------------


def load_state() -> dict:
    path = project_path(STATE_FILE)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return {}


def save_state(state: dict) -> None:
    with open(project_path(STATE_FILE), "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)


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
        text = re.sub(r"<br\s*/?>|</p>", "\n", text, flags=re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        return re.sub(r"[ \t]+", " ", text).strip()
    return ""


def extract_top_text(body: str) -> str:
    """Return the reply text the approver wrote above the quoted email."""
    lines = []
    for line in body.splitlines():
        if QUOTE_START_PATTERN.match(line.strip()):
            break
        lines.append(line)
    return "\n".join(lines).strip()


def should_skip(msg: email.message.Message, sender_addr: str) -> str | None:
    """Return a reason to skip this message, or None to process it."""
    if not sender_addr:
        return "no sender address"
    lowered = sender_addr.lower()
    if msg.get(BOT_HEADER):
        return "sent by this bot"
    if lowered == GMAIL_ADDRESS.lower():
        return "sent by ourselves"
    if lowered == APPROVAL_EMAIL.lower():
        return "sent by the approval address (no matching approval token)"
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

GEMINI_TOOLS = [
    {
        "functionDeclarations": [
            {
                "name": "reply_to_customer",
                "description": (
                    "שלח תשובה ישירה ללקוח. השתמש בכלי הזה רק כאשר השאלה "
                    "בתחום שהוגדר לך בהנחיות ואתה בטוח שהתשובה נכונה, מלאה "
                    "ובטוחה לשליחה ללא בדיקה אנושית."
                ),
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "reply_body": {
                            "type": "STRING",
                            "description": "גוף התשובה המלא, מוכן לשליחה ללקוח.",
                        },
                        "confidence": {
                            "type": "NUMBER",
                            "description": "ציון ביטחון בין 0 ל-1 שהתשובה נכונה ובטוחה.",
                        },
                    },
                    "required": ["reply_body", "confidence"],
                },
            },
            {
                "name": "request_human_approval",
                "description": (
                    "העבר את המייל לאישור אנושי. השתמש בכלי הזה כאשר המייל "
                    "אינו בתחום שהוגדר לך, כשחסר מידע, כשהנושא רגיש, או "
                    "בכל מקרה של חוסר ודאות."
                ),
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "draft_reply": {
                            "type": "STRING",
                            "description": "טיוטת תשובה מוצעת, אם יש לך אחת (לא חובה).",
                        },
                        "reason": {
                            "type": "STRING",
                            "description": "הסבר קצר מדוע נדרש אישור אנושי.",
                        },
                    },
                    "required": ["reason"],
                },
            },
        ]
    }
]


def gemini_request(payload: dict) -> dict:
    resp = requests.post(
        GEMINI_URL.format(model=GEMINI_MODEL),
        params={"key": GEMINI_API_KEY},
        json=payload,
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()


def decide(system_prompt: str, sender: str, subject: str, body: str) -> tuple[str, dict]:
    """Let Gemini choose a tool for the incoming email.

    Returns ("reply_to_customer", args) or ("request_human_approval", args).
    """
    user_content = (
        f"נתקבל מייל חדש.\n"
        f"מאת: {sender}\n"
        f"נושא: {subject}\n"
        f"---\n"
        f"{body[:20000]}\n"
        f"---\n"
        "החלט לפי ההנחיות שקיבלת: אם זו שאלה בתחום שלך ואתה בטוח בתשובה - "
        "קרא ל-reply_to_customer עם התשובה וציון ביטחון. אחרת - קרא "
        "ל-request_human_approval עם נימוק (וטיוטה אם יש)."
    )
    payload = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_content}]}],
        "tools": GEMINI_TOOLS,
        "toolConfig": {"functionCallingConfig": {"mode": "ANY"}},
        "generationConfig": {"temperature": 0.3},
    }
    data = gemini_request(payload)
    for part in data["candidates"][0]["content"]["parts"]:
        call = part.get("functionCall")
        if call:
            return call["name"], call.get("args", {})
    raise ValueError(f"Gemini returned no function call: {data}")


def compose_from_instruction(system_prompt: str, pending: dict,
                             instruction: str) -> str | None:
    """Turn the approver's instruction into a polished customer reply."""
    user_content = (
        "מייל של לקוח הועבר לאישור אנושי, והמאשר השיב עם הנחיה מה לענות.\n\n"
        f"=== המייל המקורי של הלקוח (מאת {pending['customer_display']}) ===\n"
        f"נושא: {pending['subject']}\n\n"
        f"{pending['original_body']}\n\n"
        "=== ההנחיה של המאשר ===\n"
        f"{instruction}\n\n"
        "נסח את התשובה הסופית ללקוח לפי ההנחיה של המאשר. אל תסטה מהתוכן "
        "שהמאשר קבע - רק נסח אותו כתשובה מלאה ומנומסת בסגנון שהוגדר לך."
    )
    payload = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_content}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {"reply_body": {"type": "STRING"}},
                "required": ["reply_body"],
            },
            "temperature": 0.3,
        },
    }
    try:
        data = gemini_request(payload)
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)["reply_body"]
    except Exception:
        log.exception("Failed to compose reply from approver instruction; "
                      "falling back to the instruction text verbatim")
        return None


# --- Sending -----------------------------------------------------------------


def send_email(msg: EmailMessage) -> None:
    if DRY_RUN:
        log.info("[DRY_RUN] Would send to %s: %s\n%s", msg["To"], msg["Subject"],
                 msg.get_content())
        return
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as smtp:
        smtp.starttls()
        smtp.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        smtp.send_message(msg)


def reply_subject(subject: str) -> str:
    return subject if subject.lower().startswith("re:") else f"Re: {subject}"


def send_customer_reply(to_addr: str, subject: str, reply_body: str,
                        orig_message_id: str = "", orig_references: str = "") -> None:
    msg = EmailMessage()
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = to_addr
    msg["Subject"] = reply_subject(subject)
    if orig_message_id:
        msg["In-Reply-To"] = orig_message_id
        msg["References"] = f"{orig_references} {orig_message_id}".strip()
    msg.set_content(reply_body)
    send_email(msg)


def send_for_approval(original: email.message.Message, sender_display: str,
                      sender_addr: str, subject: str, original_body: str,
                      draft: str, reason: str, state: dict) -> None:
    token = secrets.token_hex(4)
    msg = EmailMessage()
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = APPROVAL_EMAIL
    msg["Subject"] = f"[דרוש אישור #{token}] {reply_subject(subject)}"
    msg[BOT_HEADER] = "approval-request"
    draft_section = (
        f"=== טיוטת תשובה מוצעת ===\n\n{draft}\n\n" if draft else ""
    )
    msg.set_content(
        "התקבל מייל חדש שדורש טיפול אנושי.\n\n"
        f"סיבה: {reason}\n\n"
        f"=== המייל המקורי (מאת {sender_display}) ===\n"
        f"נושא: {subject}\n\n"
        f"{original_body[:5000]}\n\n"
        f"{draft_section}"
        "כדי לענות ללקוח: השב למייל הזה (בלי לשנות את הנושא) וכתוב את "
        "התשובה או הנחיה מה לענות - והבוט ינסח וישלח אותה ללקוח באופן "
        "אוטומטי."
    )
    send_email(msg)
    state[token] = {
        "customer_addr": sender_addr,
        "customer_display": sender_display,
        "subject": subject,
        "orig_message_id": original.get("Message-ID", ""),
        "orig_references": original.get("References", ""),
        "original_body": original_body[:5000],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    save_state(state)
    log.info("Approval request #%s sent to %s", token, APPROVAL_EMAIL)


def notify_failure(sender: str, subject: str, error: str) -> None:
    msg = EmailMessage()
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = APPROVAL_EMAIL
    msg["Subject"] = f"[שגיאה בבוט] {subject}"
    msg[BOT_HEADER] = "error-notification"
    msg.set_content(
        f"לא הצלחתי לעבד מייל מאת {sender} (נושא: {subject}).\n\n"
        f"שגיאה: {error}\n\nיש לטפל במייל ידנית."
    )
    try:
        send_email(msg)
    except Exception:
        log.exception("Failed to send failure notification")


# --- Approval-reply handling -------------------------------------------------


def handle_approval_reply(msg: email.message.Message, token: str,
                          state: dict, system_prompt: str) -> None:
    pending = state[token]
    instruction = extract_top_text(extract_body(msg))
    if not instruction:
        log.warning("Approval reply #%s has no text above the quote; ignoring",
                    token)
        return
    log.info("Approval #%s received; instruction: %.100s", token, instruction)
    reply_body = compose_from_instruction(system_prompt, pending, instruction)
    if reply_body is None:
        reply_body = instruction
    send_customer_reply(
        pending["customer_addr"],
        pending["subject"],
        reply_body,
        pending.get("orig_message_id", ""),
        pending.get("orig_references", ""),
    )
    del state[token]
    save_state(state)
    log.info("Approved reply sent to %s", pending["customer_addr"])


# --- Main loop ---------------------------------------------------------------


def process_message(raw_bytes: bytes, system_prompt: str, state: dict) -> None:
    msg = email.message_from_bytes(raw_bytes)
    subject = decode_str(msg.get("Subject", "(ללא נושא)"))
    sender_name, sender_addr = email.utils.parseaddr(decode_str(msg.get("From", "")))
    sender_display = f"{sender_name} <{sender_addr}>" if sender_name else sender_addr

    # Approval replies take priority over the skip rules (the approver may
    # be the bot's own address).
    if sender_addr.lower() == APPROVAL_EMAIL.lower() and not msg.get(BOT_HEADER):
        match = APPROVAL_TOKEN_PATTERN.search(subject)
        if match and match.group(1) in state:
            handle_approval_reply(msg, match.group(1), state, system_prompt)
            return

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
        action, args = decide(system_prompt, sender_display, subject, body)
    except Exception as exc:
        log.exception("Gemini call failed")
        notify_failure(sender_display, subject, str(exc))
        return

    if action == "reply_to_customer":
        confidence = max(0.0, min(1.0, float(args.get("confidence", 0))))
        reply_body = args.get("reply_body", "")
        log.info("Gemini chose direct reply, confidence=%.2f (threshold %.2f)",
                 confidence, CONFIDENCE_THRESHOLD)
        if reply_body and confidence >= CONFIDENCE_THRESHOLD:
            send_customer_reply(
                sender_addr, subject, reply_body,
                msg.get("Message-ID", ""), msg.get("References", ""),
            )
            log.info("Replied directly to %s", sender_addr)
            return
        # Confidence below threshold: fall through to approval with the draft.
        send_for_approval(msg, sender_display, sender_addr, subject, body,
                          reply_body,
                          f"ציון הביטחון ({confidence:.2f}) נמוך מהסף "
                          f"({CONFIDENCE_THRESHOLD})", state)
    else:
        log.info("Gemini requested human approval: %s", args.get("reason", ""))
        send_for_approval(msg, sender_display, sender_addr, subject, body,
                          args.get("draft_reply", ""),
                          args.get("reason", "לא צוין"), state)


def poll_once(system_prompt: str, state: dict) -> None:
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
                process_message(msg_data[0][1], system_prompt, state)
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
    state = load_state()
    log.info("Starting Gmail auto-reply bot for %s (model=%s, threshold=%.2f, "
             "dry_run=%s, run_once=%s, pending approvals=%d)",
             GMAIL_ADDRESS, GEMINI_MODEL, CONFIDENCE_THRESHOLD, DRY_RUN,
             RUN_ONCE, len(state))
    if RUN_ONCE:
        poll_once(system_prompt, state)
        log.info("Single poll cycle finished; exiting (RUN_ONCE)")
        return
    while True:
        try:
            poll_once(system_prompt, state)
        except Exception:
            log.exception("Polling cycle failed; retrying next cycle")
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
