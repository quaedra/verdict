/**
 * builtin(): the zero-dependency bottom tier. A hashed n-gram multinomial logistic
 * regression trained from the decision's own examples, with temperature calibration
 * fitted on a held-out split. Tiny (tens of KB), sub-millisecond, runs anywhere.
 *
 * It is meant to take the easy majority of inputs and escalate the rest — not to
 * compete with Nodd or Jet.
 */
import type { Backend, RawAnswer } from "../backend.js";
import { type Decision, VerdictError } from "../decision.js";
import { hashInput } from "../runtime.js";

const DIM = 1 << 16;

export interface TrainedModel {
  format: "verdict.builtin";
  version: 1;
  decision: string;
  /** Hash of type, labels and examples. A mismatch means the artifact is stale. */
  fingerprint: string;
  labels: string[];
  temperature: number;
  bias: number[];
  /** Sparse weights: feature index → one weight per label. */
  weights: Record<string, number[]>;
  metrics: Metrics;
  trainedAt: string;
}

export interface Metrics {
  examples: number;
  train: number;
  heldOut: number;
  accuracy: number;
  macroF1: number;
  perLabelF1: Record<string, number>;
  /** Share of held-out inputs this tier keeps at the decision threshold (the rest escalate). */
  coverage: number;
  /** Accuracy on the kept share. This is what users of the tier actually experience. */
  accuracyKept: number;
  threshold: number;
  temperature: number;
  nll: number;
}

// ---------- features ----------

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Sparse feature vector: index → value, L2-normalized. */
export function featurize(text: string): Map<number, number> {
  const f = new Map<number, number>();
  const add = (key: string, v = 1) => {
    const i = fnv(key) % DIM;
    f.set(i, (f.get(i) ?? 0) + v);
  };
  const lower = text.toLowerCase();
  const words = lower.match(/[\p{L}\p{N}']+|[!?$€£%@#]+|https?:\/\/\S+/gu) ?? [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].startsWith("http") ? "<url>" : words[i];
    add(`w:${w}`);
    if (i > 0) add(`b:${words[i - 1]}_${w}`);
    const padded = `^${w}$`;
    for (let n = 3; n <= 5; n++) for (let j = 0; j + n <= padded.length; j++) add(`c${n}:${padded.slice(j, j + n)}`, 0.5);
  }
  // A few shape features that n-grams miss.
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length > 3 && letters === letters.toUpperCase()) add("s:allcaps", 2);
  if (/https?:\/\/|www\.|\.(com|net|io|xyz|ru)\b/i.test(text)) add("s:link", 2);
  if (/!{2,}/.test(text)) add("s:bangs");
  if (/\d{3,}/.test(text)) add("s:digits");
  add("s:len" + Math.min(6, Math.floor(Math.log2(1 + words.length))));
  let norm = 0;
  for (const v of f.values()) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (const [k, v] of f) f.set(k, v / norm);
  return f;
}

// ---------- model ----------

function logits(m: { bias: number[]; weights: Map<number, Float64Array> | Record<string, number[]> }, x: Map<number, number>): number[] {
  const z = [...m.bias];
  const isMap = m.weights instanceof Map;
  for (const [i, v] of x) {
    const w = isMap ? (m.weights as Map<number, Float64Array>).get(i) : (m.weights as Record<string, number[]>)[i];
    if (!w) continue;
    for (let k = 0; k < z.length; k++) z[k] += w[k] * v;
  }
  return z;
}

function softmax(z: number[], t = 1): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp((v - m) / t));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function fingerprint(d: Decision): string {
  return hashInput(JSON.stringify([d.type, d.labels, d.examples]));
}

/** Stable split: an example's side depends only on its text, so splits don't move between builds. */
export function isHeldOut(text: string, share = 0.2): boolean {
  return (fnv("split:" + text) % 1000) / 1000 < share;
}

export interface TrainOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  seed?: number;
  heldOutShare?: number;
  /** Drop features whose largest |weight| is below this (default 0.005). */
  prune?: number;
}

