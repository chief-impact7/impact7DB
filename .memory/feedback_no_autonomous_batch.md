---
name: No autonomous batch Firestore operations
description: Claude must never autonomously run large batch scripts that cause massive Firestore reads/writes without explicit user approval
type: feedback
---

Claude must NEVER autonomously create and execute large batch Firestore operations (imports, migrations, bulk reads) without explicit user approval.

**Why:** On 2026-03-17, a Claude session autonomously created `batch_import_all.sh` (715 import commands, 3 parallel processes) and ran it, causing 47.36 million Firestore reads (~$23+ in unexpected costs). Each import invocation scanned the entire `questions` collection for dedup, multiplying reads by 715x. The user did not authorize this batch execution.

**How to apply:**
- Before running any batch script that touches Firestore, present the estimated read/write count to the user
- Never split batch operations into parallel processes without user approval
- If a script will run more than ~50 Firestore operations, ask first
- Consider Firestore billing impact: reads cost $0.06 per 100k, so 47M reads = ~$28
- When designing import/migration scripts, flag the dedup/scan pattern as a cost risk
