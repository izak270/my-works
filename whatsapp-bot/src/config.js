// כל ההגדרות מגיעות ממשתני סביבה (.env) כדי לאפשר שליטה בלי לגעת בקוד.
require('dotenv').config();

function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

module.exports = {
  // מצב התחלתי של הבוט. ברירת מחדל: כבוי (Read-Only) — הבוט לא עונה במקומך
  // עד שמדליקים אותו במפורש (BOT_ENABLED=true או פקודת !bot-on מהטלפון שלך).
  startActive: parseBool(process.env.BOT_ENABLED, false),

  // Kill Switch — פקודות נסתרות שנשלחות מהטלפון שלך (הודעות fromMe).
  // שליחת ההודעה "!bot-off" לכל שיחה מכבה את הבוט מיידית; "!bot-on" מדליקה.
  killSwitchOn: (process.env.KILL_SWITCH_ON || '!bot-on').toLowerCase(),
  killSwitchOff: (process.env.KILL_SWITCH_OFF || '!bot-off').toLowerCase(),

  // רשימת מספרים מורשים (ללא + , בפורמט בינלאומי, למשל 972501234567).
  // רשימה ריקה = אין הגבלת מספרים (אבל עדיין חלה מילת המפתח למטה).
  allowedNumbers: parseList(process.env.ALLOWED_NUMBERS),

  // מילת מפתח שההודעה חייבת להתחיל בה כדי שהבוט יגיב.
  // ברירת מחדל: "!bot" — כך הסוכן נכנס לפעולה רק כשמבקשים ממנו במפורש.
  // ערך ריק ("") מבטל את הדרישה והבוט יענה על כל הודעה שעברה את שאר הסינונים.
  triggerKeyword: process.env.TRIGGER_KEYWORD !== undefined
    ? process.env.TRIGGER_KEYWORD.trim()
    : '!bot',

  // האם להגיב בקבוצות (@g.us). ברירת מחדל: לא.
  respondInGroups: parseBool(process.env.RESPOND_IN_GROUPS, false),

  // צימוד לפי מספר טלפון (בפורמט בינלאומי ללא +, למשל 972501234567).
  // אם מוגדר — במקום סריקת QR תקבל קוד צימוד להזנה בטלפון:
  // וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר ← "קשר באמצעות מספר טלפון".
  pairingPhoneNumber: (process.env.PAIRING_PHONE_NUMBER || '').replace(/[^0-9]/g, ''),

  // קידומת שתתווסף לכל תגובה של הסוכן (למשל "🤖 ") כדי שתוכל להבחין
  // בשיחה בין תגובות הבוט לבין הודעות שכתבת בעצמך. ריק = ללא סימון.
  replyPrefix: process.env.BOT_REPLY_PREFIX || '',

  // השהיה אנושית (מילישניות) לפני שליחת התגובה, נבחרת אקראית בטווח.
  minReplyDelayMs: parseInt(process.env.MIN_REPLY_DELAY_MS || '2000', 10),
  maxReplyDelayMs: parseInt(process.env.MAX_REPLY_DELAY_MS || '5000', 10),

  // הגדרות הסוכן (LLM)
  model: process.env.AGENT_MODEL || 'claude-opus-4-8',
  maxTokens: parseInt(process.env.AGENT_MAX_TOKENS || '1024', 10),
  historyTurns: parseInt(process.env.AGENT_HISTORY_TURNS || '20', 10),
  systemPrompt:
    process.env.AGENT_SYSTEM_PROMPT ||
    'אתה עוזר אישי שעונה להודעות וואטסאפ בשם בעל החשבון. ' +
    'ענה בקצרה, בשפה של ההודעה הנכנסת, בטון ידידותי וטבעי. ' +
    'אם אינך בטוח במשהו — אמור זאת, ואל תתחייב בשם בעל החשבון לפגישות, תשלומים או הבטחות.',

  // תיקיית שמירת הסשן של WhatsApp (כדי לא לסרוק QR בכל הפעלה)
  sessionDir: process.env.SESSION_DIR || './.wwebjs_auth',

  // ===== דשבורד ווב =====
  dashboardEnabled: parseBool(process.env.DASHBOARD_ENABLED, true),
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000', 10),
  // ברירת מחדל: מאזין רק מקומית. חשיפה לאינטרנט — דרך מנהרה (ראה README)
  // או DASHBOARD_HOST=0.0.0.0, ואז חובה להגדיר DASHBOARD_PASSWORD.
  dashboardHost: process.env.DASHBOARD_HOST || '127.0.0.1',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
};
