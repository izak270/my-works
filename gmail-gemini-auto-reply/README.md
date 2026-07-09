# Gmail + Gemini Auto-Reply Bot (פרויקט נסיוני)

בוט שמאזין לתיבת Gmail. לכל מייל נכנס, Gemini מחליט בעצמו — דרך **function calling (כלים)** — בין שתי פעולות:

- **`reply_to_customer`** — השאלה בתחום שהוגדר בפרומפט (למשל: רק ביטוח) ו-Gemini בטוח בתשובה (ציון ביטחון ≥ סף) → התשובה נשלחת **ישירות ללקוח** כתגובה בשרשור.
- **`request_human_approval`** — המייל לא בתחום, חסר מידע, או שהביטחון נמוך → המייל + טיוטה (אם יש) + נימוק נשלחים **למייל האישור**, עם טוקן מעקב בנושא (`[דרוש אישור #ab12cd34]`).

**לולאת האישור:** המאשר פשוט משיב למייל האישור (בלי לשנות את הנושא) עם התשובה או הנחיה מה לענות. הבוט מזהה את התשובה לפי הטוקן, מנסח ממנה תשובה מלוטשת בעזרת Gemini, ושולח אותה ללקוח המקורי אוטומטית.

## איך זה עובד

1. הבוט בודק כל `POLL_INTERVAL_SECONDS` שניות אם יש מיילים חדשים (לא נקראו) ב-INBOX דרך IMAP.
2. תוכן המייל נשלח ל-Gemini עם הפרומפט מ-`prompt.txt` ושני הכלים; Gemini חייב לבחור כלי אחד (mode: ANY).
3. תשובה ישירה נשלחת ב-SMTP כ-Reply אמיתי (In-Reply-To/References). בקשת אישור נרשמת ב-`pending_approvals.json` עד שהמאשר עונה.
4. תשובת מאשר מזוהה לפי כתובת השולח + הטוקן בנושא; הטקסט שמעל הציטוט הוא ההנחיה. אם ניסוח בעזרת Gemini נכשל — ההנחיה נשלחת כמו שהיא.
5. מיילים אוטומטיים (no-reply, רשימות תפוצה, bulk), מיילים מעצמכם או מהבוט עצמו — מדולגים כדי למנוע לולאות.
6. אם קריאת Gemini נכשלת — נשלחת הודעת שגיאה למייל האישור והמייל מסומן כנקרא (לא ננסה שוב בלולאה).

## התקנה

```bash
cd gmail-gemini-auto-reply
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### מה צריך להשיג

1. **Gmail App Password** — בחשבון Google עם אימות דו-שלבי מופעל:
   https://myaccount.google.com/apppasswords (לא הסיסמה הרגילה של החשבון!)
   בנוסף ודאו ש-IMAP מופעל: Gmail → Settings → Forwarding and POP/IMAP → Enable IMAP.
2. **Gemini API Key** — בחינם מ-Google AI Studio: https://aistudio.google.com/apikey
3. **מייל לאישורים** — הכתובת שאליה יישלחו טיוטות שדורשות בדיקה אנושית.

מלאו את כל הערכים ב-`.env` (הקובץ ב-`.gitignore` ולא עולה לגיט).

### הפרומפט שלכם

ערכו את `prompt.txt` — זה ה-system prompt שמנחה את Gemini איך לענות (טון, שפה, מדיניות העסק, מתי לתת ציון ביטחון נמוך וכו').

## הרצה

```bash
python main.py
```

**מומלץ להתחיל עם `DRY_RUN=true`** (ברירת המחדל ב-`.env.example`) — הבוט יעבד מיילים וידפיס ללוג מה היה שולח, בלי לשלוח בפועל. כשהתוצאות נראות טוב, שנו ל-`DRY_RUN=false`.

## הגדרות (ENV)

| משתנה | ברירת מחדל | תיאור |
|---|---|---|
| `GMAIL_ADDRESS` | — | כתובת ה-Gmail של הבוט |
| `GMAIL_APP_PASSWORD` | — | App Password של Gmail |
| `GEMINI_API_KEY` | — | מפתח Gemini API |
| `APPROVAL_EMAIL` | — | כתובת לקבלת טיוטות לאישור |
| `GEMINI_MODEL` | `gemini-2.5-flash` | מודל Gemini |
| `CONFIDENCE_THRESHOLD` | `0.8` | סף ביטחון לשליחה אוטומטית |
| `POLL_INTERVAL_SECONDS` | `60` | תדירות בדיקת מיילים |
| `PROMPT_FILE` | `prompt.txt` | קובץ הפרומפט |
| `STATE_FILE` | `pending_approvals.json` | קובץ מצב לאישורים ממתינים |
| `DRY_RUN` | `false` | הדפסה ללוג במקום שליחה אמיתית |

## רעיונות להמשך

- שמירת לוג/היסטוריה של תשובות ב-DB.
- שימוש ב-Gmail API (OAuth) במקום IMAP/SMTP + App Password.
- ניקוי אוטומטי של בקשות אישור ישנות שלא נענו.
