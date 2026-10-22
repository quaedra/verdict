/**
 * Comment moderation: builtin tier trained from 1,362 examples, escalating to Jet.
 * Data: Nodd's synthetic comment_moderation set (MIT), split 80/20 by examples/split.ts.
 */
import { at, choice, decide, jet, match, withExamples } from "../src/index.js";
import { builtinFromDisk, readExamplesCsv } from "../src/node.js";

export const Moderate = withExamples(
  choice("comment_moderation", {
    instructions: "Decide whether a user comment on a product blog is acceptable to publish.",
    options: {
      ok: "Normal comment. Can be positive, negative or off topic, but harmless.",
      spam: "Ads, links to unrelated products or services, SEO junk, scams.",
      toxic: "Insults, harassment, threats or hate toward people or groups.",
    },
    examples: [
      ["Great write-up, the benchmarks section was really useful.", "ok"],
      ["Get 10k followers today!!! cheap-followers.xyz", "spam"],
    ],
    threshold: 0.85,
    backends: [builtinFromDisk(), jet()],
  }),
  readExamplesCsv(new URL("./data/comment_moderation.train.csv", import.meta.url).pathname),
);

export type Action = "publish" | "hide" | "quarantine" | "review";

/** The application code: every label handled, low confidence can't slip through. */
export async function moderate(comment: string): Promise<{ action: Action; why: string }> {
  const o = await decide(Moderate, comment);
  const why = `${o.label} ${(o.confidence * 100).toFixed(0)}% via ${o.source}`;
  const act = (action: Action) => ({ action, why });
  return match(o, {
    ok: () => act("publish"),
    spam: () => act("quarantine"),
    toxic: at(0.9, () => act("hide")), // hiding is visible to the author: be sure
    uncertain: () => act("review"),
  });
}
