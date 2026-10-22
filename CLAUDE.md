# CLAUDE.md — Verdict

A programming language where decisions are the branches: own `.vd` syntax (`src/lang/`) plus
the same runtime as a TypeScript library. Language: `docs/LANGUAGE.md`. Design: `docs/SPEC.md`.

## Setup
`npm install` · `npm test` · `npx tsx src/cli.ts run programs/hello.vd`
Programs using Jet need `JET_URL` (a real `jet-serve`, or `npx tsx examples/mock-jet.ts` on :8000).
Next work: `docs/ROADMAP.md` (M1 = run against a real Jet and Nodd).

## Layout
- `src/lang/` — the .vd language: `lexer` → `parser` (AST in `ast.ts`) → `checker` → `interp`.
  Reference: `docs/LANGUAGE.md`. Programs: `programs/*.vd`. Tests: `tests/lang.test.ts`.
- `src/decision.ts` — `choice` / `noul` / `score`, validation (`VerdictError`)
- `src/match.ts` — `match`, `at`, `route`; the exhaustiveness lives in the `Arms` type
- `src/runtime.ts` — `decide`, `decideAll` (per-tier batching), tracing. Browser-safe.
- `src/backends/` — `builtin` (trained from examples), `jet` (HTTP `/v1/decide`), `nodd` (wraps `@nodd/node`)
- `src/node.ts` — disk artifacts (`.verdict/`), JSONL tracer, CSV. Node-only.
- `src/cli.ts` — `check | build | eval | label | questions`
- `examples/` — moderation, triage, `mock-jet.ts` (offline stand-in with Jet's exact wire format), `demo.ts`

## Rules
- Language changes: update `docs/LANGUAGE.md`, the checker AND the interpreter together, and add a
  test with the exact error message for any new check.
- `npm test` must pass: runtime tests + `tsc --noEmit` (which checks `tests/types.check.ts`).
- Any change to `match`/`Arms` types: run the probe — strip the `@ts-expect-error` lines into a
  temp file and check each error is still the *intended* one, not an unrelated one.
- Keep `src/index.ts` and everything it imports free of `node:` imports (browser bundle).
- Jet's wire format is defined by quaedra/jet `src/server.py` + `src/inference.py`. Don't guess:
  choice → `probabilities` object, score → `probabilities` array in level order, noul → `probability` of yes.
- The mock Jet is not a model. Never report its numbers as Jet results.
