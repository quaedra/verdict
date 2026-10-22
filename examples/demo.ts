/**
 * npm run demo — runs both examples end to end.
 * Uses $JET_URL if set (a real Jet), otherwise starts the offline mock Jet.
 */
import { setTracer } from "../src/index.js";
import { jsonlTracer, readExamplesCsv } from "../src/node.js";
import { startMockJet } from "./mock-jet.js";

const mock = process.env.JET_URL ? null : await startMockJet();
if (mock) process.env.JET_URL = mock.url;
console.log(`Jet: ${process.env.JET_URL}${mock ? "  (offline mock — set JET_URL for a real Jet)" : ""}\n`);
setTracer(jsonlTracer(".verdict/trace.jsonl"));

// Import after JET_URL is set: jet() reads it when the decision module loads.
const { moderate } = await import("./moderation.js");
const { triage } = await import("./triage.js");

console.log("── comment moderation ─────────────────────────────");
const comments = [
  "Thanks, this fixed my build on the first try.",
  "Earn $500/day from home!!! Visit quick-cash-now.biz",
  "Only an absolute moron would ship this garbage.",
  "Not sure I agree with point 3, the numbers look off to me.",
  "Check my profile for great deals on sneakers",
];
for (const c of comments) {
  const r = await moderate(c);
  console.log(`${r.action.padEnd(10)} ${r.why.padEnd(28)} ${c}`);
}

console.log("\n── held-out test set (349 comments) ───────────────");
const test = readExamplesCsv(new URL("./data/comment_moderation.test.csv", import.meta.url).pathname);
const before = mock?.requests ?? 0;
const counts: Record<string, number> = {};
let wrongPublished = 0;
for (const r of test) {
  const { action } = await moderate(r.text);
  counts[action] = (counts[action] ?? 0) + 1;
  if (action === "publish" && r.label !== "ok") wrongPublished++;
}
console.log(Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · "));
console.log(`spam/toxic published by mistake: ${wrongPublished}`);
if (mock) console.log(`Jet calls: ${mock.requests - before} of ${test.length} (${(((mock.requests - before) / test.length) * 100).toFixed(0)}%); the rest stayed on the builtin tier`);

console.log("\n── support triage: 3 decisions, decideAll ─────────");
for (const t of [
  "I was charged twice this month and need a refund immediately.",
  "How do I export my reports as CSV?",
  "It would be nice to have a dark mode in the dashboard.",
]) {
  const before = mock?.requests ?? 0;
  const r = await triage(t);
  console.log(`${r.queue.padEnd(11)} ${r.assignee.padEnd(10)} ${r.priority}  jet requests: ${mock ? mock.requests - before : "?"}  ${t}`);
  console.log(`${" ".repeat(11)} sources: topic=${r.trail.topic} human=${r.trail.human} urgency=${r.trail.urgency}`);
}

console.log("\ntrace → .verdict/trace.jsonl");
await mock?.close();
