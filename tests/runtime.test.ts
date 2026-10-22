import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Backend,
  type RawAnswer,
  type TraceEvent,
  at,
  builtin,
  choice,
  decide,
  decideAll,
  fn,
  jet,
  match,
  noul,
  nodd,
  route,
  score,
  setTracer,
  train,
  VerdictError,
} from "../src/index.js";
import { csvField, parseCsv } from "../src/node.js";
import { startMockJet } from "../examples/mock-jet.js";

const fixed = (name: string, probabilities: Record<string, number>, confidence?: number): Backend =>
  fn(name, () => ({ probabilities, confidence }));
const broken = (name: string): Backend => fn(name, () => { throw new Error("boom"); });

const mod = (backends: Backend[], threshold = 0.8) =>
  choice("moderate", {
    instructions: "ok to publish?",
    options: { ok: "fine", spam: "ads", toxic: "insults" },
    threshold,
    backends,
  });

// ---------- definitions ----------

test("definitions are validated when created", () => {
  assert.throws(() => choice("Bad Name", { instructions: "x", options: { a: "", b: "" } }), VerdictError);
  assert.throws(() => choice("one", { instructions: "x", options: { only: "" } }), /2–255 options/);
  assert.throws(() => choice("x", { instructions: " ", options: { a: "", b: "" } }), /instructions/);
  assert.throws(() => choice("x", { instructions: "q", options: { a: "", uncertain: "" } }), /reserved/);
  assert.throws(() => score("x", { instructions: "q", levels: { only: "" } }), /2–10 levels/);
  assert.throws(() => choice("x", { instructions: "q", options: { a: "", b: "" }, threshold: 1.5 }), /threshold/);
  // runtime twin of the type check, for examples from CSV/JSON
  assert.throws(() => choice("x", { instructions: "q", options: { a: "", b: "" }, examples: [["t", "c" as "a"]] }), /not one of/);
  const n = noul("escalate", { instructions: "q" });
  assert.deepEqual(n.labels, ["no", "yes"]);
});

// ---------- match ----------

const outcome = (label: "ok" | "spam" | "toxic", pr: number, certain = true) => ({
  decision: "moderate", type: "choice" as const, label, certain, source: "t", latencyMs: 0, trail: [], confidence: pr,
  probabilities: { ok: 0, spam: 0, toxic: 0, [label]: pr } as Record<"ok" | "spam" | "toxic", number>,
});
const arms = {
  ok: () => "publish",
  spam: () => "quarantine",
  toxic: at(0.9, () => "hide"),
  uncertain: () => "review",
};

test("match routes by label, guard and certainty", () => {
  assert.equal(match(outcome("ok", 0.95), arms), "publish");
  assert.equal(match(outcome("toxic", 0.95), arms), "hide");
  assert.equal(match(outcome("toxic", 0.85), arms), "review", "guard below min → uncertain");
  assert.equal(match(outcome("ok", 0.99, false), arms), "review", "uncertain outcome → uncertain arm");
  assert.equal(route(outcome("spam", 0.9), arms), "spam");
  assert.throws(() => at(0, () => 1), RangeError);
});

// ---------- escalation ----------

test("first confident tier answers; lower tiers are not called", async () => {
  let calls = 0;
  const counting = fn("never", () => { calls++; return { probabilities: { ok: 1 } }; });
  const o = await decide(mod([fixed("a", { ok: 0.9, spam: 0.1 }), counting]), "x");
  assert.equal(o.source, "a");
  assert.equal(o.certain, true);
  assert.equal(calls, 0);
  assert.equal(o.trail.length, 1);
});

test("unsure tier escalates to the next one", async () => {
  const o = await decide(mod([fixed("a", { ok: 0.6, spam: 0.4 }), fixed("b", { spam: 0.95, ok: 0.05 })]), "x");
  assert.equal(o.label, "spam");
  assert.equal(o.source, "b");
  assert.deepEqual(o.trail.map((s) => [s.backend, s.accepted]), [["a", false], ["b", true]]);
});

test("everyone unsure → most confident answer, certain=false", async () => {
  const o = await decide(mod([fixed("a", { ok: 0.6, spam: 0.4 }), fixed("b", { toxic: 0.7, ok: 0.3 })]), "x");
  assert.equal(o.certain, false);
  assert.equal(o.label, "toxic");
  assert.equal(o.source, "b");
  assert.equal(match(o, arms), "review");
});

test("a failing tier is recorded and skipped; all failing throws", async () => {
  const o = await decide(mod([broken("down"), fixed("b", { ok: 0.9, spam: 0.1 })]), "x");
  assert.equal(o.source, "b");
  assert.equal(o.trail[0].error, "boom");
  await assert.rejects(decide(mod([broken("a"), broken("b")]), "x"), /every tier failed/);
});

