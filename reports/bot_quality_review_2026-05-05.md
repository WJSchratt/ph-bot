# Bot Quality Review — 2026-05-05

## Jeremiah's Complaints (verbatim)

1. "The response tends to be the exact same no matter what the initial response is. It's just, Hey, X, Y, and Z, just Frank here. I appreciate you reaching out."
2. "Someone saying 'how are you' and it's like 'I'm not sure I follow. How do you mean?'"
3. "At this point it's not even like word tracks. It's just not sounding human."

---

## Root Cause Analysis

### Issue 1 — Templated opener "appreciate you reaching out"

**Where it came from:** The `NO CONTEXT HANDLING` fallback in `standard.js` included:
> `"hey [firstName], just [botName] here - appreciate you reaching out"`

Claude was falling through to this fallback too broadly — using it as a default opener even when GHL drip history existed and the bot should have been joining mid-conversation. The phrase "appreciate you reaching out" is formal, corporate-sounding, and totally at odds with the word-track voice.

**Fix applied:** 
- Added `"appreciate you reaching out"` to BANNED WORDS AND PHRASES
- Rewrote the FIRST REPLY section to be context-driven instead of template-driven
- Removed the automatic "appreciate you reaching out" phrase from the NO CONTEXT HANDLING fallback
- Added example openers that match the natural voice: `"hey [firstName], yeah — so [response]"` / `"hey, thanks for getting back — yeah so..."`

### Issue 2 — "How are you" → "I'm not sure I follow"

**Where it came from:** The `VAGUE / SINGLE-WORD ANSWER RULE` told the bot to respond to any low-signal message with "not sure i follow - how do you mean?" The bot was applying this to social openers like "how are you", "what's up", etc., which are NOT vague answers to a coverage question.

**Fix applied:**
- Added a new `SOCIAL PLEASANTRIES` rule that fires BEFORE the vague-answer rule
- Explicitly calls out "how are you", "what's up", "hey", "good morning" etc.
- Specifies: brief natural response ("doing well, thanks!"), then continue to next step
- Added explicit anti-example: "Do NOT say 'not sure i follow' to 'how are you.'"

### Issue 3 — AI-sounding language, not like word tracks

**Root cause:** Claude deviates from the exact word tracks in the prompt and paraphrases them into more formal, AI-assistant phrasing. The prompt had the right content but not strong enough guidance on HOW to sound.

**Fix applied:**
- Added a `SOUND HUMAN` section to the TONE block with specific bad/good examples
- Expanded BANNED WORDS to include: "appreciate your patience", "I understand your concern", "let me help you with that", "great question", "excellent choice", "I appreciate you", "feel free to reach out", "happy to help", "certainly, I'd be happy to", "absolutely"
- Explicitly instructs: "Use the word tracks in this prompt LITERALLY when they fit — don't paraphrase them into formal language"

---

## Files Changed

- `src/prompts/standard.js` — all three fixes above (3 edits, ~25 lines added/modified)
- Note: the `app_settings` DB override is checked first (30s cache). If a QC-applied prompt override exists in DB, it takes precedence over `standard.js`. The changes here update the FILE baseline. If DB override exists, it will need to be re-applied via QC apply-pending to pick up these changes.

---

## Live Conversation Pull — Could Not Run (no DB access from local)

To pull the last 100 conversations with 2+ user replies and evaluate worst-20:

```sql
SELECT c.id, c.contact_id, c.first_name, c.last_name, c.phone,
       c.terminal_outcome, c.last_message_at,
       jsonb_array_length(c.messages) as msg_count
FROM conversations c
WHERE c.is_sandbox = FALSE
  AND (SELECT COUNT(*) FROM messages m 
       WHERE m.conversation_id = c.id AND m.direction = 'inbound') >= 2
ORDER BY c.last_message_at DESC
LIMIT 100;
```

The QC Portal now has working Approve/Mark Failed/Save & Train buttons (fixed in this session). Jeremiah can use those to flag worst conversations going forward.

---

## Prompt Changes Deployed

Committed and pushed. Railway auto-deploy triggered. Prompt takes effect immediately for new conversations (30s cache TTL in prompts/index.js).
