# QC Review Actions Bug — 2026-05-05

## Symptom
Jeremiah reported: "I was trying to add reviews and queue reviews into the actual system, but it wasn't working to approve, mark failed, or save and train."

Mark Failed and Save & Train buttons in the QC Portal appeared to do nothing (no toast, list didn't refresh). Approve button appeared to work.

## Root Cause
`modText` referenced but never declared in `qcAction()` (`public/index.html` line ~2815).

When `qcAction('failed')` or `qcAction('modified')` fires, execution reaches:
```javascript
if (outcome === 'failed' || outcome === 'modified') {
  if (modText) { ... }  // ReferenceError: modText is not defined
```
The async function throws, catching nothing above it. The `/api/qc/review` DB write **already succeeded** at this point, but the code never reaches:
- The pending-changes loop
- The toast (`'QC review submitted: ...'`)
- `loadQC()` (list refresh)

`qcAction('approved')` was unaffected because it skips the `if (outcome === 'failed' || outcome === 'modified')` block.

`modText` was intended to hold per-bubble replacement text, but that workflow now lives in `qcFlagOpen/qcFlagSubmit` (the "Queue Fix" panel). The variable was orphaned when the inline replacement input was removed from the action row.

## Fix Applied
Added `const modText = null;` at the top of `qcAction()` (before line 2800, `public/index.html`). The downstream `if (modText)` checks safely evaluate to false. All other branches (feedback text, behavioral feedback, generic failed entry) continue to work.

## What Was Already Working
- `/api/qc/review` backend (`src/routes/qc.js:134`) correctly accepts `approved|failed|modified` — schema fine
- `qc_reviews` table and `conversations.qc_reviewed` column exist (created in `migrate_v2.sql`)
- The DB write was always succeeding; only the post-write UI steps were broken

## Secondary Note — AI Review Queue
Separate from the QC Portal, the AI Review Queue (`/api/review-queue/:id/action`) only exposes Approve/Deny. That queue doesn't have Mark Failed or Save & Train buttons in the frontend — correct by design.
