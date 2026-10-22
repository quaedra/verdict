import type { DecisionType } from "./decision.js";

/** One tier's attempt, kept for the trace and for debugging escalations. */
export interface Step {
  backend: string;
  label?: string;
  confidence?: number;
  threshold?: number;
  accepted: boolean;
  latencyMs: number;
  error?: string;
}

export interface Outcome<L extends string = string> {
  readonly decision: string;
  readonly type: DecisionType;
  /** Most probable label. Still set when uncertain, so you can log or pre-fill with it. */
  readonly label: L;
  readonly probabilities: Readonly<Record<L, number>>;
  readonly confidence: number;
  /** True when a tier answered above its threshold. False → match() takes the `uncertain` arm. */
  readonly certain: boolean;
  /** Tier that produced this answer. */
  readonly source: string;
  readonly model?: string;
  readonly latencyMs: number;
  readonly trail: readonly Step[];
  /** score decisions: expected level index (0 = lowest level), fractional. */
  readonly score?: number;
}

/** p(label), 0 for labels the backend didn't return. */
export function p<L extends string>(o: Outcome<L>, label: L): number {
  return o.probabilities[label] ?? 0;
}