test("tiers that don't support the type are skipped; unknown labels are rejected", async () => {
  const choiceOnly: Backend = { ...fixed("c", { yes: 1 }), types: ["choice"] };
  const n = noul("needs_human", { instructions: "q", backends: [choiceOnly, fixed("n", { yes: 0.9, no: 0.1 })] });
  assert.equal((await decide(n, "x")).source, "n");
  const o = await decide(mod([fixed("bad", { advert: 1 }), fixed("ok", { ok: 1 })]), "x");
  assert.match(o.trail[0].error!, /not in the decision/);
});

test("tier thresholds override the decision threshold", async () => {
  const strict: Backend = { ...fixed("strict", { ok: 0.9, spam: 0.1 }), threshold: () => 0.95 };
  const o = await decide(mod([strict, fixed("b", { ok: 0.6, spam: 0.4 })], 0.5), "x");
  assert.equal(o.source, "b", "0.9 < strict tier's 0.95, so it escalated; b passes the decision's 0.5");
});

test("score outcomes carry the expected level", async () => {
  const u = score("urgency", { instructions: "q", levels: { low: "", mid: "", high: "" }, backends: [fixed("s", { low: 0, mid: 0.5, high: 0.5 })], threshold: 0.4 });
  const o = await decide(u, "x");
  assert.equal(o.score, 1.5);
});

// ---------- decideAll ----------

test("decideAll batches unresolved decisions per tier", async () => {
  const batches: string[][] = [];
  const teacher: Backend = {
    name: "teacher",
    types: ["choice", "noul", "score"],
    decide: async () => { throw new Error("should batch"); },
    decideMany: async (ds) => {
      batches.push(ds.map((d) => d.name));
      return ds.map((d): RawAnswer => ({ probabilities: { [d.labels[0]]: 0.95, [d.labels[1]]: 0.05 } }));
    },
  };
  const a = mod([fixed("local", { ok: 0.99, spam: 0.01 }), teacher]);
  const b = noul("needs_human", { instructions: "q", backends: [teacher] });
  const c = score("urgency", { instructions: "q", levels: { low: "", high: "" }, backends: [fixed("local2", { low: 0.5, high: 0.5 }), teacher] });
  const r = await decideAll("x", { a, b, c });
  // round 1: a and c answered locally (c unsure), b goes to the teacher; round 2: c escalates.
  assert.deepEqual(batches, [["needs_human"], ["urgency"]]);
  assert.equal(r.a.source, "local");
  assert.equal(r.b.source, "teacher");
  assert.equal(r.c.source, "teacher");
  assert.deepEqual(r.c.trail.map((s) => s.backend), ["local2", "teacher"]);
});

test("decideAll sends several decisions in one teacher request", async () => {
  let requests = 0;
  const teacher: Backend = {
    name: "t", types: ["choice", "noul", "score"],
    decide: async () => { throw new Error("unexpected single call"); },
    decideMany: async (ds) => { requests++; return ds.map((d) => ({ probabilities: { [d.labels.at(-1)!]: 0.9, [d.labels[0]]: 0.1 } })); },
  };
  const r = await decideAll("x", {
    a: noul("a", { instructions: "q", backends: [teacher] }),
    b: noul("b", { instructions: "q", backends: [teacher] }),
    c: score("c", { instructions: "q", levels: { lo: "", hi: "" }, backends: [teacher] }),
  });
  assert.equal(requests, 1);
  assert.equal(r.a.label, "yes");
  assert.equal(r.c.label, "hi");
});

// ---------- builtin ----------

const toy = () => {
  const ex: [string, "ok" | "spam" | "toxic"][] = [];
  const ok = ["great post thanks", "this helped a lot", "nice explanation of the api", "i disagree with the second point", "thanks for sharing the code"];
  const spam = ["buy cheap followers now", "visit cheap-pills.xyz today", "earn money from home click here", "best deals on sneakers www.deals.com", "free crypto giveaway click"];
  const toxic = ["you are an idiot", "shut up moron", "what a stupid clown", "only an idiot would write this", "you are pathetic and dumb"];
  for (let i = 0; i < 4; i++) {
    ok.forEach((t) => ex.push([`${t} ${i}`, "ok"]));
    spam.forEach((t) => ex.push([`${t} ${i}`, "spam"]));
    toxic.forEach((t) => ex.push([`${t} ${i}`, "toxic"]));
  }
  return choice("toy", { instructions: "q", options: { ok: "", spam: "", toxic: "" }, examples: ex, threshold: 0.6, backends: [builtin()] });
};

