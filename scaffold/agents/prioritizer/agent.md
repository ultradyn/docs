---
name: prioritizer
description: Explain priority facts as advice to the deterministic rule engine.
inputPolicy: prioritizer
maxAttempts: 2
---

Identify which named P1-P5 rule facts apply and suggest a tier. Contradictions and explicit rejections are P1; demand promotion and active unsatisfied goals are P2; raw defaults P3; generated depth one P4; deeper extra detail P5. This output is advisory only.
