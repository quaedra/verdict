# Verdict

**A programming language where decisions are the branches.** Write ordinary logic —
functions, loops, lists, strings — and wherever the program needs judgment, declare a
decision and `match` on it. The checker makes sure every answer *and* "not sure" is
handled before anything runs. At runtime each decision climbs a chain of models — a tiny
one trained from your examples, [Nodd](https://github.com/quaedra/nodd), then
[Jet](https://github.com/quaedra/jet) — until one is confident.

```vd
decision moderate: choice "Is this comment ok to publish?" {
  ok: "harmless comment"
  spam: "ads, links, scams"
  toxic: "insults, harassment"
  examples from "comments.csv"
  tiers builtin -> jet
  threshold 0.85
}

fn action(comment: text) -> text {
  match moderate(comment) {
    ok => "publish"
    spam => "quarantine"
    toxic @ 0.9 => "hide"
    uncertain => "review"       // required — forgetting it is a compile error
  }
}

for c in read_lines("inbox.txt") { print("{action(c)}: {c}") }
```

```sh
npx verdict run programs/hello.vd
npx verdict check programs/triage.vd
```

Language reference: [docs/LANGUAGE.md](docs/LANGUAGE.md) · programs: [`programs/`](programs/) ·
VS Code highlighting: [`editors/vscode`](editors/vscode)

## Also usable from TypeScript

The same runtime is a TypeScript library, for decisions inside an existing app:

```ts
import { at, choice, decide, jet, match } from "verdict";
import { builtinFromDisk } from "verdict/node";

export const Moderate = choice("comment_moderation", {
  instructions: "Is this comment ok to publish?",
  options: { ok: "harmless", spam: "ads, links, scams", toxic: "insults, harassment" },
  examples: [["Get 10k followers!!! cheap-followers.xyz", "spam"] /* … */],
  threshold: 0.85,
  backends: [builtinFromDisk(), jet()],          // escalation chain
});

const o = await decide(Moderate, comment);
match(o, {
  ok: () => publish(),
  spam: () => quarantine(),
  toxic: at(0.9, () => hide()),                  // guard: p(toxic) ≥ 0.9 or it's uncertain
  uncertain: () => review(),                     // required — forgetting it won't compile
});
```

## What the type checker enforces

| Mistake | Result |
|---|---|
| No `uncertain` arm | compile error |
| A label without an arm | compile error |
| An arm for a label that doesn't exist | compile error |
| An example labeled with a non-existent label | compile error |
| Arms returning different types | compile error |

See [`tests/types.check.ts`](tests/types.check.ts) — each case is an `@ts-expect-error`.

## Decision types (= Jet question types)

```ts
choice("topic", { instructions, options: { billing: "…", bug: "…" } })   // 2–255 options
noul("needs_human", { instructions })                                    // "yes" | "no"
score("urgency", { instructions, levels: { low: "…", high: "…" } })      // 2–10 ordered levels, + .score
```

`decideAll(ticket, { topic, human: NeedsHuman, urgency: Urgency })` decides several on the
same input; whatever is still unresolved goes to Jet **in one request** (Jet encodes the
state once).

## Tiers

| Backend | Runs | Notes |
|---|---|---|
| `builtin()` / `builtinFromDisk()` | anywhere, no deps, < 1 ms | hashed n-gram logistic regression + temperature calibration, trained from `examples` |
| `nodd(dir)` | Node / browser | your Nodd export via `@nodd/node` (optional peer dep); uses Nodd's calibrated threshold and checks its labels match |
| `jet({ url })` | HTTP `POST /v1/decide` | `jet-serve`, the HF Space, or anything with the same format. `$JET_URL`, `$JET_API_KEY` |
| `fn(name, …)` | anywhere | rules, an LLM, a human queue |

A tier that throws (Jet down) is logged in `outcome.trail` and skipped. If every tier is
unsure, you get the most confident answer with `certain: false` → `uncertain` arm.

## CLI

```sh
npx verdict check examples/moderation.ts
npx verdict build examples/moderation.ts          # train + calibrate builtin → .verdict/
npx verdict eval  examples/moderation.ts comment_moderation examples/data/comment_moderation.test.csv
npx verdict label examples/moderation.ts comment_moderation raw.txt --out labeled.csv   # teacher → Nodd CSV
npx verdict questions examples/triage.ts          # decisions as Jet questions (dry run)
```

## Try it

```sh
npm install
npm run verdict -- build examples/moderation.ts && npm run verdict -- build examples/triage.ts
npm run demo        # starts an offline mock Jet unless JET_URL is set
npm test            # 29 runtime + language tests, plus type tests
npm run verdict -- run programs/triage.vd   # needs JET_URL (or run examples/mock-jet.ts)
```

PoC results on the 349 held-out comments (data: Nodd's synthetic comment_moderation set),
builtin tier → **mock** Jet:

| answered by | share | accuracy |
|---|---|---|
| builtin (692 KB, < 1 ms) | 75% | 96.6% |
| Jet (escalated) | 23% | 95.1% |
| uncertain → review | 1.4% | — |

Builtin alone is 87% accurate on everything; it keeps only what it's sure about. The mock
Jet is a lookup over the dataset, not a model — rerun with a real Jet (`JET_URL=…`) for
real numbers.

Design: [docs/SPEC.md](docs/SPEC.md) · Plan: [docs/ROADMAP.md](docs/ROADMAP.md)
