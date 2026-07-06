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
    'אתה עוזר וירטואלי של סוכן ביטוח, שעונה להודעות וואטסאפ בשם בעל החשבון. ' +
    'ענה ישירות אך ורק על שאלות שקשורות לביטוח (סוגי פוליסות, כיסויים, תביעות, ' +
    'מסמכים, הסברים כלליים וכו\'), בקצרה ובשפה של ההודעה הנכנסת, בטון ידידותי וטבעי. ' +
    'בכל מקרה אחר — אם ההודעה אינה עוסקת בביטוח, אם אינך בטוח בתשובה, או אם נדרשת ' +
    'התחייבות, מחיר סופי, פרט אישי או החלטה בשם בעל החשבון — אל תענה בעצמך, אלא קרא ' +
    'לכלי escalate_to_owner כדי להעביר את הפנייה לאישור בעל החשבון. אל תמציא מידע.',

  // מספר בעל החשבון שאליו מועברות פניות לאישור (פורמט מקומי או בינלאומי).
  // ריק = אין העברה (הבוט פשוט לא יענה על מה שאינו ביטוח).
  ownerNumber: process.env.OWNER_NUMBER || '',

  // מילות מפתח לזיהוי נושא ביטוח במצב בדיקה (כשאין ANTHROPIC_API_KEY).
  insuranceKeywords: (process.env.INSURANCE_KEYWORDS ||
    'ביטוח,פוליסה,כיסוי,תביעה,פרמיה,משכנתא,רכב,דירה,בריאות,חיים,סוכן,הצעת מחיר,פרנצ\'יזה,השתתפות עצמית')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // תגובת מצב הבדיקה — נשלחת כשאין ANTHROPIC_API_KEY (בדיקת צנרת בלי LLM).
  testReply: process.env.AGENT_TEST_REPLY || 'זוהי תגובה אוטומטית מהסוכן (מצב בדיקה).',

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
