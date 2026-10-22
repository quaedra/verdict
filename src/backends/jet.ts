/**
 * jet(): Quaedra's Jet typed decision model over HTTP (`POST /v1/decide`).
 * Works with `jet-serve` (MLX, local), the Hugging Face Space, or any server speaking
 * the same format. A decision maps 1:1 to a Jet question.
 */
import type { Backend, RawAnswer } from "../backend.js";
import { type Decision, VerdictError } from "../decision.js";

export interface JetOptions {
  /** Base URL. Default: $JET_URL, else http://localhost:8000. */
  url?: string;
  /** Bearer key. Default: $JET_API_KEY. Keep it server-side; browsers should call your own endpoint. */
  apiKey?: string;
  model?: string;
  /**
   * Which confidence to compare with thresholds:
   * - "max" (default): max probability — same scale as the other tiers.
   * - "entropy": Jet's own confidence, 1 − normalized entropy (stricter).
   */
  confidence?: "max" | "entropy";
  threshold?: number;
  timeoutMs?: number;
  /** Questions per request. The HF Space allows 8. */
  batchSize?: number;
  fetch?: typeof fetch;
}

export interface JetQuestion {
  type: "choice" | "noul" | "score";
  instructions: string;
  criteria?: Record<string, string> | string[];
}

interface JetAnswer {
  type: "choice" | "noul" | "score";
  choice?: string;
  probabilities?: Record<string, number> | number[];
  probability?: number;
  confidence?: number;
}

const env = (k: string): string | undefined =>
  typeof process !== "undefined" ? (process.env?.[k] || undefined) : undefined;

/** A decision as a Jet question. */
export function toJetQuestion(d: Decision): JetQuestion {
  if (d.type === "noul") return { type: "noul", instructions: d.instructions };
  if (d.type === "score") return { type: "score", instructions: d.instructions, criteria: d.labels.map((l) => d.descriptions[l]) };
  return { type: "choice", instructions: d.instructions, criteria: Object.fromEntries(d.labels.map((l) => [l, d.descriptions[l]])) };
}

/** A Jet answer as probabilities over the decision's labels. */
export function fromJetAnswer(d: Decision, a: JetAnswer | undefined, mode: "max" | "entropy", model?: string): RawAnswer {
  if (!a) throw new VerdictError(d.name, "Jet response has no answer for this question");
  let probabilities: Record<string, number>;
  if (d.type === "noul") {
    if (typeof a.probability !== "number") throw new VerdictError(d.name, "Jet noul answer has no probability");
    probabilities = { no: 1 - a.probability, yes: a.probability };
  } else if (d.type === "score") {
    if (!Array.isArray(a.probabilities) || a.probabilities.length !== d.labels.length) {
      throw new VerdictError(d.name, "Jet score answer has the wrong number of levels");
    }
    const ps = a.probabilities;
    probabilities = Object.fromEntries(d.labels.map((l, i) => [l, ps[i]]));
  } else {
    if (!a.probabilities || Array.isArray(a.probabilities)) throw new VerdictError(d.name, "Jet choice answer has no probabilities");
    probabilities = a.probabilities;
  }
  return {
    probabilities,
    ...(mode === "entropy" && typeof a.confidence === "number" ? { confidence: a.confidence } : {}),
    model: model ? `jet:${model}` : "jet",
  };
}

export function jet(o: JetOptions = {}): Backend {
  const url = (o.url ?? env("JET_URL") ?? "http://localhost:8000").replace(/\/+$/, "");
  const apiKey = o.apiKey ?? env("JET_API_KEY");
  const mode = o.confidence ?? "max";
  const batch = o.batchSize ?? 8;
  const doFetch = o.fetch ?? globalThis.fetch;

  async function call(ds: readonly Decision[], input: string): Promise<RawAnswer[]> {
    const questions = Object.fromEntries(ds.map((d) => [d.name, toJetQuestion(d)]));
    if (Object.keys(questions).length !== ds.length) {
      throw new Error("decisions sent to Jet together must have distinct names");
    }
    const res = await doFetch(`${url}/v1/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ state: input, questions, ...(o.model ? { model: o.model } : {}) }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
    });
    if (!res.ok) throw new Error(`Jet HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { model?: string; answers?: Record<string, JetAnswer> };
    return ds.map((d) => fromJetAnswer(d, body.answers?.[d.name], mode, body.model));
  }

  return {
    name: "jet",
    types: ["choice", "noul", "score"],
    threshold: () => o.threshold,
    decide: async (d, input) => (await call([d], input))[0],
    decideMany: async (ds, input) => {
      const out: RawAnswer[] = [];
      for (let i = 0; i < ds.length; i += batch) out.push(...(await call(ds.slice(i, i + batch), input)));
      return out;
    },
  };
}
