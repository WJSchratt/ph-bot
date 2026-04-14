const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('../prompts');

const MODEL = 'claude-sonnet-4-20250514';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch {}
  }
  return null;
}

function normalizeResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      messages: ["sorry, hit a snag on my end - one sec"],
      collected_data: {},
      terminal_outcome: null,
      message_type: 'general'
    };
  }
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages.filter((m) => typeof m === 'string' && m.trim()).slice(0, 2)
    : [];
  if (!messages.length) {
    messages.push("ok - let me get back to you in a moment");
  }
  return {
    messages: messages.map((m) => m.slice(0, 320)),
    collected_data: (parsed.collected_data && typeof parsed.collected_data === 'object') ? parsed.collected_data : {},
    terminal_outcome: parsed.terminal_outcome || null,
    message_type: parsed.message_type || 'general'
  };
}

async function generateResponse(conversation, history, newUserMessage) {
  const system = buildSystemPrompt(conversation);

  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: newUserMessage }
  ];

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } }
    ],
    messages
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const rawText = textBlock ? textBlock.text : '';
  const parsed = extractJson(rawText);
  const normalized = normalizeResponse(parsed);

  return { ...normalized, rawAssistantContent: rawText };
}

module.exports = { generateResponse };
