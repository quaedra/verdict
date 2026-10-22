import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CheckError, VdError, compile, run } from "../src/lang/interp.js";
import { startMockJet } from "../examples/mock-jet.js";

const capture = async (src: string, file = "<test>") => {
  const out: string[] = [];
  await run(src, file, { print: (l) => out.push(l) });
  return out;
};

const errorsOf = (src: string): string[] => {
  try {
    compile(src, "t.vd");
  } catch (e) {
    if (e instanceof CheckError) return e.errors.map((x) => x.message);
    throw e;
  }
  return [];
};

const GREETING = `
decision greeting: choice "hello or goodbye?" {
  hello: "a greeting"
  goodbye: "a farewell"
  examples {
    "hi there" => hello "hello!" => hello "good morning" => hello "hey" => hello
    "bye" => goodbye "see you later" => goodbye "good night" => goodbye "farewell" => goodbye
  }
  tiers builtin
}
`;

test("hello.vd runs", async () => {
  const out = await capture(readFileSync("programs/hello.vd", "utf8"), "programs/hello.vd");
  assert.deepEqual(out, [
    "hello world → Hello, world!",
    "bye world → Goodbye, world!",
    "banana → Hmm, not sure what you mean.",
  ]);
});

test("match must handle every label and uncertain, and nothing else", () => {
  const errs = errorsOf(GREETING + `
let r = match greeting("x") {
  hello => 1
  hi => 2
}`);
  assert.deepEqual(errs, [
    "match on greeting doesn't handle: goodbye",
    "match on greeting needs an 'uncertain' arm — what should happen when no tier is confident?",
    "'hi' is not a label of greeting (labels: hello, goodbye)",
  ]);
});

test("labels are checked everywhere they appear", () => {
  const errs = errorsOf(`
decision d: choice "q" { a: "x" b: "y" examples { "t" => c } tiers builtin }
let o = d("x")
print(o.label == "z", prob(o, "q"))
`);
  assert.deepEqual(errs, [
    "'c' is not a label of d (labels: a, b)",
    '"z" is never a label of d (labels: a, b)',
    '"q" is not a label of d (labels: a, b)',
  ]);
});

test("types: decisions take text, if needs bool, functions check arity", () => {
  const errs = errorsOf(GREETING + `
fn f(t: text) -> text { "x" }
let o = greeting(42)
if o { print(1) }
print(f(), nope)
`);
  assert.deepEqual(errs, [
    "decision greeting takes text, got num",
    "'if' needs a bool, got greeting outcome — use match to branch on a decision",
    "f takes 1 argument, got 0",
    "'nope' is not defined",
  ]);
});

test("decision declarations are validated", () => {
  const errs = errorsOf(`
decision a: choice "q" { only: "x" tiers jet }
decision b: noul "q" { maybe: "x" tiers jet }
decision c: score "q" { lo: "" hi: "" tiers builtin }
decision d: choice "q" { x: "" y: "" threshold 2 tiers jet }
`);
  assert.deepEqual(errs, [
    "a choice needs 2–255 options, 'a' has 1",
    "a noul decision only has 'yes' and 'no', not 'maybe'",
    "the builtin tier learns from examples, but c has none",
    "threshold must be in (0, 1]",
  ]);
});

test("guarded arms fall through; an unguarded duplicate is unreachable", () => {
  assert.deepEqual(errorsOf(GREETING + `
let r = match greeting("x") { hello @ 0.9 => 1 hello => 2 goodbye => 3 uncertain => 0 }`), []);
  assert.deepEqual(errorsOf(GREETING + `
let r = match greeting("x") { hello => 1 hello @ 0.9 => 2 goodbye => 3 uncertain => 0 }`), [
    "'hello' is already handled above without a guard, so this arm never runs",
  ]);
});

test("syntax errors point at the problem", () => {
  for (const [src, msg] of [
    ['print("unterminated)', "unterminated string"],
    ['decision d: choice "q" { a: "x" b: "y" examples { "t" a } }', "expected '=>'"],
    ["let = 3", "expected a variable name"],
    ['decision d: maybe "q" {}', "expected a decision type"],
  ] as const) {
    try {
      compile(src, "t.vd");
      assert.fail(`no error for ${src}`);
    } catch (e) {
      assert.ok(e instanceof CheckError);
      assert.match(e.errors[0].message, new RegExp(msg));
    }
  }
});

test("ordinary logic: functions, recursion, loops, lists, strings", async () => {
  const out = await capture(`
fn fib(n: num) -> num {
  if n < 2 { return n }
  fib(n - 1) + fib(n - 2)
}
let xs = []
for i in range(10) { xs = push(xs, fib(i)) }
print(join(xs, ","))
let i = 0
while i < 3 { i = i + 1 }
print("i={i} len={len("héllo")} {upper("ok")} {contains([1, 2], 2)}")
`);
  assert.deepEqual(out, ["0,1,1,2,3,5,8,13,21,34", "i=3 len=5 OK true"]);
});

test("runtime errors carry a position", async () => {
  await assert.rejects(capture(`let xs = [1]\nprint(xs[3])`), (e: unknown) => {
    assert.ok(e instanceof VdError);
    assert.equal(e.pos.line, 2);
    assert.match(e.message, /out of range/);
    return true;
  });
});

test("triage.vd: decide{} batches, guards pick P1, Jet tiers via the mock", async (t) => {
  const mock = await startMockJet();
  t.after(() => mock.close());
  const prev = process.env.JET_URL;
  process.env.JET_URL = mock.url;
  t.after(() => (process.env.JET_URL = prev));
  const out = await capture(readFileSync("programs/triage.vd", "utf8"), "programs/triage.vd");
  assert.match(out[0], /^finance \/ agent \/ P1/);
  assert.match(out[2], /^docs-bot \/ auto-reply \/ P3/);
  assert.equal(mock.requests, 3, "one Jet request per ticket for needs_human + urgency together");
  assert.equal(mock.questions, 6);
});
