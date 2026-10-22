# Roadmap

## M0 — PoC (this repo) ✅
- [x] `choice` / `noul` / `score` decisions with typed examples, validated at definition
- [x] `match` with compile-time exhaustiveness and a required `uncertain` arm; `at()` guards
- [x] Escalation chain, `decideAll` with per-tier batching
- [x] Backends: `builtin()` (trained from examples, calibrated), `jet()` (HTTP `/v1/decide`),
      `nodd()` (wraps `@nodd/node`), `fn()`
- [x] `verdict build` / `check` / `eval` / `label` CLI, `.verdict/` artifacts
- [x] JSONL trace
- [x] Examples: comment moderation (1,711 rows from Nodd), support triage with `decideAll`
- [x] Tests: runtime (`node:test`) + type tests (`tsc` with `@ts-expect-error`)

## M0.5 — Own syntax ✅
- [x] `.vd` lexer, parser, checker (exhaustive match, label checks, types), interpreter
- [x] Guarded fall-through arms (`high @ 0.8 => …` then `high => …`)
- [x] `verdict run | check`, and build/eval/label/questions accept `.vd`
- [x] VS Code syntax highlighting (`editors/vscode`)
- [ ] Language server: diagnostics from the checker, hover shows a decision's labels
- [ ] Records/structs, `else` in match for non-decision values, modules (`import "x.vd"`)
- [ ] Compile `.vd` to TypeScript (same runtime) instead of interpreting

## M1 — Real stack end to end
- [ ] Run `examples/` against a live Jet (local `jet-serve` or the HF Space)
- [ ] `verdict label` → `nodd run` → `nodd()` tier: one script that distills a decision from
      Jet into a Nodd model and wires it into the chain
- [ ] Check that Jet's choice keys and Nodd's labels match the decision at load (done for
      Nodd; add a dry-run for Jet)

## M2 — React
- [ ] `useDecision(D, input)` hook: debounced, suspense-friendly, runs `builtin`/`nodd` in a
      worker, escalates to Jet through the app's own endpoint (keys stay server-side)
- [ ] `<Decide on={…}>` with typed render props per label + `uncertain`

## M3 — Learning loop
- [ ] `verdict retrain`: take escalated cases from the trace, label them with the top tier,
      add to the examples, rebuild, show the metric diff, fail CI on regression
- [ ] Per-decision drift alarm: share of escalations over time

## M4 — Language
- [ ] TS compiler plugin / ESLint rule: flag `decide()` results used without `match`
- [ ] Optional `.verdict` syntax compiling to the TS embedding, if the TS form hits limits
- [ ] Policy arms: `@ p > 0.9` sugar, cost budgets per decision (`maxTier: "nodd"` in the browser)
