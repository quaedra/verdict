/**
 * Support triage: three decisions about one ticket, decided together.
 * Topic has examples (builtin tier first); escalation and urgency go straight to Jet.
 * decideAll() sends everything still unresolved to Jet in ONE request.
 */
import { choice, decideAll, jet, match, noul, score, withExamples } from "../src/index.js";
import { builtinFromDisk, readExamplesCsv } from "../src/node.js";

const teacher = jet();

export const Topic = withExamples(
  choice("support_topic", {
    instructions: "What is the support ticket mainly about?",
    options: {
      billing: "Charges, refunds, invoices, plans, pricing, discounts and payment methods.",
      bug: "Something in the product is broken, crashes, shows errors or behaves wrongly.",
      account: "Login, passwords, 2FA, email or owner changes, access, security and account deletion.",
      how_to: "A question about how to use something the product already does.",
      feature_request: "Asks for something the product doesn't do yet, or suggests an improvement.",
    },
    threshold: 0.8,
    backends: [builtinFromDisk(), teacher],
  }),
  readExamplesCsv(new URL("./data/support_triage.train.csv", import.meta.url).pathname),
);

export const NeedsHuman = noul("needs_human", {
  instructions: "Does this ticket need a human agent rather than an automated reply?",
  backends: [teacher],
});

export const Urgency = score("urgency", {
  instructions: "How urgent is this ticket?",
  levels: {
    low: "Can wait a few days; no one is blocked.",
    normal: "Should be handled today.",
    high: "Customer is blocked or losing money now.",
  },
  backends: [teacher],
});

export async function triage(ticket: string) {
  const r = await decideAll(ticket, { topic: Topic, human: NeedsHuman, urgency: Urgency });
  const queue = match(r.topic, {
    billing: () => "finance",
    bug: () => "engineering",
    account: () => "identity",
    how_to: () => "docs-bot",
    feature_request: () => "product",
    uncertain: () => "general",
  });
  const assignee = match(r.human, { yes: () => "agent", no: () => "auto-reply", uncertain: () => "agent" });
  const priority = match(r.urgency, { low: () => "P3", normal: () => "P2", high: () => "P1", uncertain: () => "P2" });
  return { queue, assignee, priority, trail: { topic: r.topic.source, human: r.human.source, urgency: r.urgency.source } };
}
