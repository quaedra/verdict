/** Verdict: decisions as a language primitive. Browser-safe entry point. */
export { choice, noul, score, isDecision, withBackends, withExamples, VerdictError } from "./decision.js";
export type { Decision, DecisionType, Example } from "./decision.js";
export { match, at, route } from "./match.js";
export type { Arm, Arms, Guarded } from "./match.js";
export { p } from "./outcome.js";
export type { Outcome, Step } from "./outcome.js";
export { decide, decideAll, setTracer, hashInput, normalize } from "./runtime.js";
export type { TraceEvent, Tracer } from "./runtime.js";
export { fn, supports } from "./backend.js";
export type { Backend, RawAnswer } from "./backend.js";
export { builtin, train, predict, evaluate, featurize, fingerprint } from "./backends/builtin.js";
export type { TrainedModel, Metrics, BuiltinOptions } from "./backends/builtin.js";
export { jet, toJetQuestion, fromJetAnswer } from "./backends/jet.js";
export type { JetOptions, JetQuestion } from "./backends/jet.js";
export { nodd } from "./backends/nodd.js";
export type { NoddDecider, NoddOptions } from "./backends/nodd.js";
