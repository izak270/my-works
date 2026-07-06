#!/usr/bin/env bash
# ==============================================================
#  WhatsApp Agent Bot — התקנה אוטומטית מלאה (Mac / Linux)
#  הרצה:
#  curl -fsSL https://raw.githubusercontent.com/izak270/my-works/claude/whatsapp-bot-active-messaging-1vawci/whatsapp-bot/setup.sh | bash
# ==============================================================
set -euo pipefail

echo ""
echo "===== שלב 1/4: בדיקת Node.js ====="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js לא מותקן. התקן מ-https://nodejs.org (LTS) והרץ את השורה שוב."
  exit 1
fi
echo "Node מותקן: $(node -v)"

echo ""
echo "===== שלב 2/4: הורדת הקוד ====="
DEST="$HOME/whatsapp-bot"
TMP="$(mktemp -d)"
curl -fsSL -o "$TMP/wabot.zip" \
  'https://github.com/izak270/my-works/archive/refs/heads/claude/whatsapp-bot-active-messaging-1vawci.zip'
unzip -q "$TMP/wabot.zip" -d "$TMP"
if [ -d "$DEST" ]; then
  # שומרים צימוד והגדרות קיימים אם יש
  [ -f "$DEST/.env" ] && mv "$DEST/.env" "$TMP/.env.keep"
  [ -d "$DEST/.wwebjs_auth" ] && mv "$DEST/.wwebjs_auth" "$TMP/.wwebjs_auth.keep"
  rm -rf "$DEST"
fi
mv "$TMP/my-works-claude-whatsapp-bot-active-messaging-1vawci/whatsapp-bot" "$DEST"
[ -f "$TMP/.env.keep" ] && mv "$TMP/.env.keep" "$DEST/.env"
[ -d "$TMP/.wwebjs_auth.keep" ] && mv "$TMP/.wwebjs_auth.keep" "$DEST/.wwebjs_auth"
cd "$DEST"
echo "הקוד הותקן ב: $DEST"

echo ""
echo "===== שלב 3/4: הגדרות ====="
if [ ! -f .env ]; then
  echo 'BOT_ENABLED=false' > .env
  echo "נוצר .env במצב חיבור-בלבד (הבוט מאזין ולא עונה)."
else
  echo "נמצא .env קיים — נשמר כמו שהוא."
fi

echo ""
echo "===== שלב 4/4: התקנת תלויות (כמה דקות בפעם הראשונה) ====="
npm install

echo ""
echo "================================================"
echo " הכל מוכן! מפעיל את הבוט..."
echo " ה-QR יופיע כאן בטרמינל וגם בדפדפן:"
echo "   http://127.0.0.1:3000"
echo " סרוק מהטלפון של המספר האמריקאי:"
echo " וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר"
echo "================================================"
echo ""
npm start
