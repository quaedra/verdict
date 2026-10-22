import type { Decision, DecisionType } from "./decision.js";

/** What a tier returns: a probability per label plus its own calibrated confidence. */
export interface RawAnswer {
  probabilities: Record<string, number>;
  /** Defaults to max(probabilities) when the backend has no separate confidence. */
  confidence?: number;
  /** Model id/version for the trace. */
  model?: string;
}

export interface Backend {
  /** Short id used in traces and `outcome.source`, e.g. "builtin", "jet", "nodd:comment_moderation". */
  readonly name: string;
  readonly types: readonly DecisionType[];
  /** Tier-specific threshold (e.g. Nodd's calibrated one). Falls back to the decision's threshold. */
  threshold?(d: Decision): number | undefined;
  decide(d: Decision, input: string): Promise<RawAnswer>;
  /** Several decisions over the same input in one call (Jet shares the encoded state). */
  decideMany?(ds: readonly Decision[], input: string): Promise<RawAnswer[]>;
}

export function supports(b: Backend, d: Decision): boolean {
  return b.types.includes(d.type);
}

/** Any function as a tier: rules, an LLM call, a human queue. */
export function fn(
  name: string,
  run: (d: Decision, input: string) => Promise<RawAnswer> | RawAnswer,
  types: readonly DecisionType[] = ["choice", "noul", "score"],
): Backend {
  return { name, types, decide: async (d, input) => run(d, input) };
}
