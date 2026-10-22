# The Verdict language (.vd)

A small, statically checked language where **decisions are the branches**. You write
ordinary logic — functions, loops, lists, strings — and wherever a program needs
judgment you declare a decision and `match` on it. The checker guarantees every
answer *and* "not sure" is handled before the program runs.

```sh
verdict check program.vd     # every error, with line:col and a caret
verdict run program.vd       # check, then run
verdict build program.vd     # train the builtin tier for each decision → .verdict/
```

## Hello world

```vd
decision greeting: choice "Is the user saying hello or goodbye?" {
  hello: "a greeting"
  goodbye: "a farewell"
  examples { "hi there" => hello  "bye" => goodbye  … }
  tiers builtin
}

fn reply(text: text) -> text {
  match greeting(text) {
    hello => "Hello, world!"
    goodbye => "Goodbye, world!"
    uncertain => "Hmm, not sure what you mean."
  }
}

for t in ["hello world", "bye world", "banana"] {
  print("{t} → {reply(t)}")
}
```

## Decisions

```vd
decision NAME: choice "question" { label: "description" … }   // 2–255 labels
decision NAME: noul   "question" { yes: "…"  no: "…" }        // yes/no; descriptions optional
decision NAME: score  "question" { low: "…"  …  high: "…" }   // 2–10 ordered levels, low → high
```

Inside the body, in any order:

| Entry | Meaning |
|---|---|
| `label: "description"` | an answer; the description is what Jet reads |
| `examples { "text" => label … }` | training data for the builtin tier; labels are checked |
| `examples from "file.csv"` | `text,label` CSV (Nodd's format), path relative to the program |
| `tiers builtin -> nodd "dir" -> jet` | escalation chain; `jet "http://…"` for a specific server |
| `threshold 0.85` | confidence a tier needs to answer instead of escalating (default 0.7) |

Default tiers: `builtin -> jet` when there are examples, otherwise `jet`.
Jet's URL defaults to `$JET_URL` (else `http://localhost:8000`), key from `$JET_API_KEY`.

A decision is called like a function and returns an **outcome**:

```vd
let o = moderate(comment)
o.label  o.confidence  o.certain  o.source  o.score  o.latency_ms
prob(o, "spam")
print(o)          // spam (97% via builtin)
```

## match

```vd
match moderate(comment) {
  ok => "publish"
  spam => "quarantine"
  toxic @ 0.9 => "hide"     // guard: only if p(toxic) ≥ 0.9
  toxic => "review"         // otherwise the next toxic arm
  uncertain => "review"     // required
}
```

Rules (all checked before running):
- every label has an arm; `uncertain` is required;
- arms for unknown labels are errors;
- several arms per label are allowed only when all but the last are guarded;
  the first arm whose guard passes runs; if none passes → `uncertain`;
- an outcome with `certain = false` (no tier was confident) always goes to `uncertain`.

An arm's value is its last expression; `match` is an expression.

`if` only takes booleans — `if moderate(x) { … }` is an error that points you to `match`.
Comparing a label to a literal (`o.label == "spma"`) is checked against the labels.

## Deciding several things at once

```vd
let r = decide ticket { topic, human: needs_human, urgency }
match r.human { yes => … no => … uncertain => … }
```

`decide` runs all the decisions on one input. At each tier, everything still
unresolved goes together — Jet gets **one request** for all its questions.

## The rest of the language

```vd
let x = 1                 // declare
x = x + 1                 // assign (must be declared)
if x > 1 and not done { … } else if … { … } else { … }
for item in list { … }
while cond { … }
fn name(a: text, b: num) -> text { … }   // last expression is the return value; `return` works too
"interpolated {x + 1} text"              // \{ for a literal brace
[1, 2, 3]   xs[0]   xs[-1]   r.field
```

Types: `text`, `num`, `bool`, `list`, `any`, and a decision's name for its outcome
(`fn queue(t: topic) -> text { match t { … } }`).

Built-ins: `print`, `len`, `lower`, `upper`, `trim`, `contains`, `split`, `join`, `str`,
`num`, `round`, `range`, `push`, `read_lines`, `read_csv`, `prob`.

## How it runs

`.vd` source → lexer → parser → checker → interpreter. Decisions compile to the
same runtime decisions the TypeScript API uses, so escalation, batching, tracing and the
builtin / Nodd / Jet tiers are shared. `verdict build`, `eval`, `label` and `questions`
accept `.vd` files as well as TS modules.