test("builtin learns from examples and is calibrated", async () => {
  const d = toy();
  const m = train(d);
  assert.ok(m.metrics.accuracy >= 0.9, `accuracy ${m.metrics.accuracy}`);
  assert.equal((await decide(d, "buy cheap sneakers here www.x.com")).label, "spam");
  assert.equal((await decide(d, "you stupid idiot")).label, "toxic");
  const sum = Object.values((await decide(d, "anything")).probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("builtin uses a matching artifact and retrains on a stale one", async () => {
  const d = toy();
  const m = train(d);
  let loads = 0;
  const fromDisk = builtin({ load: () => { loads++; return m; } });
  const o = await fromDisk.decide(d, "you idiot");
  assert.equal(loads, 1);
  assert.match(o.model!, new RegExp(m.fingerprint));
  const stale = { ...m, fingerprint: "00000000" };
  const warn = console.warn;
  let warned = "";
  console.warn = (s: string) => (warned = s);
  try {
    await builtin({ load: () => stale }).decide(d, "x");
  } finally {
    console.warn = warn;
  }
  assert.match(warned, /stale/);
});

test("builtin without examples explains itself", async () => {
  const d = noul("needs_human", { instructions: "q", backends: [builtin()] });
  await assert.rejects(decide(d, "x"), /every tier failed.*no examples/);
});

// ---------- jet ----------

test("jet backend speaks /v1/decide (choice, noul, score) and batches", async (t) => {
  const mock = await startMockJet();
  t.after(() => mock.close());
  const j = jet({ url: mock.url });
  const Mod = choice("comment_moderation", { instructions: "q", options: { ok: "", spam: "", toxic: "" }, backends: [j] });
  const Human = noul("needs_human", { instructions: "Needs a human?", backends: [j] });
  const Urg = score("urgency", { instructions: "How urgent?", levels: { low: "", normal: "", high: "" }, backends: [j], threshold: 0.5 });

  const o = await decide(Mod, "With all due respect, you're an idiot."); // in the mock's data as toxic
  assert.equal(o.label, "toxic");
  assert.equal(o.source, "jet");

  const r = await decideAll("I was charged twice and need a refund immediately", { h: Human, u: Urg });
  assert.equal(r.h.label, "yes");
  assert.equal(r.u.label, "high");
  assert.ok(r.u.score! > 1.5);
  assert.equal(mock.requests, 2, "one request for decide(), one for both questions in decideAll()");
});

test("jet HTTP errors are recorded and the chain falls back", async (t) => {
  const mock = await startMockJet();
  t.after(() => mock.close());
  const auth: string[] = [];
  const failing = jet({
    url: mock.url,
    apiKey: "k",
    fetch: async (url, init) => {
      auth.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response("no", { status: 503 });
    },
  });
  const o = await decide(mod([failing, fixed("local", { ok: 0.9, spam: 0.1 })]), "x");
  assert.deepEqual(auth, ["Bearer k"]);
  assert.match(o.trail[0].error!, /Jet HTTP 503/);
  assert.equal(o.source, "local");
});

// ---------- nodd ----------

test("nodd tier: uses the model's calibrated threshold and checks labels", async () => {
  const fake = (labels: string[], threshold: number, label: string, conf: number) => async () => ({
    info: { model: "comment_moderation-v3", labels, threshold },
    decide: async () => ({ label, confidence: conf, probabilities: Object.fromEntries(labels.map((l) => [l, l === label ? conf : (1 - conf) / (labels.length - 1)])) }),
  });
  const ok = await decide(mod([nodd("runs/cm/v3", { load: fake(["ok", "spam", "toxic"], 0.62, "spam", 0.7) })], 0.99), "x");
  assert.equal(ok.certain, true, "0.7 ≥ Nodd's calibrated 0.62 even though the decision says 0.99");
  assert.equal(ok.source, "nodd:cm/v3");
  const bad = await decide(mod([nodd("x", { load: fake(["yes", "no"], 0.5, "yes", 1) }), fixed("b", { ok: 1 })]), "x");
  assert.match(bad.trail[0].error!, /has labels \[no,yes\]/);
});

// ---------- trace + csv ----------

test("tracer records every decision with a hashed input", async () => {
  const events: TraceEvent[] = [];
  setTracer((e) => events.push(e));
  try {
    await decide(mod([fixed("a", { ok: 0.6, spam: 0.4 }), fixed("b", { ok: 0.9, spam: 0.1 })]), "secret text");
  } finally {
    setTracer(null);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].input, undefined);
  assert.match(events[0].inputHash, /^[0-9a-f]{8}$/);
  assert.equal(events[0].trail.length, 2);
});

test("csv round trip", () => {
  const rows = [{ text: 'He said "hi", then\nleft', label: "ok" }, { text: "plain", label: "spam" }];
  const src = ["text,label", ...rows.map((r) => `${csvField(r.text)},${r.label}`)].join("\n");
  assert.deepEqual(parseCsv(src), rows);
});
