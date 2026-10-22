/** decide() / decideAll(): run a decision's escalation chain. Browser-safe (no node: imports). */
import { type Backend, type RawAnswer, supports } from "./backend.js";
import { type Decision, VerdictError } from "./decision.js";
import type { Outcome, Step } from "./outcome.js";

export interface TraceEvent {
  at: string;
  decision: string;
  inputHash: string;
  input?: string;
  label: string;
  certain: boolean;
  confidence: number;
  source: string;
  latencyMs: number;
  trail: readonly Step[];
}
export type Tracer = (e: TraceEvent) => void;

let tracer: Tracer | null = null;
let traceInputs = false;
/** Install a trace sink. Inputs are hashed unless `includeInputs` is set. */
export function setTracer(t: Tracer | null, opts: { includeInputs?: boolean } = {}): void {
  tracer = t;
  traceInputs = opts.includeInputs ?? false;
}

export function hashInput(s: string): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

interface Scored {
  probabilities: Record<string, number>;
  label: string;
  confidence: number;
  model?: string;
}

/** Map a backend's answer onto the decision's labels and renormalize. */
export function normalize(d: Decision, raw: RawAnswer, backend: string): Scored {
  const probs: Record<string, number> = {};
  let sum = 0;
  for (const l of d.labels) {
    const v = raw.probabilities[l];
    const x = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
    probs[l] = x;
    sum += x;
  }
  const unknown = Object.keys(raw.probabilities).filter((k) => !(d.labels as readonly string[]).includes(k));
  if (unknown.length) throw new VerdictError(d.name, `${backend} returned labels not in the decision: ${unknown.join(", ")}`);
  if (sum <= 0) throw new VerdictError(d.name, `${backend} returned no probability mass`);
  let label = d.labels[0];
  for (const l of d.labels) {
    probs[l] /= sum;
    if (probs[l] > probs[label]) label = l;
  }
  const confidence = raw.confidence ?? probs[label];
  return { probabilities: probs, label, confidence, model: raw.model };
}

function thresholdFor(b: Backend, d: Decision): number {
  return b.threshold?.(d) ?? d.threshold;
}

function finish<L extends string>(
  d: Decision<L>,
  input: string,
  best: (Scored & { source: string }) | null,
  certain: boolean,
  trail: Step[],
  t0: number,
): Outcome<L> {
  if (!best) {
    const errs = trail.map((s) => `${s.backend}: ${s.error ?? "unsupported"}`).join("; ");
    throw new VerdictError(d.name, trail.length ? `every tier failed (${errs})` : "no backend supports this decision type");
  }
  const out: Outcome<L> = {
    decision: d.name,
    type: d.type,
    label: best.label as L,
    probabilities: best.probabilities as Record<L, number>,
    confidence: best.confidence,
    certain,
    source: best.source,
    model: best.model,
    latencyMs: now() - t0,
    trail,
    ...(d.type === "score" ? { score: d.labels.reduce((s, l, i) => s + i * best.probabilities[l], 0) } : {}),
  };
  if (tracer) {
    try {
      tracer({
        at: new Date().toISOString(),
        decision: d.name,
        inputHash: hashInput(input),
        ...(traceInputs ? { input } : {}),
        label: out.label,
        certain,
        confidence: out.confidence,
        source: out.source,
        latencyMs: out.latencyMs,
        trail,
      });
    } catch {
      /* tracing must never break a decision */
    }
  }
  return out;
}

/** One tier's verdict on one decision, appended to the trail. Returns the scored answer if usable. */
function judge(d: Decision, b: Backend, raw: RawAnswer | Error, latencyMs: number, trail: Step[]): (Scored & { source: string; ok: boolean }) | null {
  if (raw instanceof Error) {
    trail.push({ backend: b.name, accepted: false, latencyMs, error: raw.message });
    return null;
  }
  let s: Scored;
  try {
    s = normalize(d, raw, b.name);
  } catch (e) {
    trail.push({ backend: b.name, accepted: false, latencyMs, error: (e as Error).message });
    return null;
  }
  const threshold = thresholdFor(b, d);
  const ok = s.confidence >= threshold;
  trail.push({ backend: b.name, label: s.label, confidence: round(s.confidence), threshold, accepted: ok, latencyMs: round(latencyMs) });
  return { ...s, source: b.name, ok };
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** Run the escalation chain for one decision. */
export async function decide<L extends string>(d: Decision<L>, input: string): Promise<Outcome<L>> {
  const t0 = now();
  const trail: Step[] = [];
  let best: (Scored & { source: string }) | null = null;
  for (const b of d.backends) {
    if (!supports(b, d)) continue;
    const t = now();
    const raw = await b.decide(d, input).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    const j = judge(d, b, raw, now() - t, trail);
    if (!j) continue;
    if (j.ok) return finish(d, input, j, true, trail, t0);
    if (!best || j.confidence > best.confidence) best = j;
  }
  return finish(d, input, best, false, trail, t0);
}

type Outcomes<T extends Record<string, Decision<string>>> = {
  [K in keyof T]: T[K] extends Decision<infer L> ? Outcome<L> : never;
};

/**
 * Several decisions on the same input. At each step, decisions waiting on the same tier
 * are sent together; tiers with `decideMany` (Jet) get one request for all of them.
 */
export async function decideAll<T extends Record<string, Decision<string>>>(input: string, decisions: T): Promise<Outcomes<T>> {
  const t0 = now();
  const keys = Object.keys(decisions);
  const state = new Map(
    keys.map((k) => [k, { cursor: 0, trail: [] as Step[], best: null as (Scored & { source: string }) | null, done: null as Outcome | null }]),
  );

  const nextTier = (k: string): Backend | null => {
    const d = decisions[k];
    const s = state.get(k)!;
    while (s.cursor < d.backends.length && !supports(d.backends[s.cursor], d)) s.cursor++;
    return s.cursor < d.backends.length ? d.backends[s.cursor] : null;
  };

  for (;;) {
    const groups = new Map<Backend, string[]>();
    for (const k of keys) {
      const s = state.get(k)!;
      if (s.done) continue;
      const b = nextTier(k);
      if (!b) {
        s.done = finish(decisions[k], input, s.best, false, s.trail, t0);
        continue;
      }
      groups.set(b, [...(groups.get(b) ?? []), k]);
    }
    if (groups.size === 0) break;

    await Promise.all(
      [...groups].map(async ([b, ks]) => {
        const t = now();
        let answers: (RawAnswer | Error)[];
        if (b.decideMany) {
          try {
            answers = await b.decideMany(ks.map((k) => decisions[k]), input);
            if (answers.length !== ks.length) throw new Error(`${b.name}.decideMany returned ${answers.length} answers for ${ks.length} decisions`);
          } catch (e) {
            answers = ks.map(() => (e instanceof Error ? e : new Error(String(e))));
          }
        } else {
          answers = await Promise.all(ks.map((k) => b.decide(decisions[k], input).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))));
        }
        const elapsed = now() - t;
        ks.forEach((k, i) => {
          const s = state.get(k)!;
          const j = judge(decisions[k], b, answers[i], elapsed, s.trail);
          s.cursor++;
          if (!j) return;
          if (j.ok) s.done = finish(decisions[k], input, j, true, s.trail, t0);
          else if (!s.best || j.confidence > s.best.confidence) s.best = j;
        });
      }),
    );
  }
  return Object.fromEntries(keys.map((k) => [k, state.get(k)!.done])) as Outcomes<T>;
}
