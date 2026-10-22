/** One-off: split Nodd's synthetic CSVs into stable train/test files (test = 20% by text hash). */
import { readFileSync, writeFileSync } from "node:fs";
import { csvField, parseCsv } from "../src/node.js";
import { hashInput } from "../src/runtime.js";

for (const name of ["comment_moderation", "support_triage"]) {
  const rows = parseCsv(readFileSync(`examples/data/${name}_data.csv`, "utf8")).filter((r) => r.text && r.label);
  const isTest = (t: string) => parseInt(hashInput("test:" + t), 16) % 5 === 0;
  for (const [suffix, part] of [["train", rows.filter((r) => !isTest(r.text))], ["test", rows.filter((r) => isTest(r.text))]] as const) {
    writeFileSync(`examples/data/${name}.${suffix}.csv`, ["text,label", ...part.map((r) => `${csvField(r.text)},${r.label}`)].join("\n") + "\n");
    console.log(name, suffix, part.length);
  }
}
