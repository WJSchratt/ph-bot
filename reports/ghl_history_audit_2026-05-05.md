# GHL Conversation History Accuracy Audit
**Date:** 2026-05-05
**Scope:** Last 50 contacts Claude bot responded to

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| Contacts audited | 50 |
| Skipped (no GHL conv / no token / API error) | 2 |
| Successfully compared | 48 |
| **Clean (no issues)** | **0** |
| **Mismatched (>=1 issue)** | **48** |
| Count mismatches | 37 |
| Missing-in-stored (live > DB) | 37 |
| Extra-in-stored (DB > live) | 0 |
| Message order differs | 37 |
| Content mismatches | 0 |
| Direction/attribution mismatches | 0 |
| JSONB vs live GHL misalignment | 48 |

**Accuracy rate:** 0.0% of audited contacts have perfectly matching stored history.

---

## Skipped Contacts (2)

- **Z3Z8MlpfCV1efynEJUBs** (dkns3r9eHE3MZ3pgJ7qK) — No ghl_conversations row found — GHL pull has never run or conversation not yet synced
- **vyFutT8mhjAj6dYBfj76** (dkns3r9eHE3MZ3pgJ7qK) — No ghl_conversations row found — GHL pull has never run or conversation not yet synced

---

## Mismatched Contacts (48)

### Johnnie Lee — `VdJfAIP2eDnENtTlVCIR`

- **Location:** Veronica Quintanilla (`Nb8CYlsFaRFQchJBOvo1`)
- **GHL Conversation ID:** `hN1ZQNrh42QftXt0ULQT`
- **Last message at:** 2026-05-04 14:31
- **Stored (ghl_messages):** 6 | **Live GHL:** 11 | **JSONB turns:** 6

#### Issue: `count_mismatch`

> stored=6 vs live=11 (delta=5)

#### Issue: `missing_in_stored`

