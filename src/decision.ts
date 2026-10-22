/**
 * Decisions: the primitive of the language. Three types, matching Jet's wire format,
 * so every decision is also a valid Jet question.
 */
import type { Backend } from "./backend.js";

export type DecisionType = "choice" | "noul" | "score";

/** A labeled example. The label is type-checked against the decision's labels. */
export type Example<L extends string> = readonly [text: string, label: L];

export interface Decision<L extends string = string> {
  readonly kind: "verdict.decision";
  readonly type: DecisionType;
  readonly name: string;
  readonly instructions: string;
  /** Answer labels in model order. choice: option keys; noul: ["no","yes"]; score: level names low→high. */
  readonly labels: readonly L[];
  /** Human/model-readable description per label (Jet criteria). */
  readonly descriptions: Readonly<Record<L, string>>;
  readonly examples: readonly Example<L>[];
  /** Default confidence a tier must reach to answer without escalating. */
  readonly threshold: number;
  readonly backends: readonly Backend[];
}

export class VerdictError extends Error {
  constructor(decision: string, message: string) {
    super(`[${decision}] ${message}`);
    this.name = "VerdictError";
  }
}

interface Common<L extends string> {
  instructions: string;
  examples?: readonly Example<L>[];
  threshold?: number;
  backends?: readonly Backend[];
}

const MAX_CHOICE = 255;
const NAME = /^[a-z][a-z0-9_]*$/;

function base<L extends string>(
  type: DecisionType,
  name: string,
  labels: readonly L[],
  descriptions: Record<L, string>,
  o: Common<L>,
): Decision<L> {
  if (!NAME.test(name)) throw new VerdictError(name, "name must be snake_case (a-z, 0-9, _)");
  if (!o.instructions?.trim()) throw new VerdictError(name, "instructions must be a non-empty string");
  if (new Set(labels).size !== labels.length) throw new VerdictError(name, "labels must be unique");
  if ((labels as readonly string[]).includes("uncertain")) {
    throw new VerdictError(name, `"uncertain" is reserved for the low-confidence arm of match()`);
  }
  const threshold = o.threshold ?? 0.7;
  if (!(threshold > 0 && threshold <= 1)) throw new VerdictError(name, "threshold must be in (0, 1]");
  const examples = o.examples ?? [];
  for (const [text, label] of examples) {
    // Runtime twin of the compile-time check, for examples loaded from CSV/JSON.
    if (!labels.includes(label)) throw new VerdictError(name, `example label "${label}" is not one of: ${labels.join(", ")}`);
    if (typeof text !== "string" || !text.trim()) throw new VerdictError(name, "example text must be a non-empty string");
  }
  return Object.freeze({
    kind: "verdict.decision",
    type,
    name,
    instructions: o.instructions,
    labels: Object.freeze([...labels]),
    descriptions: Object.freeze({ ...descriptions }),
    examples: Object.freeze([...examples]),
    threshold,
    backends: Object.freeze([...(o.backends ?? [])]),
  });
}

/** Pick one of 2–255 named options. */
export function choice<const O extends Record<string, string>>(
  name: string,
  o: Common<Extract<keyof O, string>> & { options: O },
): Decision<Extract<keyof O, string>> {
  type L = Extract<keyof O, string>;
  const labels = Object.keys(o.options ?? {}) as L[];
  if (labels.length < 2 || labels.length > MAX_CHOICE) {
    throw new VerdictError(name, `choice needs 2–${MAX_CHOICE} options, got ${labels.length}`);
  }
  for (const l of labels) {
    if (!NAME.test(l)) throw new VerdictError(name, `option key "${l}" must be snake_case`);
  }
  return base("choice", name, labels, o.options as Record<L, string>, o);
}

/** Yes/no with a calibrated probability of "yes" (Jet's noul). */
export function noul(name: string, o: Common<"yes" | "no"> & { yes?: string; no?: string }): Decision<"yes" | "no"> {
  return base("noul", name, ["no", "yes"] as const, { no: o.no ?? "no", yes: o.yes ?? "yes" }, o);
}

/**
 * Ordered levels, low → high (2–10). `levels` maps a short label to its description,
 * in order: { low: "can wait a week", medium: "…", high: "…" }.
 */
export function score<const V extends Record<string, string>>(
  name: string,
  o: Common<Extract<keyof V, string>> & { levels: V },
): Decision<Extract<keyof V, string>> {
  type L = Extract<keyof V, string>;
  const labels = Object.keys(o.levels ?? {}) as L[];
  if (labels.length < 2 || labels.length > 10) throw new VerdictError(name, `score needs 2–10 levels, got ${labels.length}`);
  return base("score", name, labels, o.levels as Record<L, string>, o);
}

export function isDecision(x: unknown): x is Decision {
  return typeof x === "object" && x !== null && (x as Decision).kind === "verdict.decision";
}

/** Same decision, different chain/threshold — e.g. a browser build that never calls Jet. */
export function withBackends<L extends string>(d: Decision<L>, backends: readonly Backend[], threshold = d.threshold): Decision<L> {
  return Object.freeze({ ...d, backends: Object.freeze([...backends]), threshold });
}

/** Add examples loaded at runtime (CSV/JSONL), validated against the labels. */
export function withExamples<L extends string>(d: Decision<L>, rows: readonly { text: string; label: string }[]): Decision<L> {
  const extra = rows.map((r) => {
    if (!(d.labels as readonly string[]).includes(r.label)) {
      throw new VerdictError(d.name, `example label "${r.label}" is not one of: ${d.labels.join(", ")}`);
    }
    return [r.text, r.label as L] as const;
  });
  return Object.freeze({ ...d, examples: Object.freeze([...d.examples, ...extra]) });
}
