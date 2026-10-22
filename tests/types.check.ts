/**
 * Compile-time guarantees. This file is type-checked by `npm run typecheck`, never run.
 * Every @ts-expect-error must stay an error: if one starts compiling, tsc fails.
 */
import { at, choice, decide, decideAll, match, noul, score, type Outcome } from "../src/index.js";

const Moderate = choice("moderate", {
  instructions: "Is this comment ok to publish?",
  options: { ok: "harmless", spam: "ads, links", toxic: "insults" },
  examples: [
    ["nice post", "ok"],
    // @ts-expect-error — example label must be one of the options
    ["buy now", "advert"],
  ],
});

declare const o: Outcome<"ok" | "spam" | "toxic">;

// ✅ every label + uncertain
const action: string = match(o, {
  ok: () => "publish",
  spam: at(0.8, () => "quarantine"),
  toxic: (x) => `hide (${x.probabilities.toxic})`,
  uncertain: () => "review",
});

// @ts-expect-error — missing the `uncertain` arm
match(o, { ok: () => 1, spam: () => 2, toxic: () => 3 });

// @ts-expect-error — missing the `toxic` arm
match(o, { ok: () => 1, spam: () => 2, uncertain: () => 0 });

// @ts-expect-error — `advert` is not a label of this decision
match(o, { ok: () => 1, spam: () => 2, toxic: () => 3, advert: () => 4, uncertain: () => 0 });

// @ts-expect-error — arms must agree on the result type
const n: number = match(o, { ok: () => 1, spam: () => 2, toxic: () => "three", uncertain: () => 0 });

// Outcome types flow from the decision.
async function flows() {
  const r = await decide(Moderate, "hello");
  const l: "ok" | "spam" | "toxic" = r.label;
  // @ts-expect-error — not a label
  r.probabilities.advert;

  const Escalate = noul("escalate", { instructions: "Needs a human?" });
  const Urgency = score("urgency", { instructions: "How urgent?", levels: { low: "can wait", high: "now" } });
  const all = await decideAll("text", { mod: Moderate, esc: Escalate, urg: Urgency });
  const y: "yes" | "no" = all.esc.label;
  const u: "low" | "high" = all.urg.label;
  match(all.esc, { yes: () => 0, no: () => 1, uncertain: () => 2 });
  // @ts-expect-error — noul arms are yes/no
  match(all.esc, { ok: () => 0, no: () => 1, uncertain: () => 2 });
  return [l, y, u, action, n];
}
void flows;
