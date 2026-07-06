// הסוכן (האורקסטרטור) — מקבל טקסט של הודעה נכנסת ומחזיר תגובה מה-LLM.
// משתמש ב-Claude API דרך ה-SDK הרשמי. המפתח נלקח מ-ANTHROPIC_API_KEY.
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

// מצב בדיקה: כשאין מפתח API, הסוכן מחזיר תגובה קבועה במקום לקרוא ל-LLM —
// שימושי לבדיקת כל הצנרת (צימוד, סינונים, חיווי, שליחה) לפני חיבור המודל.
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
const anthropic = hasApiKey ? new Anthropic() : null;

if (!hasApiKey) {
  console.warn('⚠️ ANTHROPIC_API_KEY לא מוגדר — הסוכן רץ במצב בדיקה ויחזיר תגובה קבועה.');
}

// היסטוריית שיחה לכל צ'אט (chatId -> מערך הודעות), כדי שהסוכן יזכור הקשר.
const histories = new Map();

function getHistory(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId);
}

function trimHistory(history) {
  // שומרים רק את N התורות האחרונות כדי לא לנפח את הבקשה.
  const maxMessages = config.historyTurns * 2; // כל תור = user + assistant
  if (history.length > maxMessages) {
    history.splice(0, history.length - maxMessages);
  }
}

// הכלי שמאפשר למודל להעביר פנייה לאישור בעל החשבון במקום לענות בעצמו.
const ESCALATE_TOOL = {
  name: 'escalate_to_owner',
  description:
    'העבר את הפנייה לאישור בעל החשבון במקום לענות ישירות. חובה לקרוא לכלי הזה בכל אחד מהמקרים: ' +
    '(1) ההודעה אינה עוסקת בביטוח; (2) אינך בטוח בתשובה; ' +
    '(3) הפנייה דורשת התחייבות, מחיר סופי, פרט אישי, או החלטה בשם בעל החשבון.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'סיבה קצרה מדוע נדרש אישור (למשל: לא נושא ביטוח / חוסר ודאות / דורש התחייבות).',
      },
      suggested_reply: {
        type: 'string',
        description: 'הצעת תשובה שבעל החשבון יוכל לאשר או לערוך (אופציונלי).',
      },
    },
    required: ['reason'],
  },
};

// היוריסטיקה למצב בדיקה: האם ההודעה נראית קשורה לביטוח?
function looksLikeInsurance(text) {
  const lower = text.toLowerCase();
  return config.insuranceKeywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * מעביר את ההודעה לסוכן ומחזיר החלטה:
 *   { type: 'reply', text }                       — לענות ישירות (נושא ביטוח, בטוח)
 *   { type: 'escalate', reason, suggestedReply }  — להעביר לאישור בעל החשבון
 *   null                                          — כשל / אין תגובה (הבוט שותק)
 */
async function processWithAgent(text, chatId) {
  // מצב בדיקה — בלי LLM: מזהים נושא ביטוח לפי מילות מפתח, אחרת מעבירים לאישור.
  if (!hasApiKey) {
    if (looksLikeInsurance(text)) {
      return { type: 'reply', text: config.testReply };
    }
    return { type: 'escalate', reason: 'מצב בדיקה: לא זוהה נושא ביטוח', suggestedReply: null };
  }

  const history = getHistory(chatId);
  history.push({ role: 'user', content: text });
  trimHistory(history);

  try {
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      thinking: { type: 'adaptive' },
      system: config.systemPrompt,
      tools: [ESCALATE_TOOL],
      messages: history,
    });

    // אם המודל בחר להעביר לאישור — לא שומרים תשובה בהיסטוריה.
    const toolUse = response.content.find(
      (block) => block.type === 'tool_use' && block.name === 'escalate_to_owner'
    );
    if (toolUse) {
      history.pop(); // לא מנציחים פנייה שלא נענתה
      return {
        type: 'escalate',
        reason: (toolUse.input && toolUse.input.reason) || 'נדרש אישור בעל החשבון',
        suggestedReply: (toolUse.input && toolUse.input.suggested_reply) || null,
      };
    }

    const reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!reply) {
      history.pop();
      return null;
    }

    history.push({ role: 'assistant', content: reply });
    trimHistory(history);
    return { type: 'reply', text: reply };
  } catch (error) {
    history.pop();
    console.error('[agent] שגיאה מול ה-LLM:', error.message);
    return null;
  }
}

module.exports = { processWithAgent };
