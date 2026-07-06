// הסוכן (האורקסטרטור) — מקבל טקסט של הודעה נכנסת ומחזיר החלטה.
// תומך בשני ספקים: Gemini (Google) ו-Claude (Anthropic), ומצב בדיקה ללא מפתח.
const config = require('./config');

// ניתוב fetch דרך פרוקסי יוצא (נדרש בסביבות ענן מסוימות עבור קריאות Gemini).
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) {
  try {
    const { setGlobalDispatcher, ProxyAgent } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (err) {
    console.warn('[agent] undici לא זמין — קריאות Gemini ינסו חיבור ישיר:', err.message);
  }
}

// ===== בחירת ספק =====
const geminiKey =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GENAI_API_KEY ||
  process.env.GOOGLE_GEMINI_API_KEY ||
  '';
const anthropicKey = process.env.ANTHROPIC_API_KEY || '';

let provider;
if (config.provider === 'gemini') provider = geminiKey ? 'gemini' : 'test';
else if (config.provider === 'anthropic') provider = anthropicKey ? 'anthropic' : 'test';
else provider = geminiKey ? 'gemini' : anthropicKey ? 'anthropic' : 'test';

let anthropic = null;
if (provider === 'anthropic') {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic();
}

console.log(`🧠 ספק ה-LLM: ${provider}${provider === 'gemini' ? ' (' + config.geminiModel + ')' : provider === 'anthropic' ? ' (' + config.model + ')' : ' — תגובה קבועה'}`);
if (provider === 'test') {
  console.warn('⚠️ לא נמצא מפתח API (Gemini/Anthropic) — הסוכן רץ במצב בדיקה.');
}

// היסטוריית שיחה לכל צ'אט (chatId -> מערך {role:'user'|'assistant', content}).
const histories = new Map();
function getHistory(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId);
}
function trimHistory(history) {
  const maxMessages = config.historyTurns * 2;
  if (history.length > maxMessages) history.splice(0, history.length - maxMessages);
}

// היוריסטיקה למצב בדיקה: האם ההודעה נראית קשורה לביטוח?
function looksLikeInsurance(text) {
  const lower = text.toLowerCase();
  return config.insuranceKeywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// ===== הגדרת הכלי escalate_to_owner לכל ספק =====
const ESCALATE_DESC =
  'העבר את הפנייה לאישור בעל החשבון במקום לענות ישירות. חובה לקרוא לכלי בכל אחד מהמקרים: ' +
  '(1) ההודעה אינה עוסקת בביטוח; (2) אינך בטוח בתשובה; ' +
  '(3) הפנייה דורשת התחייבות, מחיר סופי, פרט אישי, או החלטה בשם בעל החשבון.';

const ANTHROPIC_ESCALATE_TOOL = {
  name: 'escalate_to_owner',
  description: ESCALATE_DESC,
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'סיבה קצרה מדוע נדרש אישור.' },
      suggested_reply: { type: 'string', description: 'הצעת תשובה לאישור/עריכה (אופציונלי).' },
    },
    required: ['reason'],
  },
};

const GEMINI_ESCALATE_TOOL = {
  name: 'escalate_to_owner',
  description: ESCALATE_DESC,
  parameters: {
    type: 'OBJECT',
    properties: {
      reason: { type: 'STRING', description: 'סיבה קצרה מדוע נדרש אישור.' },
      suggested_reply: { type: 'STRING', description: 'הצעת תשובה לאישור/עריכה (אופציונלי).' },
    },
    required: ['reason'],
  },
};

// ===== קריאות ספק — כל אחת מחזירה { escalate?, text? } =====

async function callAnthropic(history, system, useTool) {
  const response = await anthropic.messages.create({
    model: config.model,
    max_tokens: config.maxTokens,
    thinking: { type: 'adaptive' },
    system,
    ...(useTool ? { tools: [ANTHROPIC_ESCALATE_TOOL] } : {}),
    messages: history,
  });
  const toolUse = response.content.find(
    (b) => b.type === 'tool_use' && b.name === 'escalate_to_owner'
  );
  if (toolUse) {
    return { escalate: { reason: toolUse.input && toolUse.input.reason, suggestedReply: toolUse.input && toolUse.input.suggested_reply } };
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { text };
}

async function callGemini(history, system, useTool) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${geminiKey}`;
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: config.maxTokens },
  };
  if (useTool) body.tools = [{ function_declarations: [GEMINI_ESCALATE_TOOL] }];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];

  const fc = parts.find((p) => p.functionCall && p.functionCall.name === 'escalate_to_owner');
  if (fc) {
    const args = fc.functionCall.args || {};
    return { escalate: { reason: args.reason, suggestedReply: args.suggested_reply } };
  }
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
  return { text };
}

/**
 * מחזיר החלטה:
 *   { type: 'reply', text }                       — לענות ישירות
 *   { type: 'escalate', reason, suggestedReply }  — להעביר לאישור בעל החשבון
 *   null                                          — כשל / אין תגובה (הבוט שותק)
 */
async function processWithAgent(text, chatId) {
  // מצב בדיקה — בלי LLM.
  if (provider === 'test') {
    if (!config.insuranceOnly || looksLikeInsurance(text)) {
      return { type: 'reply', text: config.testReply };
    }
    return { type: 'escalate', reason: 'מצב בדיקה: לא זוהה נושא ביטוח', suggestedReply: null };
  }

  const system = config.insuranceOnly ? config.systemPrompt : config.generalSystemPrompt;
  const useTool = config.insuranceOnly; // כלי ההעברה רלוונטי רק במצב ביטוח-בלבד

  const history = getHistory(chatId);
  history.push({ role: 'user', content: text });
  trimHistory(history);

  try {
    const result = provider === 'gemini'
      ? await callGemini(history, system, useTool)
      : await callAnthropic(history, system, useTool);

    if (result.escalate) {
      history.pop(); // לא מנציחים פנייה שלא נענתה
      return {
        type: 'escalate',
        reason: result.escalate.reason || 'נדרש אישור בעל החשבון',
        suggestedReply: result.escalate.suggestedReply || null,
      };
    }

    if (!result.text) {
      history.pop();
      return null;
    }

    history.push({ role: 'assistant', content: result.text });
    trimHistory(history);
    return { type: 'reply', text: result.text };
  } catch (error) {
    history.pop();
    console.error('[agent] שגיאה מול ה-LLM:', error.message);
    return null;
  }
}

module.exports = { processWithAgent, provider };