export function train(d: Decision, o: TrainOptions = {}): TrainedModel {
  const labels = [...d.labels];
  const K = labels.length;
  if (d.examples.length === 0) {
    throw new VerdictError(d.name, "builtin tier has no examples to train on — add `examples` or put it after another tier");
  }
  const rows = d.examples.map(([text, label]) => ({ text, y: labels.indexOf(label), x: featurize(text) }));
  let trainRows = rows.filter((r) => !isHeldOut(r.text, o.heldOutShare));
  let held = rows.filter((r) => isHeldOut(r.text, o.heldOutShare));
  // A handful of held-out rows can't calibrate anything (they push the temperature to the
  // ceiling). Below ~10, train on everything, keep T = 1 and report training metrics.
  const tiny = held.length < 10 || trainRows.length === 0;
  if (tiny) {
    trainRows = rows;
    held = rows;
  }

  const W = new Map<number, Float64Array>();
  const bias = new Array(K).fill(0);
  const epochs = o.epochs ?? 30;
  const lr0 = o.learningRate ?? 0.5;
  const l2 = o.l2 ?? 1e-5;
  const rand = rng(o.seed ?? 42);
  // Class weights so a rare label isn't drowned out.
  const counts = new Array(K).fill(0);
  for (const r of trainRows) counts[r.y]++;
  const cw = counts.map((c) => (c ? trainRows.length / (K * c) : 0));

  const order = trainRows.map((_, i) => i);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const lr = lr0 / (1 + ep * 0.2);
    for (const idx of order) {
      const r = trainRows[idx];
      const pr = softmax(logits({ bias, weights: W }, r.x));
      const g = pr.map((pk, k) => (pk - (k === r.y ? 1 : 0)) * cw[r.y]);
      for (let k = 0; k < K; k++) bias[k] -= lr * g[k] * 0.1;
      for (const [fi, v] of r.x) {
        let w = W.get(fi);
        if (!w) W.set(fi, (w = new Float64Array(K)));
        for (let k = 0; k < K; k++) w[k] -= lr * (g[k] * v + l2 * w[k]);
      }
    }
  }

  // Temperature: minimize held-out NLL over a grid (log-spaced 0.25 … 4).
  const heldZ = held.map((r) => ({ z: logits({ bias, weights: W }, r.x), y: r.y }));
  const nllAt = (t: number) => -heldZ.reduce((s, h) => s + Math.log(Math.max(1e-12, softmax(h.z, t)[h.y])), 0) / heldZ.length;
  let temperature = 1;
  let best = nllAt(1);
  for (let i = -20; i <= 20 && !tiny; i++) {
    const t = Math.pow(2, i / 10);
    const v = nllAt(t);
    if (v < best) [best, temperature] = [v, t];
  }

  const weights: Record<string, number[]> = {};
  for (const [fi, w] of W) {
    // Prune near-zero features and keep 3 decimals: ~4× smaller artifacts, same predictions in practice.
    const r = Array.from(w, (v) => Math.round(v * 1e3) / 1e3);
    if (r.some((v) => Math.abs(v) >= (o.prune ?? 0.005))) weights[fi] = r;
  }

  const model: TrainedModel = {
    format: "verdict.builtin",
    version: 1,
    decision: d.name,
    fingerprint: fingerprint(d),
    labels,
    temperature,
    bias: bias.map((v) => Math.round(v * 1e4) / 1e4),
    weights,
    metrics: undefined as unknown as Metrics,
    trainedAt: new Date().toISOString(),
  };
  model.metrics = evaluate(model, held.map((r) => [r.text, labels[r.y]] as const), d.threshold, {
    examples: rows.length,
    train: trainRows.length,
  });
  return model;
}

export function predict(m: TrainedModel, text: string): RawAnswer {
  const pr = softmax(logits(m, featurize(text)), m.temperature);
  return {
    probabilities: Object.fromEntries(m.labels.map((l, i) => [l, pr[i]])),
    model: `builtin:${m.decision}@${m.fingerprint}`,
  };
}

export function evaluate(
  m: TrainedModel,
  rows: readonly (readonly [string, string])[],
  threshold: number,
  extra: { examples?: number; train?: number } = {},
): Metrics {
  const K = m.labels.length;
  const tp = new Array(K).fill(0), fp = new Array(K).fill(0), fn = new Array(K).fill(0);
  let correct = 0, kept = 0, keptCorrect = 0, nll = 0;
  for (const [text, label] of rows) {
    const probs = predict(m, text).probabilities;
    const pr = m.labels.map((l) => probs[l]);
    const y = m.labels.indexOf(label);
    const yhat = pr.indexOf(Math.max(...pr));
    nll -= Math.log(Math.max(1e-12, pr[y]));
    if (yhat === y) { correct++; tp[y]++; } else { fp[yhat]++; fn[y]++; }
    if (pr[yhat] >= threshold) { kept++; if (yhat === y) keptCorrect++; }
  }
  const f1 = m.labels.map((_, k) => (tp[k] ? (2 * tp[k]) / (2 * tp[k] + fp[k] + fn[k]) : 0));
  const present = m.labels.map((_, k) => tp[k] + fn[k] > 0);
  const n = rows.length || 1;
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    examples: extra.examples ?? rows.length,
    train: extra.train ?? 0,
    heldOut: rows.length,
    accuracy: r4(correct / n),
    macroF1: r4(f1.filter((_, k) => present[k]).reduce((a, b) => a + b, 0) / Math.max(1, present.filter(Boolean).length)),
    perLabelF1: Object.fromEntries(m.labels.map((l, k) => [l, r4(f1[k])])),
    coverage: r4(kept / n),
    accuracyKept: r4(kept ? keptCorrect / kept : 0),
    threshold,
    temperature: r4(m.temperature),
    nll: r4(nll / n),
  };
}

// ---------- backend ----------

export interface BuiltinOptions {
  /** Look up a prebuilt artifact (from `verdict build`). Return undefined to train in memory. */
  load?: (decision: string) => TrainedModel | undefined;
  /** Override the decision's threshold for this tier. */
  threshold?: number;
  train?: TrainOptions;
}

export function builtin(o: BuiltinOptions = {}): Backend {
  const cache = new Map<string, TrainedModel>();
  const warned = new Set<string>();
  const model = (d: Decision): TrainedModel => {
    const fp = fingerprint(d);
    const key = `${d.name}@${fp}`;
    let m = cache.get(key);
    if (m) return m;
    const loaded = o.load?.(d.name);
    if (loaded && loaded.fingerprint === fp) m = loaded;
    else {
      if (loaded && !warned.has(d.name)) {
        warned.add(d.name);
        console.warn(`verdict: .verdict/${d.name}.json is stale (examples or labels changed); training in memory. Run \`verdict build\`.`);
      }
      m = train(d, o.train);
    }
    cache.set(key, m);
    return m;
  };
  return {
    name: "builtin",
    types: ["choice", "noul", "score"],
    threshold: () => o.threshold,
    decide: async (d, input) => predict(model(d), input),
  };
}
