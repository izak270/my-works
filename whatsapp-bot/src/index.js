const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('./config');
const dashboard = require('./dashboard');
const { processWithAgent } = require('./agent');

// ===== מצב ריצה משותף (נצפה גם מהדשבורד) =====
let botActive = config.startActive; // Kill Switch
let connection = 'initializing'; // initializing | waiting_pairing | connected | disconnected
const pairing = { code: null, qrDataUrl: null };
const events = []; // יומן אירועים אחרונים (ring buffer)

function logEvent(text) {
  console.log(text);
  events.push({ ts: Date.now(), text });
  if (events.length > 200) events.shift();
}

// תמיכה בסביבות עם דפדפן מותקן מראש ו/או פרוקסי יוצא (למשל קונטיינר ענן):
// PUPPETEER_EXECUTABLE_PATH — נתיב ל-Chromium קיים במקום הורדה.
// HTTPS_PROXY — מועבר לדפדפן כ---proxy-server.
const puppeteerArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) puppeteerArgs.push(`--proxy-server=${proxyUrl}`);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: config.sessionDir }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: puppeteerArgs,
  },
});

// ===== צימוד =====
// אם הוגדר מספר טלפון — מבקשים קוד צימוד (פעם אחת); אחרת מציגים QR.
let pairingCodeRequested = false;

client.on('qr', async (qr) => {
  connection = 'waiting_pairing';
  if (config.pairingPhoneNumber) {
    if (pairingCodeRequested) return;
    pairingCodeRequested = true;
    try {
      const code = await client.requestPairingCode(config.pairingPhoneNumber);
      pairing.code = code;
      logEvent(`🔗 קוד צימוד עבור ${config.pairingPhoneNumber}: ${code}`);
      console.log('   בטלפון: וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר ← "קשר באמצעות מספר טלפון".');
    } catch (error) {
      logEvent(`❌ בקשת קוד הצימוד נכשלה, נופל חזרה ל-QR: ${error.message}`);
      pairing.qrDataUrl = await QRCode.toDataURL(qr).catch(() => null);
      qrcode.generate(qr, { small: true });
    }
    return;
  }
  // QR מוצג גם בטרמינל וגם בדשבורד (מתחדש כל ~30 שניות)
  pairing.qrDataUrl = await QRCode.toDataURL(qr).catch(() => null);
  console.log('סרוק את קוד ה-QR עם וואטסאפ בטלפון (הגדרות ← מכשירים מקושרים ← קישור מכשיר):');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  connection = 'connected';
  pairing.code = null;
  pairing.qrDataUrl = null;
  logEvent('✅ הבוט מחובר לוואטסאפ.');
  console.log(`   מצב נוכחי: ${botActive ? 'פעיל (עונה להודעות)' : 'האזנה בלבד (Read-Only)'}`);
  console.log(`   Kill Switch: שלח "${config.killSwitchOff}" מהטלפון שלך לכיבוי, "${config.killSwitchOn}" להדלקה.`);
  if (config.triggerKeyword) {
    console.log(`   מילת מפתח: הבוט מגיב רק להודעות שמתחילות ב-"${config.triggerKeyword}".`);
  }
  if (config.allowedNumbers.length > 0) {
    console.log(`   מספרים מורשים: ${config.allowedNumbers.join(', ')}`);
  }
});

client.on('auth_failure', (msg) => {
  connection = 'disconnected';
  logEvent(`❌ כשל אימות: ${msg}`);
});

