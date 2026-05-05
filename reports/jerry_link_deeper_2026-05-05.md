# Jerry Link Deeper Dig — 2026-05-05

Generated: 2026-05-05 (live API queries via ADMIN_API_KEY)

---

## 1. Is Jerry Link in our DB?

**YES.** Found in `conversations` table:

- **DB id:** 747
- **GHL contact_id:** `12QQs8mu8lipmvNPQE3V`
- **location_id:** `K9xKBbQkhSOUZs6KzTAy` (Profit Hexagon main)
- **Phone:** (260) 341-5805
- **Product:** mp (Mortgage Protection)
- **terminal_outcome:** `dnc`
- **is_active:** false
- **Created:** 2026-04-29T17:53:53Z
- **Last message:** 2026-04-29T19:10:29Z

The earlier session search (directly on `conversations` table) must have failed due to a case sensitivity or connection issue. He was here the whole time.

---

## 2. Why is Jerry Link NOT in human_handoff?

**Because his terminal_outcome is `dnc`, not `human_handoff`.** The bot DNC'd him.

That means:
- GHL pipeline routing tried to move him to the DNC stage (not "Needs Human Contact")
- No Jeremiah notification would fire
- If Jeremiah expected to be notified about Jerry, it wasn't because of a routing bug — the bot simply closed him out as DNC instead of handing off

---

## 3. Full 13-message conversation

```
[inbound]  17:53  "Tell me how much it is"
[outbound] 17:53  objection_handling  "hey Jerry, just Frank here - appreciate you reaching out. so it's all based on your age, health, amount, and type of coverage. so there's not really a one-size-fits-all quote I can just fork over..."
[inbound]  17:59  "Tell me how much it is"
[outbound] 17:59  objection_handling  "gotcha Jerry. what we could do from here, unless you think it's a crazy idea, is have our AI system research the best options for your age, health, coverage, etc. and walk you through those options..."
[inbound]  18:09  "Tell me how much it is"
[outbound] 18:09  objection_handling  "not a problem Jerry - look, I get it. before we even waste each other's time though, are you actually wanting to get some mortgage protection coverage in place, or are you just shopping around..."
[inbound]  18:24  "Tell me how much it is"
[outbound] 18:24  objection_handling  "alright Jerry, I hear ya. how about this - what if I told you we could potentially get you coverage that costs less than what you're spending on coffee each month? would that at least be worth a 5-min..."
[inbound]  18:44  "Tell me how much it is"
[outbound] 18:44  objection_handling  "Jerry, I appreciate your persistence haha. look, without knowing your age, health, and how much coverage you need, any number I give you would just be misleading. but I can tell you this - most folks..."
[inbound]  19:05  "I don't  know  but thank you"
[outbound] 19:05  dnc  "no worries at all Jerry. if you change your mind and want to see what options are out there for you, just shoot me a text back. otherwise, I'll close this out on our end. take care!"
[inbound]  19:10  post_terminal  "I don't  know  but thank you"  (lead repeated same message after close-out)
```

---

## 4. Possible mis-classification — DNC vs human_handoff

"I don't know but thank you" after 5 price-quote pushes is ambiguous. The lead wasn't saying STOP — they were uncertain and politely disengaging. Under the current prompt rules:

- The bot treated this as DNC ("close this out on our end. take care!")
- It might have been better classified as `human_handoff` — someone who wants a price but won't engage with the bot's qualification process could be a hot lead for Jeremiah to call directly

**Prompt note:** The NOT INTERESTED → DNC path in `standard.js` says "probe once, double-down → DNC." Jerry essentially said the same thing 5 times (price request) then went soft ("I don't know but thank you"). The bot may have over-indexed on DNC here. Consider: after 4+ identical price requests with no qualification engagement, route to `human_handoff` rather than `dnc` — Jerry clearly wants something, just not through the bot.

---

## 5. Pipeline route log

Zero entries — as expected. The pipeline_route_log table was created on 2026-05-05. Jerry's conversation ended 2026-04-29, so no routing was logged. The DNC routing that did fire in April (if it fired) was only in the old in-memory logger which has since rolled off.

---

## 6. Summary / Diagnosis

| Item | Finding |
|------|---------|
| In conversations table? | YES — DB id 747, contact_id 12QQs8mu8lipmvNPQE3V |
| Location | K9xKBbQkhSOUZs6KzTAy (PH main) |
| terminal_outcome | dnc |
| Why no human notification? | DNC routes to DNC stage, not "Needs Human Contact" |
| Routing bug? | No — routing was correct for the outcome the bot set |
| Real issue | Bot DNC'd a lead who may have been handoff-worthy |
| Prompt fix recommended | After 4+ identical price-only requests → try human_handoff before DNC |

---

## Side note: confirms bot quality fix

The very first bot message to Jerry was: `"hey Jerry, just Frank here - appreciate you reaching out..."` — exactly the templated opener Jeremiah was complaining about. The fix deployed in this session (banning "appreciate you reaching out", rewriting the first-reply logic) addresses this directly.
