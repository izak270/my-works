# Gmail + Gemini Auto-Reply Bot (פרויקט נסיוני)

בוט שמאזין לתיבת Gmail, ולכל מייל נכנס מנסח תשובה בעזרת Gemini API לפי פרומפט מותאם אישית, יחד עם **ציון ביטחון** (0–1):

- **ביטחון ≥ סף** (ברירת מחדל 0.8) → התשובה נשלחת **ישירות ללקוח** כתגובה למייל.
- **ביטחון < סף** → הטיוטה נשלחת **למייל אישור** שהגדרתם, כולל המייל המקורי, הטיוטה, ציון הביטחון והנימוק — ואתם שולחים ידנית.

## איך זה עובד

1. הבוט בודק כל `POLL_INTERVAL_SECONDS` שניות אם יש מיילים חדשים (לא נקראו) ב-INBOX דרך IMAP.
2. תוכן המייל נשלח ל-Gemini עם הפרומפט מ-`prompt.txt`, ו-Gemini מחזיר JSON מובנה: טיוטת תשובה, ציון ביטחון ונימוק.
3. לפי ציון הביטחון — שליחה ללקוח (SMTP, כ-Reply אמיתי עם In-Reply-To) או למייל האישור.
4. מיילים אוטומטיים (no-reply, רשימות תפוצה, bulk), מיילים מעצמכם או מכתובת האישור — מדולגים כדי למנוע לולאות.
5. אם קריאת Gemini נכשלת — נשלחת הודעת שגיאה למייל האישור והמייל מסומן כנקרא (לא ננסה שוב בלולאה).

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
| `DRY_RUN` | `false` | הדפסה ללוג במקום שליחה אמיתית |

## רעיונות להמשך

- אישור בקליק: תשובה למייל האישור עם "אשר" שתשלח את הטיוטה אוטומטית.
- שמירת לוג/היסטוריה של תשובות ב-DB.
- שימוש ב-Gmail API (OAuth) במקום IMAP/SMTP + App Password.
