import { GoogleGenAI } from '@google/genai';
import { CSV_TOOL_DECLARATIONS } from './csvTools';

// New Gen AI SDK client (uses the v1 Gemini API under the hood).
// NOTE: This runs in the browser; REACT_APP_GEMINI_API_KEY is baked in at build time.
const genAI = new GoogleGenAI({ apiKey: process.env.REACT_APP_GEMINI_API_KEY || '' });

// Use a current Gemini model that is available on the v1 API.
// If this stops working, check the Gemini docs for the latest 2.x model name.
const MODEL = 'gemini-2.5-flash';

export const CODE_KEYWORDS =
  /\b(plot|chart|graph|analyz|statistic|regression|correlat|histogram|visualiz|calculat|compute|run code|write code|execute|pandas|numpy|matplotlib|csv|data)\b/i;

let cachedPrompt = null;

async function loadSystemPrompt() {
  if (cachedPrompt) return cachedPrompt;
  try {
    const res = await fetch('/prompt_chat.txt');
    cachedPrompt = res.ok ? (await res.text()).trim() : '';
  } catch {
    cachedPrompt = '';
  }
  return cachedPrompt;
}

// Yields:
//   { type: 'text', text }           — single text chunk for the whole response
//   (code execution + search grounding are not wired up in this minimal v1 migration)
//
// The generator shape matches the old interface so Chat.js can stay unchanged.
export const streamChat = async function* (history, newMessage, imageParts = [], useCodeExecution = false) {
  const systemInstruction = await loadSystemPrompt();

  // Build conversation history as an array of Content objects.
  const contents = [];

  if (systemInstruction) {
    contents.push({
      role: 'user',
      parts: [
        {
          text: `Follow these instructions in every response:\n\n${systemInstruction}`,
        },
      ],
    });
    contents.push({
      role: 'model',
      parts: [{ text: "Got it! I'll follow those instructions." }],
    });
  }

  history.forEach((m) => {
    contents.push({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content || '' }],
    });
  });

  const finalParts = [
    { text: newMessage },
    ...imageParts.map((img) => ({
      type: 'image',
      data: img.data,
      mime_type: img.mimeType || 'image/png',
    })),
  ];

  contents.push({
    role: 'user',
    parts: finalParts,
  });

  const response = await genAI.models.generateContent({
    model: MODEL,
    contents,
  });

  const text = response.text ?? '';
  if (text) {
    yield { type: 'text', text };
  }
};

// ── Minimal CSV chat (no client-side tools in this migration) ─────────────────
// Keeps the same return shape but just calls the model once with CSV context.
export const chatWithCsvTools = async (history, newMessage, csvHeaders, executeFn) => {
  const systemInstruction = await loadSystemPrompt();

  const contents = [];

  if (systemInstruction) {
    contents.push({
      role: 'user',
      parts: [
        {
          text: `Follow these instructions in every response:\n\n${systemInstruction}`,
        },
      ],
    });
    contents.push({
      role: 'model',
      parts: [{ text: "Got it! I'll follow those instructions." }],
    });
  }

  history.forEach((m) => {
    contents.push({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content || '' }],
    });
  });

  const msgWithContext = csvHeaders?.length
    ? `[CSV columns: ${csvHeaders.join(', ')}]\n\n${newMessage}`
    : newMessage;

  contents.push({
    role: 'user',
    parts: [{ text: msgWithContext }],
  });

  const response = await genAI.models.generateContent({
    model: MODEL,
    contents,
  });

  return { text: response.text ?? '', charts: [], toolCalls: [] };
};