> 5 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "JpTUtPC3bD5XWWY0qjQa",
    "direction": "outbound",
    "content": "Hey Johnnie, just  here. Tried to reach you a few times… \n\nNot sure if it's stil",
    "ts": "2026-05-04T13:11:04.786Z"
  },
  {
    "id": "IMaAQCXOU39cVFmJdF4q",
    "direction": "inbound",
    "content": "Not at the moment thanks.",
    "ts": "2026-05-04T13:56:53.836Z"
  },
  {
    "id": "tSZBP6eHYvULQKxYRrZg",
    "direction": "outbound",
    "content": "apologies Johnnie, didn't mean to confuse you! looks like someone from our team ",
    "ts": "2026-05-04T13:56:59.508Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oooooo" live="oooooooiooo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 3 user turns, live GHL has 1 inbound messages
> JSONB has 3 assistant turns, live GHL has 10 outbound messages

### William Meyer — `nrfBR573qYThOQEsW1ZM`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `XiqAcv6Pd4Mo7YxPOgnK`
- **Last message at:** 2026-05-02 23:29
- **Stored (ghl_messages):** 2 | **Live GHL:** 21 | **JSONB turns:** 26

#### Issue: `count_mismatch`

> stored=2 vs live=21 (delta=19)

#### Issue: `missing_in_stored`

> 19 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "euJfbiaJUYAeRb0hJpyv",
    "direction": "outbound",
    "content": "Hey William, just got off the phone with someone who was overpaying for their mo",
    "ts": "2026-04-23T16:21:07.908Z"
  },
  {
    "id": "ihinziwDJTqXN5PomYi9",
    "direction": "outbound",
    "content": "William?",
    "ts": "2026-04-24T16:21:10.734Z"
  },
  {
    "id": "N4rEq5UzFPB9csUERKQe",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-05-02T16:21:13.353Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="oooooioooooioooooiooo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 13 user turns, live GHL has 3 inbound messages
> JSONB has 13 assistant turns, live GHL has 18 outbound messages

### Lucas Niesen — `mi9HNjhOAFshSHTrX0XK`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `8Z4GcSB7ytxeQyR0sLk0`
- **Last message at:** 2026-05-02 23:18
- **Stored (ghl_messages):** 3 | **Live GHL:** 11 | **JSONB turns:** 6

#### Issue: `count_mismatch`

> stored=3 vs live=11 (delta=8)

#### Issue: `missing_in_stored`

> 8 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "U2Wmv3l12GDPc8FLoMhr",
    "direction": "outbound",
    "content": "Hey Lucas, just got off the phone with someone who was overpaying for their mort",
    "ts": "2026-04-23T20:47:11.483Z"
  },
  {
    "id": "K16l5sj6vgz2Bb9zTgrP",
    "direction": "outbound",
    "content": "Lucas?",
    "ts": "2026-04-24T20:47:14.573Z"
  },
  {
    "id": "TCyhaaS8v0Y8hD526EGn",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-05-02T20:47:16.799Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooo" live="ooooooioioo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 3 user turns, live GHL has 2 inbound messages
> JSONB has 3 assistant turns, live GHL has 9 outbound messages

### Stephon Frounfelter — `mrpvrk8Z0D1Q4B5PCYMv`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `ifVri01fJWswkepbEANF`
- **Last message at:** 2026-05-02 22:31
- **Stored (ghl_messages):** 3 | **Live GHL:** 13 | **JSONB turns:** 10

#### Issue: `count_mismatch`

> stored=3 vs live=13 (delta=10)

#### Issue: `missing_in_stored`

> 10 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "5yazzPDYGXwr7zcfBPNq",
    "direction": "outbound",
    "content": "Hey Stephon, just got off the phone with someone who was overpaying for their mo",
    "ts": "2026-04-23T18:13:08.433Z"
  },
  {
    "id": "RoGKh7pyHSfRyq0ivfN2",
    "direction": "outbound",
    "content": "Stephon?",
    "ts": "2026-04-24T18:19:23.089Z"
  },
  {
    "id": "Vl5kJGzaXI5EIfaGBXK5",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-05-02T18:19:26.938Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooo" live="ooooooiooiooo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 5 user turns, live GHL has 2 inbound messages
> JSONB has 5 assistant turns, live GHL has 11 outbound messages

### Sam Riddle — `nraTmXHrInTLRzQIP97b`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `y5pJw5EeADkJmSTL5YTC`
- **Last message at:** 2026-05-02 21:45
- **Stored (ghl_messages):** 2 | **Live GHL:** 11 | **JSONB turns:** 10

#### Issue: `count_mismatch`

> stored=2 vs live=11 (delta=9)

#### Issue: `missing_in_stored`

> 9 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "krWKlpFUcsBWdhg5yJ7o",
    "direction": "outbound",
    "content": "Hey Sam, just got off the phone with someone who was overpaying for their mortga",
    "ts": "2026-04-23T20:54:09.004Z"
  },
  {
    "id": "qNcRxVx4NNOhjXmeg7Rh",
    "direction": "outbound",
    "content": "Sam?",
    "ts": "2026-04-24T20:54:12.587Z"
  },
  {
    "id": "Njqk0W2VJuAXRfgR2rUf",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-05-02T20:54:15.080Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="oooooiooooo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 5 user turns, live GHL has 1 inbound messages
> JSONB has 5 assistant turns, live GHL has 10 outbound messages

### Craig Christensen — `JEIMqkYHw3kc422EfF25`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `u8d7vbcnMoZJcYvOhQoF`
- **Last message at:** 2026-05-02 16:52
- **Stored (ghl_messages):** 2 | **Live GHL:** 11 | **JSONB turns:** 10

#### Issue: `count_mismatch`

> stored=2 vs live=11 (delta=9)

#### Issue: `missing_in_stored`

> 9 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "utbD19Kt4d591msBwRTq",
    "direction": "outbound",
    "content": "Hey Craig, just got off the phone with someone who was overpaying for their mort",
    "ts": "2026-04-23T00:23:20.429Z"
  },
  {
    "id": "Ybd9U38qYmpRarQzPfMP",
    "direction": "outbound",
    "content": "Craig?",
    "ts": "2026-04-24T00:23:22.880Z"
  },
  {
    "id": "SkcfM3L65TEWBEoPdaeu",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-05-02T00:23:25.353Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="oooooiooooo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 5 user turns, live GHL has 1 inbound messages
> JSONB has 5 assistant turns, live GHL has 10 outbound messages

### Jason Hansen — `rFhMaEWgCOuexBMHi5iZ`

- **Location:** Veronica Quintanilla (`Nb8CYlsFaRFQchJBOvo1`)
- **GHL Conversation ID:** `JsODGUeXE0a8eT3OnkCR`
- **Last message at:** 2026-05-02 16:13
- **Stored (ghl_messages):** 5 | **Live GHL:** 9 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=5 vs live=9 (delta=4)

#### Issue: `missing_in_stored`

> 4 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "RTKSJB6R5v8AGO6GRQql",
    "direction": "outbound",
    "content": "Hey Jason, I just spoke with someone who'd been putting off getting coverage... ",
    "ts": "2026-05-02T16:07:37.636Z"
  },
  {
    "id": "WpxksduFExh1i7SG3Txu",
    "direction": "outbound",
    "content": "What's the plan when something happens in your family?",
    "ts": "2026-05-02T16:07:38.658Z"
  },
  {
    "id": "gql79ky3KifYj5kbVFMj",
    "direction": "outbound",
    "content": "You have successfully opted out from messaging. No future messages will be sent.",
    "ts": "2026-05-02T16:08:17.517Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooooo" live="ooooooooi"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 8 outbound messages

### Rebecca Balser — `yA0iwSe0EvmWtZfjDwL7`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `7JG5EDtzAGQtRPByCPMz`
- **Last message at:** 2026-05-01 19:38
- **Stored (ghl_messages):** 3 | **Live GHL:** 12 | **JSONB turns:** 10

#### Issue: `count_mismatch`

> stored=3 vs live=12 (delta=9)

#### Issue: `missing_in_stored`

> 9 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "EF9D2Zp0oJlAq3AmlGwQ",
    "direction": "outbound",
    "content": "Hey Rebecca, just got off the phone with someone who was overpaying for their mo",
    "ts": "2026-04-21T00:28:17.102Z"
  },
  {
    "id": "Qr53JFASozAWAZAE8LpD",
    "direction": "outbound",
    "content": "Rebecca?",
    "ts": "2026-04-22T00:28:20.605Z"
  },
  {
    "id": "xP56h305YM9YMrWsp5gi",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-04-30T00:28:23.728Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooo" live="ooooooiooooo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 5 user turns, live GHL has 1 inbound messages
> JSONB has 5 assistant turns, live GHL has 11 outbound messages

### Mirna Salas — `g3n9cEHn7XFCHHkF2R0l`

- **Location:** Veronica Quintanilla (`Nb8CYlsFaRFQchJBOvo1`)
- **GHL Conversation ID:** `XUHmlgtZ9937jfzuByuI`
- **Last message at:** 2026-05-01 16:56
- **Stored (ghl_messages):** 5 | **Live GHL:** 13 | **JSONB turns:** 8

#### Issue: `count_mismatch`

> stored=5 vs live=13 (delta=8)

#### Issue: `missing_in_stored`

> 8 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "hjd91iXjxj1Q5L4MygrG",
    "direction": "outbound",
    "content": "Hey Mirna, I just spoke with someone who'd been putting off getting coverage... ",
    "ts": "2026-04-25T16:04:45.179Z"
  },
  {
    "id": "Zzqg06rToj7DL0x9Dn7P",
    "direction": "outbound",
    "content": "What's the plan when something happens in your family?",
    "ts": "2026-04-25T16:04:46.222Z"
  },
  {
    "id": "sifn8AeBzExs1XNA0qiP",
    "direction": "outbound",
    "content": "Hey Mirna, just  here. Tried to reach you a few times… \n\nNot sure if it's still ",
    "ts": "2026-05-01T16:04:53.599Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooooo" live="ooooooooioooo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 4 user turns, live GHL has 1 inbound messages
> JSONB has 4 assistant turns, live GHL has 12 outbound messages

### Donald Franklin — `3BbYv0BopWc2CfOdagsD`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `OCZY6PrbSnmcUsweLB68`
- **Last message at:** 2026-05-01 16:51
- **Stored (ghl_messages):** 5 | **Live GHL:** 50 | **JSONB turns:** 34

#### Issue: `count_mismatch`

> stored=5 vs live=50 (delta=45)

#### Issue: `missing_in_stored`

> 45 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "FW1i8wl0EFXY1IjBDqFh",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-04-20T13:09:01.402Z"
  },
  {
    "id": "mTkYUt6sUQsmfsjHt8G7",
    "direction": "outbound",
    "content": "Hey Donald, I just spoke with someone who'd been putting off getting coverage...",
    "ts": "2026-05-01T13:09:05.210Z"
  },
  {
    "id": "ltZGBltKUcBY2rPJqXWb",
    "direction": "outbound",
    "content": "What's the plan when something happens in your family?",
    "ts": "2026-05-01T13:09:06.152Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooooo" live="ooooooooiooiioooioiiiiioiiiiii"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 17 user turns, live GHL has 25 inbound messages
> JSONB has 17 assistant turns, live GHL has 25 outbound messages

### William Orth — `klhBfuWtCRUo96eGgfqI`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `AH4HZbbXRvnwjNypxF2N`
- **Last message at:** 2026-04-29 20:39
- **Stored (ghl_messages):** 3 | **Live GHL:** 18 | **JSONB turns:** 16

#### Issue: `count_mismatch`

> stored=3 vs live=18 (delta=15)

#### Issue: `missing_in_stored`

> 15 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "K631v4zuSqejwJaZvio2",
    "direction": "outbound",
    "content": "Hey William, just got off the phone with someone who was overpaying for their mo",
    "ts": "2026-04-20T19:16:09.203Z"
  },
  {
    "id": "V0Yl7Piiaty2p13DjMU3",
    "direction": "outbound",
    "content": "William?",
    "ts": "2026-04-21T19:16:11.259Z"
  },
  {
    "id": "LP9J3sRlyzfZDbwaDERr",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-04-29T19:16:13.687Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooo" live="ooooooiooooioioioo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 8 user turns, live GHL has 4 inbound messages
> JSONB has 8 assistant turns, live GHL has 14 outbound messages

### Ryan Meade — `AglezD1jJFJOeEEcBNhi`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `NhazxLEplhAqje6XDR9O`
- **Last message at:** 2026-04-29 19:49
- **Stored (ghl_messages):** 2 | **Live GHL:** 10 | **JSONB turns:** 8

#### Issue: `count_mismatch`

> stored=2 vs live=10 (delta=8)

#### Issue: `missing_in_stored`

> 8 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "BKjUnQlgxJL0hpDdwC0j",
    "direction": "outbound",
    "content": "Hey Ryan, just got off the phone with someone who was overpaying for their mortg",
    "ts": "2026-04-20T18:55:07.132Z"
  },
  {
    "id": "l1KvQWe2EwIzLzWfAsEh",
    "direction": "outbound",
    "content": "Ryan?",
    "ts": "2026-04-21T18:55:09.978Z"
  },
  {
    "id": "vu4NqYHyHIv8u6KW35ka",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-04-29T18:55:12.404Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="oooooioooo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 4 user turns, live GHL has 1 inbound messages
> JSONB has 4 assistant turns, live GHL has 9 outbound messages

### Jerry Link — `12QQs8mu8lipmvNPQE3V`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `29CJI85TzIjon65AGjZl`
- **Last message at:** 2026-04-29 19:10
- **Stored (ghl_messages):** 4 | **Live GHL:** 24 | **JSONB turns:** 12

#### Issue: `count_mismatch`

> stored=4 vs live=24 (delta=20)

#### Issue: `missing_in_stored`

> 20 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "iL0q0Yj7O0YHzTVgGXfz",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-04-18T17:51:38.901Z"
  },
  {
    "id": "WIgfy0DtrFe1GQvLGinQ",
    "direction": "outbound",
    "content": "Hey Jerry, I just spoke with someone who'd been putting off getting coverage... ",
    "ts": "2026-04-29T17:51:41.350Z"
  },
  {
    "id": "o4qXeCP06zHTuoJbLXj8",
    "direction": "outbound",
    "content": "What's the plan when something happens in your family?",
    "ts": "2026-04-29T17:51:41.853Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oooo" live="oooooooioiiiioioiioioioi"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 6 user turns, live GHL has 11 inbound messages
> JSONB has 6 assistant turns, live GHL has 13 outbound messages

### Jeffery Wasson — `STAc2g6hNX4WKur0vwEN`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `ROVUOVJFJ3i6qJWGPOSm`
- **Last message at:** 2026-04-29 14:59
- **Stored (ghl_messages):** 3 | **Live GHL:** 13 | **JSONB turns:** 10

#### Issue: `count_mismatch`

> stored=3 vs live=13 (delta=10)

#### Issue: `missing_in_stored`

> 10 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "CPCYZCxly9TtJdLTLVrW",
    "direction": "outbound",
    "content": "Hey Jeffery, just got off the phone with someone who was overpaying for their mo",
    "ts": "2026-04-20T13:07:39.923Z"
  },
  {
    "id": "DrQf7M8xnEee1dhO9hls",
    "direction": "outbound",
    "content": "Jeffery?",
    "ts": "2026-04-21T13:09:34.898Z"
  },
  {
    "id": "jFjIYIqJEBvtEpPdu59i",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-04-29T13:09:45.122Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooo" live="ooooooiooiooo"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 5 user turns, live GHL has 2 inbound messages
> JSONB has 5 assistant turns, live GHL has 11 outbound messages

### Tasheena Wigham — `LrPVbCOviSa6YsxDjJCA`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `EzZILI4BzReNnWkiTXUH`
- **Last message at:** 2026-04-29 14:57
- **Stored (ghl_messages):** 1 | **Live GHL:** 7 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=1 vs live=7 (delta=6)

#### Issue: `missing_in_stored`

> 6 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "uFB2aJe6GnXTIyaAtDFF",
    "direction": "outbound",
    "content": "Hey Tasheena, did my last text make it?",
    "ts": "2026-04-17T22:57:13.357Z"
  },
  {
    "id": "n4HrCXKFPXtHWDjGbe59",
    "direction": "outbound",
    "content": "Hey Tasheena, just got off the phone with someone who was overpaying for their m",
    "ts": "2026-04-20T13:05:40.224Z"
  },
  {
    "id": "FeocmH1SMSFCLy8dCp4Q",
    "direction": "outbound",
    "content": "Tasheena?",
    "ts": "2026-04-21T13:08:43.701Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="o" live="oooooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 6 outbound messages

### Chat Al — `lH2HN9AUAmB5H453PFuE`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `b9WO8afIPGh9l6QHpcP3`
- **Last message at:** 2026-04-26 00:10
- **Stored (ghl_messages):** 0 | **Live GHL:** 0 | **JSONB turns:** 2

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 user turns, live GHL has 0 inbound messages
> JSONB has 1 assistant turns, live GHL has 0 outbound messages

### Mark Kaiser — `8O2zLuliAUMpfcuSaUnb`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `xBCs8AHNhgbOgwRa3qTm`
- **Last message at:** 2026-04-25 15:39
- **Stored (ghl_messages):** 2 | **Live GHL:** 5 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=2 vs live=5 (delta=3)

#### Issue: `missing_in_stored`

> 3 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "3WvSy8xLAqFmNpH0vOCz",
    "direction": "outbound",
    "content": "Hey Mark, just got off the phone with someone who was overpaying for their mortg",
    "ts": "2026-04-25T13:06:22.506Z"
  },
  {
    "id": "LwJbNCdMuIOidilAPnO3",
    "direction": "outbound",
    "content": "You have successfully opted out from messaging. No future messages will be sent.",
    "ts": "2026-04-25T15:38:59.636Z"
  },
  {
    "id": "ubnjbcvCqozpFUCFl1gd",
    "direction": "inbound",
    "content": "STOP",
    "ts": "2026-04-25T15:39:00.009Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="ooooi"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 4 outbound messages

### Stephen Lowery — `pZGtUHFD1Axs8aGETWIA`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `r01chRGUrLQzeKc24sw9`
- **Last message at:** 2026-04-25 09:19
- **Stored (ghl_messages):** 2 | **Live GHL:** 6 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=2 vs live=6 (delta=4)

#### Issue: `missing_in_stored`

> 4 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "DCKUlPs3IVm0XTLAonjW",
    "direction": "outbound",
    "content": "Hey Stephen, just got off the phone with someone who was overpaying for their mo",
    "ts": "2026-04-23T22:11:07.261Z"
  },
  {
    "id": "pzXMCxxXzuuUtBgEAz0H",
    "direction": "outbound",
    "content": "Stephen?",
    "ts": "2026-04-24T22:11:10.113Z"
  },
  {
    "id": "nxFYcIrUcmpvO9p03w0z",
    "direction": "inbound",
    "content": "Who is this?",
    "ts": "2026-04-25T09:19:06.444Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="ooooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 5 outbound messages

### Eric Bakken — `oYDVLDmZbVbp1ZbcSptg`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `yhTv0sCAqB0vzUnyDXYB`
- **Last message at:** 2026-04-25 01:13
- **Stored (ghl_messages):** 2 | **Live GHL:** 8 | **JSONB turns:** 4

#### Issue: `count_mismatch`

> stored=2 vs live=8 (delta=6)

#### Issue: `missing_in_stored`

> 6 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "oD00Qhkeu8iJV7osf7HH",
    "direction": "outbound",
    "content": "Hey Eric, just got off the phone with someone who was overpaying for their mortg",
    "ts": "2026-04-23T23:28:06.598Z"
  },
  {
    "id": "7yfGPlQouhtvPnHx8gzd",
    "direction": "outbound",
    "content": "Eric?",
    "ts": "2026-04-24T23:28:09.188Z"
  },
  {
    "id": "pLMnOk7pCEszyKMahoZL",
    "direction": "inbound",
    "content": "Yeah",
    "ts": "2026-04-25T00:36:33.969Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="ooooioio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 2 assistant turns, live GHL has 6 outbound messages

### Rebekah Ragland — `ho0J2XNmUkpTc5VpdWke`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `LcltL2rpiohv8QOLgnpR`
- **Last message at:** 2026-04-24 20:53
- **Stored (ghl_messages):** 2 | **Live GHL:** 9 | **JSONB turns:** 4

#### Issue: `count_mismatch`

> stored=2 vs live=9 (delta=7)

#### Issue: `missing_in_stored`

> 7 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "e31bXoqU9RhjQgEzYu4a",
    "direction": "outbound",
    "content": "Hey Rebekah, did my last text make it?",
    "ts": "2026-04-22T19:30:43.729Z"
  },
  {
    "id": "jN3BAXK6QyfVTiwqjR2O",
    "direction": "outbound",
    "content": "Hey Rebekah, just got off the phone with someone who was overpaying for their mo",
    "ts": "2026-04-24T19:30:46.341Z"
  },
  {
    "id": "aYGtxXf4vsxhvz66sam1",
    "direction": "inbound",
    "content": "I won't be. Thanks",
    "ts": "2026-04-24T20:50:48.315Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="ooooioioi"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 2 user turns, live GHL has 3 inbound messages
> JSONB has 2 assistant turns, live GHL has 6 outbound messages

### Blanca Villalobos — `gYiQxYPSDdrVDEDuqaqS`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `lIVwP3P13hUlyotWtp0n`
- **Last message at:** 2026-04-24 20:13
- **Stored (ghl_messages):** 3 | **Live GHL:** 7 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=3 vs live=7 (delta=4)

#### Issue: `missing_in_stored`

> 4 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "dTT3McuPLEw21jkvDBtx",
    "direction": "outbound",
    "content": "Hey Blanca, just got off the phone with someone who was overpaying for their mor",
    "ts": "2026-04-23T20:12:09.621Z"
  },
  {
    "id": "fMxE2qg9eclP7hGXJprj",
    "direction": "outbound",
    "content": "Blanca?",
    "ts": "2026-04-24T20:12:12.602Z"
  },
  {
    "id": "IktsmUYqs9jGrdSjrCJo",
    "direction": "inbound",
    "content": "??",
    "ts": "2026-04-24T20:12:56.585Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooo" live="oooooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 6 outbound messages

### Jerry Huffman — `zPrkooh22hsyq1db6DYs`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `AFNsjO9fm8q1FpzYloS7`
- **Last message at:** 2026-04-24 18:59
- **Stored (ghl_messages):** 2 | **Live GHL:** 12 | **JSONB turns:** 8

#### Issue: `count_mismatch`

> stored=2 vs live=12 (delta=10)

#### Issue: `missing_in_stored`

> 10 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "9g5BjtfSFnKSHVp1DYAK",
    "direction": "outbound",
    "content": "Hey Jerry, just got off the phone with someone who was overpaying for their mort",
    "ts": "2026-04-23T18:54:21.012Z"
  },
  {
    "id": "vV7HOwsDSK7FUuQBpTo7",
    "direction": "outbound",
    "content": "Jerry?",
    "ts": "2026-04-24T18:54:23.962Z"
  },
  {
    "id": "QR02726hzJXH9Mnr6ekL",
    "direction": "inbound",
    "content": "Trying ignore you to see if you will go away",
    "ts": "2026-04-24T18:56:45.083Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="ooooioioioio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 4 assistant turns, live GHL has 8 outbound messages

### Juan Mares — `64ybUgJYANEsKnhXbF6c`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `qOoHjo5NpVXqITG9h0WV`
- **Last message at:** 2026-04-24 18:18
- **Stored (ghl_messages):** 1 | **Live GHL:** 10 | **JSONB turns:** 6

#### Issue: `count_mismatch`

> stored=1 vs live=10 (delta=9)

#### Issue: `missing_in_stored`

> 9 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "YnoTvJ2mPgBcw5zhdUOJ",
    "direction": "outbound",
    "content": "Hey Juan, did my last text make it?",
    "ts": "2026-04-22T13:06:00.316Z"
  },
  {
    "id": "vLxeI2VwbzZPHQDEKfBd",
    "direction": "outbound",
    "content": "Hey Juan, just got off the phone with someone who was overpaying for their mortg",
    "ts": "2026-04-24T13:06:52.116Z"
  },
  {
    "id": "rxFQHnT0UGgzuXnWLnDC",
    "direction": "inbound",
    "content": "This is not Juan",
    "ts": "2026-04-24T18:08:25.647Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="o" live="oooioioioi"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 3 user turns, live GHL has 4 inbound messages
> JSONB has 3 assistant turns, live GHL has 6 outbound messages

### John Lekkas — `r0WQXiOd1FNp327CND9d`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `NitQQfjssYpD7sTPC0cG`
- **Last message at:** 2026-04-24 18:18
- **Stored (ghl_messages):** 2 | **Live GHL:** 6 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=2 vs live=6 (delta=4)

#### Issue: `missing_in_stored`

> 4 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "7wR6FIVNrgr9bHFbwczC",
    "direction": "outbound",
    "content": "Hey John, just got off the phone with someone who was overpaying for their mortg",
    "ts": "2026-04-23T16:06:41.833Z"
  },
  {
    "id": "InVUBLqyvuAlQMw88bTi",
    "direction": "outbound",
    "content": "John?",
    "ts": "2026-04-24T16:06:56.464Z"
  },
  {
    "id": "Y1zdFFjHYLss1DlTywyC",
    "direction": "inbound",
    "content": "Who are you?",
    "ts": "2026-04-24T18:17:53.902Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="ooooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 5 outbound messages

### Chat Al — `yVxxAWcUNtYzNMonVzmJ`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `DD3tAoSbHDxqzTWcuruP`
- **Last message at:** 2026-04-24 16:59
- **Stored (ghl_messages):** 0 | **Live GHL:** 0 | **JSONB turns:** 2

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 user turns, live GHL has 0 inbound messages
> JSONB has 1 assistant turns, live GHL has 0 outbound messages

### Test Testing — `gwpYbs6aNPUpJ1CjuxWz`

- **Location:** Veronica Quintanilla (`Nb8CYlsFaRFQchJBOvo1`)
- **GHL Conversation ID:** `l4G4T97jauptiWCDhZpe`
- **Last message at:** 2026-04-24 16:47
- **Stored (ghl_messages):** 6 | **Live GHL:** 6 | **JSONB turns:** 4

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 2 assistant turns, live GHL has 4 outbound messages

### Enrique Reyes — `epqfHPBfyaB942dbcI22`

- **Location:** Veronica Quintanilla (`Nb8CYlsFaRFQchJBOvo1`)
- **GHL Conversation ID:** `dcT9zAIb4cz6fAqWe9ki`
- **Last message at:** 2026-04-24 16:10
- **Stored (ghl_messages):** 7 | **Live GHL:** 7 | **JSONB turns:** 2

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 6 outbound messages

### Steven Hughes — `Xgn2mYJZucwo92bZCXId`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `umyTzKFcCR3tl7L9Pxe2`
- **Last message at:** 2026-04-24 00:41
- **Stored (ghl_messages):** 2 | **Live GHL:** 9 | **JSONB turns:** 4

#### Issue: `count_mismatch`

> stored=2 vs live=9 (delta=7)

#### Issue: `missing_in_stored`

> 7 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "C2P8MDbVXfio9FMkQnqv",
    "direction": "outbound",
    "content": "Hey Steven, did my last text make it?",
    "ts": "2026-04-20T20:19:07.233Z"
  },
  {
    "id": "Nw2zkriQo3u9uJvRbTvw",
    "direction": "outbound",
    "content": "Hey Steven, just got off the phone with someone who was overpaying for their mor",
    "ts": "2026-04-22T20:19:09.898Z"
  },
  {
    "id": "IN22w6wdgiFyE20SeomB",
    "direction": "outbound",
    "content": "Steven?",
    "ts": "2026-04-23T20:19:12.063Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="oooooioio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 2 assistant turns, live GHL has 7 outbound messages

### Gary Blanton — `y9pVCKkY8f8PYBvXDeRY`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `aMPyEtNwREJ7FsaHJpbW`
- **Last message at:** 2026-04-23 22:44
- **Stored (ghl_messages):** 3 | **Live GHL:** 13 | **JSONB turns:** 8

#### Issue: `count_mismatch`

> stored=3 vs live=13 (delta=10)

#### Issue: `missing_in_stored`

> 10 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "55x1PxhoqoJgR4RU8nw2",
    "direction": "outbound",
    "content": "Hey Gary, just got off the phone with someone who was overpaying for their mortg",
    "ts": "2026-04-22T16:21:10.384Z"
  },
  {
    "id": "y8JLUCf0IPiPJCO1B7GB",
    "direction": "outbound",
    "content": "Gary?",
    "ts": "2026-04-23T16:21:13.660Z"
  },
  {
    "id": "Dau9hMapMdgpZXWudbPd",
    "direction": "inbound",
    "content": "Howdy.",
    "ts": "2026-04-23T18:33:45.766Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooo" live="oooooioioioio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 4 assistant turns, live GHL has 9 outbound messages

### William Salvey — `ddAjbwLFO9EGYaX4SPwy`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `1Uk9qzns2W1KshdAWkB9`
- **Last message at:** 2026-04-23 20:14
- **Stored (ghl_messages):** 2 | **Live GHL:** 21 | **JSONB turns:** 18

#### Issue: `count_mismatch`

> stored=2 vs live=21 (delta=19)

#### Issue: `missing_in_stored`

> 19 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "669MY548SH0TDpGvFfOq",
    "direction": "outbound",
    "content": "Hey William, just got off the phone with someone who was overpaying for their mo",
    "ts": "2026-04-23T19:38:46.978Z"
  },
  {
    "id": "elSCnXigH85Dt61c7ICE",
    "direction": "inbound",
    "content": "What's the price if u already know what I have",
    "ts": "2026-04-23T19:43:06.960Z"
  },
  {
    "id": "1YWuYGbUo3FyV1UPcAE7",
    "direction": "outbound",
    "content": "hey William, just Frank here - appreciate you reaching out. so the thing is, all",
    "ts": "2026-04-23T19:43:13.996Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="oooioioioioioioioioio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 9 assistant turns, live GHL has 12 outbound messages

### Brittany Perkins — `V871zD87xo5pcaO9oOWN`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `9nJDhxJ9lA8gUerSy8Iu`
- **Last message at:** 2026-04-23 19:35
- **Stored (ghl_messages):** 2 | **Live GHL:** 12 | **JSONB turns:** 6

#### Issue: `count_mismatch`

> stored=2 vs live=12 (delta=10)

#### Issue: `missing_in_stored`

> 10 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "SZ9Mk2HdWBWrNOPfNiHu",
    "direction": "outbound",
    "content": "Hey Brittany, did my last text make it?",
    "ts": "2026-04-20T19:16:06.754Z"
  },
  {
    "id": "tqXQpCpUMLkNAjzPSGpC",
    "direction": "outbound",
    "content": "Hey Brittany, just got off the phone with someone who was overpaying for their m",
    "ts": "2026-04-22T19:16:09.393Z"
  },
  {
    "id": "Vx50YZrMPpu6qZ76bEVG",
    "direction": "outbound",
    "content": "Brittany?",
    "ts": "2026-04-23T19:16:12.146Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="oooooioioioi"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 3 user turns, live GHL has 4 inbound messages
> JSONB has 3 assistant turns, live GHL has 8 outbound messages

### Fulvio Calamba — `m9tpNFP6I0PMoFpVQMgl`

- **Location:** Veronica Quintanilla (`Nb8CYlsFaRFQchJBOvo1`)
- **GHL Conversation ID:** `Lbw7f4HMV7IQbffrqQRn`
- **Last message at:** 2026-04-23 16:13
- **Stored (ghl_messages):** 7 | **Live GHL:** 7 | **JSONB turns:** 2

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 6 outbound messages

### Debra Roos — `J2jKvMcq5CyPGJk6HudO`

- **Location:** Veronica Quintanilla (`Nb8CYlsFaRFQchJBOvo1`)
- **GHL Conversation ID:** `Zx2Y5NpK5Nmgvsut0gaz`
- **Last message at:** 2026-04-23 14:35
- **Stored (ghl_messages):** 5 | **Live GHL:** 5 | **JSONB turns:** 2

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 4 outbound messages

### Courtney Brown — `DEF1mLzqRbGEukRCjMXh`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `fwJe70hYpy336nSz0uxK`
- **Last message at:** 2026-04-23 13:05
- **Stored (ghl_messages):** 5 | **Live GHL:** 5 | **JSONB turns:** 2

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 4 outbound messages

### Adam Snider — `YWHNvHglQ5i4g5q3GffZ`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `oQVg9Lf7qvURykX0Op80`
- **Last message at:** 2026-04-23 11:39
- **Stored (ghl_messages):** 2 | **Live GHL:** 5 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=2 vs live=5 (delta=3)

#### Issue: `missing_in_stored`

> 3 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "Vvj1bQFkvbrJ598zgIwO",
    "direction": "outbound",
    "content": "Hey Adam, did my last text make it?",
    "ts": "2026-04-22T13:05:31.717Z"
  },
  {
    "id": "8ZqFaexcDgKOR6QHlIv6",
    "direction": "outbound",
    "content": "You have successfully opted out from messaging. No future messages will be sent.",
    "ts": "2026-04-23T11:39:11.329Z"
  },
  {
    "id": "Dj5iuewJNLlSzVFiGltb",
    "direction": "inbound",
    "content": "STOP",
    "ts": "2026-04-23T11:39:11.691Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="ooooi"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 4 outbound messages

### Tobin Piha — `X1dfFActj0tbZ3dQciso`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `ZCJfgk8oz5moSn6MIrR8`
- **Last message at:** 2026-04-23 03:11
- **Stored (ghl_messages):** 4 | **Live GHL:** 4 | **JSONB turns:** 2

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 3 outbound messages

### Jose Casas — `I4VUL46AJPuiRNfnHBPa`

- **Location:** Veronica Quintanilla (`Nb8CYlsFaRFQchJBOvo1`)
- **GHL Conversation ID:** `YblTQdimq3w2ZHcgZOvj`
- **Last message at:** 2026-04-23 00:49
- **Stored (ghl_messages):** 7 | **Live GHL:** 7 | **JSONB turns:** 2

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 6 outbound messages

### Mark Johnson — `oIIEVXKp43kpdgr7Qsze`

- **Location:** Veronica Quintanilla (`Nb8CYlsFaRFQchJBOvo1`)
- **GHL Conversation ID:** `SNvJKT3ygEsJmLJvxVmQ`
- **Last message at:** 2026-04-23 00:32
- **Stored (ghl_messages):** 5 | **Live GHL:** 5 | **JSONB turns:** 2

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 4 outbound messages

### Andrew Johnson — `xU6IXkH7fCHmiljanDu7`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `26mRSysUYrGqC4KEhmOf`
- **Last message at:** 2026-04-23 00:04
- **Stored (ghl_messages):** 3 | **Live GHL:** 6 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=3 vs live=6 (delta=3)

#### Issue: `missing_in_stored`

> 3 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "lHgpRUKp3dVoQeXwoh79",
    "direction": "outbound",
    "content": "Hey Andrew, just got off the phone with someone who was overpaying for their mor",
    "ts": "2026-04-23T00:03:24.547Z"
  },
  {
    "id": "QtoEvuTmt4Qa67m4qDwY",
    "direction": "inbound",
    "content": "?",
    "ts": "2026-04-23T00:04:24.126Z"
  },
  {
    "id": "t1MqCVizYE7X1GzyYQEI",
    "direction": "outbound",
    "content": "hey Andrew, just Frank here - saw your message. looks like a while back there wa",
    "ts": "2026-04-23T00:04:30.662Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooo" live="ooooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 5 outbound messages

### Isaiah Bowling — `QccxOtSXHPs8cKB33rq3`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `8s6elYApdHQDiBQ5PZgF`
- **Last message at:** 2026-04-23 00:01
- **Stored (ghl_messages):** 2 | **Live GHL:** 5 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=2 vs live=5 (delta=3)

#### Issue: `missing_in_stored`

> 3 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "AiKqLfTnhIAGZxvwgO5X",
    "direction": "outbound",
    "content": "Hey Isaiah, just got off the phone with someone who was overpaying for their mor",
    "ts": "2026-04-22T23:14:06.863Z"
  },
  {
    "id": "jbrZss2g8cdzpUBtOabb",
    "direction": "inbound",
    "content": "I need a quote",
    "ts": "2026-04-23T00:01:31.262Z"
  },
  {
    "id": "9wkBAJMhpe2jC0hhEbF8",
    "direction": "outbound",
    "content": "hey Isaiah, just Frank here with Jeremiah's team - we help folks with mortgage p",
    "ts": "2026-04-23T00:01:36.907Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="oooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 4 outbound messages

### Sabrina Conde — `8ra1dfwbonlDNFWWp2pk`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `U0qLT4wfhmrRMVLPbkWz`
- **Last message at:** 2026-04-22 21:45
- **Stored (ghl_messages):** 1 | **Live GHL:** 4 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=1 vs live=4 (delta=3)

#### Issue: `missing_in_stored`

> 3 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "dxXvf8QToU8j8dKkFz30",
    "direction": "outbound",
    "content": "Hey Sabrina, did my last text make it?",
    "ts": "2026-04-22T21:02:38.440Z"
  },
  {
    "id": "v3lUESDL3dkhOoAjVwvW",
    "direction": "inbound",
    "content": "I don't know any Jeremiah's or what request was made, but I'm not interested.",
    "ts": "2026-04-22T21:45:40.782Z"
  },
  {
    "id": "BW5Rn9K94ll0SKrY9OH7",
    "direction": "outbound",
    "content": "ok, got it - kind of figured since it's been a while. so I can get that closed o",
    "ts": "2026-04-22T21:45:47.808Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="o" live="ooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 3 outbound messages

### Muriel Gunderson — `XYq4TvHMuEGblN34MuuS`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `m0Lv44WonC0gPOcaZMwQ`
- **Last message at:** 2026-04-22 21:23
- **Stored (ghl_messages):** 2 | **Live GHL:** 6 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=2 vs live=6 (delta=4)

#### Issue: `missing_in_stored`

> 4 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "6IUmZLFBYD7q86whAyKn",
    "direction": "outbound",
    "content": "Hey Muriel, did my last text make it?",
    "ts": "2026-04-20T21:02:41.644Z"
  },
  {
    "id": "x8l6imaANM31wGn5kxGb",
    "direction": "outbound",
    "content": "Hey Muriel, just got off the phone with someone who was overpaying for their mor",
    "ts": "2026-04-22T21:02:44.156Z"
  },
  {
    "id": "Cb0JMxzcdT5umbRqBaQx",
    "direction": "outbound",
    "content": "You have successfully opted out from messaging. No future messages will be sent.",
    "ts": "2026-04-22T21:23:29.685Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="oooooi"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 5 outbound messages

### Paul Stroud — `Sofe3GAhndhjwSZloidF`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `fzxqDW8clb35CaS8yzVJ`
- **Last message at:** 2026-04-22 20:14
- **Stored (ghl_messages):** 2 | **Live GHL:** 6 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=2 vs live=6 (delta=4)

#### Issue: `missing_in_stored`

> 4 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "ksGNYbwfCg9vLouTyIAs",
    "direction": "outbound",
    "content": "Hey Paul, did my last text make it?",
    "ts": "2026-04-20T20:12:06.502Z"
  },
  {
    "id": "e5Rdmj4lDZL2HtIyVJXS",
    "direction": "outbound",
    "content": "Hey Paul, just got off the phone with someone who was overpaying for their mortg",
    "ts": "2026-04-22T20:12:08.679Z"
  },
  {
    "id": "nEFghf7UoxNbncz3owmi",
    "direction": "inbound",
    "content": "How much to pay off 170000",
    "ts": "2026-04-22T20:14:09.821Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oo" live="ooooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 5 outbound messages

### Katherine Coffey-Dietz — `5icZ0DkxePnb0TZoQxoI`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `uRjL1AqI0aLgqgz6VJP1`
- **Last message at:** 2026-04-22 19:46
- **Stored (ghl_messages):** 5 | **Live GHL:** 8 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=5 vs live=8 (delta=3)

#### Issue: `missing_in_stored`

> 3 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "c5TbxiqwpthwOch7TdOV",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-04-22T13:10:04.649Z"
  },
  {
    "id": "QzcvTC9Y3pIV4NoZPqlr",
    "direction": "inbound",
    "content": "You have the wrong number 😉\nThis is a public business line",
    "ts": "2026-04-22T19:46:00.103Z"
  },
  {
    "id": "ezUPhyHmm2Bb46ejEFtQ",
    "direction": "outbound",
    "content": "woah... apologies Katherine, didn't mean to offend! sometimes we do get the wron",
    "ts": "2026-04-22T19:46:05.932Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="ooooo" live="ooooooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 7 outbound messages

### Caleb Tydlacka — `E2TbqIrt6QvJt1Mxpg2H`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `UtdglolQaITEEH7bP5fa`
- **Last message at:** 2026-04-22 19:24
- **Stored (ghl_messages):** 1 | **Live GHL:** 4 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=1 vs live=4 (delta=3)

#### Issue: `missing_in_stored`

> 3 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "RGLy5uk1o0SnyiyLOyJr",
    "direction": "outbound",
    "content": "Hey Caleb, did my last text make it?",
    "ts": "2026-04-22T19:23:05.794Z"
  },
  {
    "id": "rId4jc2PIwaRieI9cb4F",
    "direction": "inbound",
    "content": "No",
    "ts": "2026-04-22T19:23:54.097Z"
  },
  {
    "id": "y7aNYPhomEABADLowHxU",
    "direction": "outbound",
    "content": "got it - no problem at all. removing you from our list now. take care.",
    "ts": "2026-04-22T19:24:00.136Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="o" live="ooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 3 outbound messages

### David Brand — `XiKAa1D3kZ46IL96xUVU`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `TgXCqGqECJqwi7Gnkvja`
- **Last message at:** 2026-04-22 18:31
- **Stored (ghl_messages):** 3 | **Live GHL:** 3 | **JSONB turns:** 2

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 2 outbound messages

### Shannon R Givans — `lFrsuQhC6JYojJPZfWav`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `7toypTaicDWjzXCuXlyr`
- **Last message at:** 2026-04-22 18:28
- **Stored (ghl_messages):** 1 | **Live GHL:** 4 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=1 vs live=4 (delta=3)

#### Issue: `missing_in_stored`

> 3 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "UYb8hxsaC9l4ms7MeoVZ",
    "direction": "outbound",
    "content": "Hey Shannon R, did my last text make it?",
    "ts": "2026-04-22T18:27:05.663Z"
  },
  {
    "id": "MCEwMr70Y8hWrz7qr4Pa",
    "direction": "inbound",
    "content": "Who is this",
    "ts": "2026-04-22T18:27:59.581Z"
  },
  {
    "id": "fMOBhm4rZ4U5HzBiMAu2",
    "direction": "outbound",
    "content": "just Frank here with Jeremiah's team - we help folks with mortgage protection co",
    "ts": "2026-04-22T18:28:05.841Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="o" live="ooio"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 3 outbound messages

### Von W Ross — `4OBaSld49fgaKQaTGYRu`

- **Location:** Profit Hexagon (`K9xKBbQkhSOUZs6KzTAy`)
- **GHL Conversation ID:** `bIxE7bWTV28Xdgycft99`
- **Last message at:** 2026-04-22 18:11
- **Stored (ghl_messages):** 4 | **Live GHL:** 7 | **JSONB turns:** 2

#### Issue: `count_mismatch`

> stored=4 vs live=7 (delta=3)

#### Issue: `missing_in_stored`

> 3 live GHL message(s) not in ghl_messages table

**Samples:**

```json
[
  {
    "id": "xpZw4NFwKJN0W5Lbbd4E",
    "direction": "outbound",
    "content": "I'm starting to think you were abducted by Martians... 👽 Should I call someone?",
    "ts": "2026-04-22T13:09:17.603Z"
  },
  {
    "id": "j1HarU0HQqpTMDR8wgr9",
    "direction": "outbound",
    "content": "You have successfully opted out from messaging. No future messages will be sent.",
    "ts": "2026-04-22T18:11:05.063Z"
  },
  {
    "id": "1mY43Effu2KILMa9zpAk",
    "direction": "inbound",
    "content": "Stop",
    "ts": "2026-04-22T18:11:05.430Z"
  }
]
```

#### Issue: `order_mismatch`

> Direction sequence differs (first 30): stored="oooo" live="ooooooi"

#### Issue: `jsonb_vs_live_misalignment`

> JSONB has 1 assistant turns, live GHL has 6 outbound messages

---

## Root Cause Hypotheses

### Missing-in-stored (live GHL has messages our DB does not)

Messages exist in GHL that are absent from `ghl_messages`. Most likely: new messages arrived after the last incremental pull, the incremental cursor skipped this conversation because `ghl_date_updated` did not advance, or a pull was interrupted by 429s that exhausted retries. Fix: run a full repull via `POST /api/qc/pull-all-locations` with `{ "fullRepull": true }`.

**Affected contacts:** 37 | **Total missing messages:** 310

### Count: Live > Stored

New messages arrived after the last pull. Run a full repull to sync. 37 contact(s) affected.

### Order Mismatches

Timestamp drift between GHL's `dateAdded` and the `created_at` value stored in `ghl_messages` causes the `ORDER BY created_at` sort to differ from GHL's own sequence. Likely from messages sent near a DST boundary or during a 429-retry delay where we stored a later timestamp than GHL recorded. 37 contact(s) affected.

### JSONB vs Live GHL Misalignment

The `conversations.messages` JSONB is Claude's internal context window — it reflects exactly what the bot saw during live conversation. Misalignment with live GHL indicates Claude was generating responses with incomplete context. The delta is typically messages sent outside the bot webhook flow (manual agent sends, drip texts, other system messages). This is expected behaviour, not a bug — but a large delta may cause the bot to re-ask already-answered questions. 48 contact(s) affected.

---

## Recommendations

1. **Run a full GHL repull** — `POST /api/qc/pull-all-locations` with `{ "fullRepull": true }`. This rebuilds `ghl_messages` from scratch, fixing missing messages and count gaps.
3. **Audit timestamp storage** — consider adding a raw `ghl_date_added` column to `ghl_messages` that stores the GHL-provided `dateAdded` separately from the Postgres `created_at` insert timestamp. Use `ghl_date_added` for sort order.
6. **Sync missing ghl_conversations rows** — some contacts have local Claude conversations but no matching `ghl_conversations` row. Trigger a GHL pull for those locations.

---
*Generated by `GET /api/audit/ghl-history` on 2026-05-05*