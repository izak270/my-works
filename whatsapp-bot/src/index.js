const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('./config');
const { processWithAgent } = require('./agent');

// מצב הבוט בזמן ריצה — נשלט ע"י ה-Kill Switch.
let botActive = config.startActive;

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

// צימוד: אם הוגדר מספר טלפון — מבקשים קוד צימוד (פעם אחת); אחרת מציגים QR.
let pairingCodeRequested = false;

client.on('qr', async (qr) => {
  if (config.pairingPhoneNumber) {
    if (pairingCodeRequested) return;
    pairingCodeRequested = true;
    try {
      const code = await client.requestPairingCode(config.pairingPhoneNumber);
      console.log(`🔗 קוד צימוד עבור ${config.pairingPhoneNumber}: ${code}`);
      console.log('   בטלפון: וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר ← "קשר באמצעות מספר טלפון".');
    } catch (error) {
      console.error('❌ בקשת קוד הצימוד נכשלה, נופל חזרה ל-QR:', error.message);
      qrcode.generate(qr, { small: true });
    }
    return;
  }
  console.log('סרוק את קוד ה-QR עם וואטסאפ בטלפון (הגדרות ← מכשירים מקושרים ← קישור מכשיר):');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ הבוט מחובר לוואטסאפ.');
  console.log(`   מצב נוכחי: ${botActive ? 'פעיל (עונה להודעות)' : 'האזנה בלבד (Read-Only)'}`);
  console.log(`   Kill Switch: שלח "${config.killSwitchOff}" מהטלפון שלך לכיבוי, "${config.killSwitchOn}" להדלקה.`);
  if (config.triggerKeyword) {
    console.log(`   מילת מפתח: הבוט מגיב רק להודעות שמתחילות ב-"${config.triggerKeyword}".`);
  }
  if (config.allowedNumbers.length > 0) {
    console.log(`   מספרים מורשים: ${config.allowedNumbers.join(', ')}`);
  }
});

client.on('auth_failure', (msg) => console.error('❌ כשל אימות:', msg));
client.on('disconnected', (reason) => console.error('⚠️ החיבור נותק:', reason));

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
        console.log('🛑 Kill Switch: הבוט כובה — חזרה למצב האזנה בלבד.');
      } else if (command === config.killSwitchOn) {
        botActive = true;
        console.log('🟢 Kill Switch: הבוט הודלק — מצב פעיל.');
      }
      // סינון קריטי: לעולם לא מגיבים להודעות שלך — מניעת לולאה אינסופית.
      return;
    }

    console.log(`הודעה נכנסת מ-${msg.from}: ${msg.body}`);

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

    console.log(`↩️ נשלחה תגובה ל-${msg.from}: ${outgoing}`);
  } catch (error) {
    console.error('שגיאה בטיפול בהודעה:', error);
  }
});

client.initialize();
