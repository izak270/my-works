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

/**
 * מעביר את ההודעה לסוכן ומחזיר את תגובתו.
 * מחזיר null אם הסוכן נכשל — ואז הבוט פשוט לא עונה (עדיף שקט מתגובה שגויה).
 */
async function processWithAgent(text, chatId) {
  // מצב בדיקה — תגובה קבועה, בלי LLM.
  if (!hasApiKey) {
    return config.testReply;
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
      messages: history,
    });

    const reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!reply) {
      // לא התקבל טקסט (למשל refusal) — לא שולחים כלום.
      history.pop();
      return null;
    }

    history.push({ role: 'assistant', content: reply });
    trimHistory(history);
    return reply;
  } catch (error) {
    // מסירים את ההודעה שלא נענתה כדי שההיסטוריה תישאר עקבית.
    history.pop();
    console.error('[agent] שגיאה מול ה-LLM:', error.message);
    return null;
  }
}

module.exports = { processWithAgent };
