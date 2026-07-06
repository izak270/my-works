// דשבורד ווב — שליטה וצפייה בבוט מהדפדפן: סטטוס, צימוד (QR/קוד),
// יומן אירועים וכפתור הדלקה/כיבוי. מוגן ב-Basic Auth כשמוגדרת סיסמה.
const crypto = require('crypto');
const express = require('express');
const config = require('./config');

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

const PAGE = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Agent Bot — דשבורד</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; max-width: 720px; margin-inline: auto; background: #f4f6f8; color: #1a2b33; }
  @media (prefers-color-scheme: dark) { body { background: #10181c; color: #e4ecef; } .card { background: #1a262c !important; } .event { border-color: #2a3a42 !important; } }
  h1 { font-size: 1.3rem; }
  .card { background: #fff; border-radius: 10px; padding: 16px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .green { background: #22b573; } .red { background: #e05252; } .yellow { background: #e0b252; }
  button { font-size: 1rem; padding: 10px 22px; border: none; border-radius: 8px; cursor: pointer; color: #fff; }
  #toggleOn { background: #22b573; } #toggleOff { background: #e05252; }
  #qrImg { max-width: 260px; width: 100%; background: #fff; padding: 8px; border-radius: 8px; }
  #pairingCode { font-size: 1.6rem; letter-spacing: .3rem; font-weight: 700; direction: ltr; display: inline-block; }
  .event { border-bottom: 1px solid #e3e8ec; padding: 6px 0; font-size: .9rem; }
  .event time { opacity: .6; font-size: .78rem; margin-inline-start: 8px; }
  .muted { opacity: .65; font-size: .88rem; }
  code { direction: ltr; unicode-bidi: embed; }
</style>
</head>
<body>
<h1>🤖 WhatsApp Agent Bot</h1>

<div class="card">
  <div class="row"><span id="connDot" class="dot yellow"></span><strong>חיבור לוואטסאפ:</strong> <span id="connText">טוען…</span></div>
  <div class="row" style="margin-top:8px"><span id="botDot" class="dot red"></span><strong>מצב הסוכן:</strong> <span id="botText">…</span></div>
  <div class="row" style="margin-top:12px">
    <button id="toggleOn" onclick="setActive(true)">🟢 הדלק מענה</button>
    <button id="toggleOff" onclick="setActive(false)">🛑 כבה (Kill Switch)</button>
  </div>
  <p class="muted" id="filters"></p>
</div>

<div class="card" id="pairingCard" style="display:none">
  <strong>צימוד למספר שלך</strong>
  <div id="pairingBody" style="margin-top:10px"></div>
</div>

<div class="card" id="pendingCard" style="display:none">
  <strong>⏳ ממתין לאישורך</strong>
  <div id="pending" style="margin-top:8px"></div>
  <p class="muted">אישור/דחייה נעשים מהוואטסאפ שלך (הבוט שולח לך את הפנייה עם הפקודות).</p>
</div>

<div class="card">
  <strong>יומן אירועים</strong>
  <div id="events" style="margin-top:8px"><span class="muted">אין אירועים עדיין.</span></div>
</div>

<script>
async function setActive(active) {
  await fetch('api/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  refresh();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function refresh() {
  try {
    const s = await (await fetch('api/state')).json();

    const connDot = document.getElementById('connDot');
    const connMap = { connected: ['green', 'מחובר ✓'], waiting_pairing: ['yellow', 'ממתין לצימוד'], disconnected: ['red', 'מנותק'], initializing: ['yellow', 'מתחבר…'] };
    const [cls, txt] = connMap[s.connection] || ['yellow', s.connection];
    connDot.className = 'dot ' + cls;
    document.getElementById('connText').textContent = txt;

    document.getElementById('botDot').className = 'dot ' + (s.botActive ? 'green' : 'red');
    document.getElementById('botText').textContent = s.botActive ? 'פעיל — עונה להודעות' : 'האזנה בלבד (לא עונה)';

    let f = [];
    if (s.config.triggerKeyword) f.push('מילת מפתח: ' + s.config.triggerKeyword);
    if (s.config.allowedNumbers.length) f.push('מספרים מורשים: ' + s.config.allowedNumbers.join(', '));
    if (s.config.ownerNumber) f.push('אישורים אל: ' + s.config.ownerNumber);
    f.push(s.config.respondInGroups ? 'קבוצות: כן' : 'קבוצות: לא');
    f.push('מודל: ' + s.config.model);
    document.getElementById('filters').textContent = f.join(' · ');

    const pendCard = document.getElementById('pendingCard');
    const pend = s.pending || [];
    if (pend.length) {
      pendCard.style.display = '';
      document.getElementById('pending').innerHTML = pend.map((p) =>
        '<div class="event"><strong>#' + p.id + '</strong> מ-' + esc(p.from) + ': ' + esc(p.question) +
        (p.suggestedReply ? '<br><span class="muted">הצעה: ' + esc(p.suggestedReply) + '</span>' : '') +
        '</div>'
      ).join('');
    } else {
      pendCard.style.display = 'none';
    }

    const pc = document.getElementById('pairingCard');
    const pb = document.getElementById('pairingBody');
    if (s.connection !== 'connected' && (s.pairing.code || s.pairing.qrDataUrl)) {
      pc.style.display = '';
      pb.innerHTML = s.pairing.code
        ? '<p>הזן בטלפון (וואטסאפ ← מכשירים מקושרים ← קישור מכשיר ← קשר באמצעות מספר טלפון):</p><span id="pairingCode">' + esc(s.pairing.code) + '</span>'
        : '<p>סרוק עם וואטסאפ בטלפון (הגדרות ← מכשירים מקושרים ← קישור מכשיר):</p><img id="qrImg" src="' + s.pairing.qrDataUrl + '" alt="QR">';
    } else {
      pc.style.display = 'none';
    }

    document.getElementById('events').innerHTML = s.events.length
      ? s.events.slice().reverse().map((e) =>
          '<div class="event">' + esc(e.text) + '<time>' + new Date(e.ts).toLocaleTimeString('he-IL') + '</time></div>'
        ).join('')
      : '<span class="muted">אין אירועים עדיין.</span>';
  } catch (err) { /* השרת ירד? ננסה שוב בסבב הבא */ }
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

/**
 * מפעיל את הדשבורד. hooks:
 *   getState(): {connection, botActive, pairing, config, events}
 *   setActive(bool)
 */
function start(hooks) {
  if (!config.dashboardEnabled) return null;

  let host = config.dashboardHost;
  const isLoopback = host === '127.0.0.1' || host === 'localhost';
  if (!isLoopback && !config.dashboardPassword) {
    console.warn('⚠️ DASHBOARD_HOST חיצוני ללא DASHBOARD_PASSWORD — נכפה האזנה מקומית (127.0.0.1) מטעמי אבטחה.');
    host = '127.0.0.1';
  }

  const app = express();
  app.use(express.json());

  // Basic Auth — נאכף כשמוגדרת סיסמה (שם משתמש: admin)
  app.use((req, res, next) => {
    if (!config.dashboardPassword) return next();
    const expected = 'Basic ' + Buffer.from(`admin:${config.dashboardPassword}`).toString('base64');
    if (safeEqual(req.headers.authorization || '', expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="whatsapp-bot"');
    res.status(401).send('Authentication required');
  });

  app.get('/', (req, res) => res.type('html').send(PAGE));
  app.get('/api/state', (req, res) => res.json(hooks.getState()));
  app.post('/api/active', (req, res) => {
    hooks.setActive(Boolean(req.body && req.body.active));
    res.json({ ok: true });
  });

  const server = app.listen(config.dashboardPort, host, () => {
    console.log(`📊 דשבורד זמין בכתובת: http://${host}:${config.dashboardPort}`);
    if (!config.dashboardPassword) {
      console.log('   (ללא סיסמה — נגיש מקומית בלבד. להרחבה לאינטרנט ראה README)');
    }
  });
  return server;
}

module.exports = { start };