client.on('disconnected', (reason) => {
  connection = 'disconnected';
  logEvent(`⚠️ החיבור נותק: ${reason}`);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  const { minReplyDelayMs, maxReplyDelayMs } = config;
  return minReplyDelayMs + Math.floor(Math.random() * (maxReplyDelayMs - minReplyDelayMs + 1));
}

// numberFromChatId("972501234567@c.us") -> "972501234567"
function numberFromChatId(chatId) {
  return chatId.split('@')[0];
}

// message_create נורה גם על הודעות שנשלחו ממך — נדרש בשביל ה-Kill Switch.
client.on('message_create', async (msg) => {
  try {
    // --- Kill Switch: פקודות נסתרות מהטלפון שלך ---
    if (msg.fromMe) {
      const command = msg.body.trim().toLowerCase();
      if (command === config.killSwitchOff) {
        botActive = false;
        logEvent('🛑 Kill Switch (מהטלפון): הבוט כובה — חזרה למצב האזנה בלבד.');
      } else if (command === config.killSwitchOn) {
        botActive = true;
        logEvent('🟢 Kill Switch (מהטלפון): הבוט הודלק — מצב פעיל.');
      }
      // סינון קריטי: לעולם לא מגיבים להודעות שלך — מניעת לולאה אינסופית.
      return;
    }

    logEvent(`📥 הודעה מ-${msg.from}: ${msg.body}`);

    // --- שרשרת סינונים: הסוכן עונה רק כשכל התנאים מתקיימים ---

    // 1. הבוט כבוי? האזנה בלבד.
    if (!botActive) return;

    // 2. מתעלמים מסטטוסים.
    if (msg.from === 'status@broadcast') return;

    // 3. קבוצות (@g.us) — רק אם הותר במפורש.
    if (msg.from.endsWith('@g.us') && !config.respondInGroups) return;

    // 4. רשימת מספרים מורשים (אם הוגדרה).
    if (
      config.allowedNumbers.length > 0 &&
      !config.allowedNumbers.includes(numberFromChatId(msg.from))
    ) {
      return;
    }

    // 5. מילת מפתח (אם הוגדרה) — ההודעה חייבת להתחיל בה.
    let text = msg.body.trim();
    if (config.triggerKeyword) {
      if (!text.toLowerCase().startsWith(config.triggerKeyword.toLowerCase())) return;
      text = text.slice(config.triggerKeyword.length).trim();
      if (!text) return; // "!bot" בלי תוכן — אין מה לענות עליו.
    }

    // --- העברת ההודעה לסוכן ---
    const agentReply = await processWithAgent(text, msg.from);
    if (!agentReply) return;

    // --- שליחה עם חיווי אנושי (Humanizing) ---
    // מטא חוסמת מספרים פרטיים עם התנהגות "בוטית" (מענה תוך מאית שנייה),
    // לכן מדליקים חיווי "מקליד..." וממתינים השהיה אקראית לפני השליחה.
    const chat = await msg.getChat();
    await chat.sendStateTyping();
    await sleep(randomDelay());

    // הקידומת (אם הוגדרה) מסמנת בשיחה שהתגובה נשלחה ע"י הסוכן ולא על ידך.
    const outgoing = config.replyPrefix + agentReply;
    await client.sendMessage(msg.from, outgoing);
    await chat.clearState();

    logEvent(`↩️ נשלחה תגובה ל-${msg.from}: ${outgoing}`);
  } catch (error) {
    logEvent(`שגיאה בטיפול בהודעה: ${error.message}`);
  }
});

// ===== דשבורד ווב =====
dashboard.start({
  getState: () => ({
    connection,
    botActive,
    pairing,
    config: {
      triggerKeyword: config.triggerKeyword,
      allowedNumbers: config.allowedNumbers,
      respondInGroups: config.respondInGroups,
      model: config.model,
    },
    events,
  }),
  setActive: (active) => {
    if (botActive === active) return;
    botActive = active;
    logEvent(active
      ? '🟢 Kill Switch (מהדשבורד): הבוט הודלק — מצב פעיל.'
      : '🛑 Kill Switch (מהדשבורד): הבוט כובה — חזרה למצב האזנה בלבד.');
  },
});

client.initialize().catch((error) => {
  connection = 'disconnected';
  logEvent(`❌ ההתחברות לוואטסאפ נכשלה: ${error.message}`);
  console.error('   הדשבורד נשאר זמין. בדוק חיבור לאינטרנט והפעל מחדש.');
});
