# Verdict — design spec

Working name: **Verdict**. A TypeScript-embedded language where a *decision* is a
primitive, like a function. You declare the question and its typed answers once; the
type checker makes every call site handle every answer **and** the "not sure" case;
a build step picks or trains what runs it.

Verdict is the language layer over the Quaedra stack:

| Tier | What | Where it runs | Cost |
|---|---|---|---|
| `builtin()` | hashed n-gram logistic regression trained from the decision's own examples | anywhere, zero deps, < 1 ms | free |
| `nodd(dir)` | Nodd encoder classifier (MiniLM-class, ONNX q8, 10–35 MB) | Node / browser | free |
| `jet(opts)` | Jet typed decision model, `POST /v1/decide` | server / HF Space | GPU time |
| `fn(…)` | any function (an LLM call, a rule, a human queue) | anywhere | — |

A decision lists its backends as an **escalation chain**. Each tier answers or hands
the input up when it is below its confidence threshold.

## 1. Decisions

Three types, matching Jet's wire format exactly so a decision is also a Jet question:

```ts
const Moderate = choice("moderate", {
  instructions: "Is this comment ok to publish?",
  options: { ok: "harmless comment", spam: "ads, links, scams", toxic: "insults, harassment" },
  examples: [["Buy cheap followers", "spam"], …],      // typed: label must be an option key
  threshold: 0.8,
  backends: [builtin(), jet()],
});

const NeedsHuman = noul("needs_human", { instructions: "Does this need a human?" });   // yes | no
const Urgency = score("urgency", { instructions: "How urgent?", levels: ["low", "medium", "high"] });
```

| Type | Labels | Jet criteria | Limits |
|---|---|---|---|
| `choice` | option keys | `{key: description}` | 2–255 options |
| `noul` | `"yes" \| "no"` | none | — |
| `score` | level names | `[descriptions low→high]` | 2–10 levels |

`score` adds a fractional `score` (expected level index) to the outcome.

Definitions are validated when created (`VerdictError` with the decision name), so bad
specs fail at import time, not on the first request.

## 2. Outcomes

```ts
interface Outcome<L extends string> {
  decision: string;
  label: L;                         // argmax
  probabilities: Record<L, number>;
  confidence: number;               // backend's calibrated confidence
  certain: boolean;                 // confidence ≥ threshold of the tier that answered
  source: string;                   // "builtin" | "nodd:…" | "jet:…" | …
  latencyMs: number;
  trail: Step[];                    // every tier tried, for the trace log
  score?: number;                   // score decisions only
}
```

## 3. `match` — exhaustive by construction

```ts
match(outcome, {
  toxic: at(0.9, () => hide()),       // guarded arm: p(toxic) must be ≥ 0.9
  spam: () => quarantine(),
  ok: () => publish(),
  uncertain: (o) => review(o),        // REQUIRED
});
```

Type rules (enforced by `tsc`, tested in `tests/types.check.ts`):

1. Every label needs an arm. Missing arm → compile error.
2. `uncertain` is required. Missing → compile error.
3. Unknown labels are rejected (excess property check).
4. All arms return the same type `R`; `match` returns `R`.

Runtime rules:

- `certain === false` → `uncertain`.
- Guarded arm with `p(label) < min` → `uncertain`.
- Otherwise the label's arm.

So thresholds live in application code, next to the action they protect — the model
only reports probabilities.

## 4. Escalation

`decide(D, input)` walks `D.backends` in order:

1. Skip tiers that don't support the decision type (e.g. Nodd only does `choice`).
2. Ask the tier. If `confidence ≥ tierThreshold` (tier-specific, e.g. Nodd's calibrated
   threshold; else the decision's `threshold`, default 0.7) → return, `certain: true`.
3. Otherwise record the step and go up.
4. Every tier unsure or failed → return the **most confident** answer with `certain: false`.
   A tier that throws (network down) is recorded and skipped, never fatal unless *all* fail.

`decideAll(input, {a: D1, b: D2})` decides several questions on the same state. Tiers
with `decideMany` (Jet) get **one request per tier** with only the still-unresolved
questions — Jet encodes the state once and shares it across questions.

## 5. Build (`verdict build`)

`verdict build src/decisions.ts`:

1. Imports the module, collects exported decisions.
2. `check`: label coverage (≥ 2 examples per label is a warning, 0 is an error).
3. Splits examples (stratified 80/20 by a stable hash, so splits don't move between runs).
4. Trains the builtin tier, fits a calibration temperature on the held-out part.
5. Evaluates: accuracy, macro-F1, coverage at threshold (how much the tier keeps vs
   escalates) and accuracy on the kept part.
6. Writes `.verdict/<name>.json` (weights + metrics). At runtime the builtin tier loads
   this file; if it's missing it trains in memory from the examples (dev mode).

`verdict label <module> <decision> <inputs.txt> --out data.csv` uses the decision's
**last** tier (the teacher, usually Jet) to label raw inputs → distillation data for the
lower tiers. Same CSV format as Nodd (`text,label,confidence,source`), so the same data
trains a Nodd model with `nodd run`.

## 6. Trace

`setTracer(jsonlTracer(".verdict/trace.jsonl"))` writes one line per decision: input
hash (not the text, by default), every tier's answer and latency, final label. This is
the replay/diff log and the raw material for retraining on escalated cases.

## 7. Non-goals for the PoC

- Own syntax/parser. The TS embedding gets type checking, editors and React for free.
  A `.verdict` syntax can compile to this later if it earns it.
- Image/audio inputs (Jet is text-only).
- Training Nodd/Jet from Verdict — Verdict exports data in their formats and calls them.
