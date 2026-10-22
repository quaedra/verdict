/**
 * match(): exhaustive handling of a decision's outcome.
 *
 * The type requires one arm per label AND an `uncertain` arm. Forgetting either is a
 * compile error, so low-confidence cases can't silently fall through to an action.
 */
import type { Outcome } from "./outcome.js";

export interface Guarded<R> {
  readonly kind: "verdict.guard";
  readonly min: number;
  readonly run: (o: Outcome) => R;
}

/** Arm that only fires when p(label) ≥ min; otherwise the outcome goes to `uncertain`. */
export function at<R>(min: number, run: (o: Outcome) => R): Guarded<R> {
  if (!(min > 0 && min <= 1)) throw new RangeError(`at(): min must be in (0, 1], got ${min}`);
  return { kind: "verdict.guard", min, run };
}

export type Arm<L extends string, R> = ((o: Outcome<L>) => R) | Guarded<R>;

export type Arms<L extends string, R> = { readonly [K in L]: Arm<L, R> } & {
  readonly uncertain: (o: Outcome<L>) => R;
};

/** Which arm an outcome goes to. Exposed for tests, logging and UI previews. */
export function route<L extends string>(o: Outcome<L>, arms: Arms<L, unknown>): L | "uncertain" {
  if (!o.certain) return "uncertain";
  const arm = arms[o.label] as Arm<L, unknown> | undefined;
  if (arm === undefined) {
    // Only reachable from untyped JS or a backend returning a label outside the decision.
    throw new Error(`match(): no arm for label "${o.label}" of decision "${o.decision}"`);
  }
  if (typeof arm !== "function" && (o.probabilities[o.label] ?? 0) < arm.min) return "uncertain";
  return o.label;
}

/**
 * All arms return the same type R. When arms return different literals, give them a
 * common type (e.g. a helper `(a: Action) => …`) — TS infers R from the arms, not a union.
 */
export function match<L extends string, R>(o: Outcome<L>, arms: Arms<NoInfer<L>, R>): R {
  const which = route(o, arms as Arms<L, unknown>);
  if (which === "uncertain") return arms.uncertain(o);
  const arm = arms[which] as Arm<L, R>;
  return typeof arm === "function" ? arm(o) : arm.run(o as Outcome);
}
