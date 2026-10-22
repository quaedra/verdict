/** Node-only helpers: build artifacts on disk, JSONL traces, CSV examples. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BuiltinOptions, type TrainedModel, builtin } from "./backends/builtin.js";
import type { Backend } from "./backend.js";
import type { Tracer } from "./runtime.js";

export const ARTIFACT_DIR = ".verdict";

export function readArtifact(name: string, dir = ARTIFACT_DIR): TrainedModel | undefined {
  const file = join(dir, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as TrainedModel) : undefined;
}

/** builtin() that loads models produced by `verdict build` from `.verdict/`. */
export function builtinFromDisk(dir = ARTIFACT_DIR, o: Omit<BuiltinOptions, "load"> = {}): Backend {
  return builtin({ ...o, load: (name) => readArtifact(name, dir) });
}

/** Append one JSON line per decision. */
export function jsonlTracer(file = join(ARTIFACT_DIR, "trace.jsonl")): Tracer {
  mkdirSync(dirname(file), { recursive: true });
  return (e) => appendFileSync(file, JSON.stringify(e) + "\n");
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, newlines in fields). */
export function parseCsv(src: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

export const csvField = (s: string | number) => {
  const v = String(s);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/** Load `text,label` rows (Nodd's data format) for withExamples(). */
export function readExamplesCsv(file: string): { text: string; label: string }[] {
  return parseCsv(readFileSync(file, "utf8"))
    .filter((r) => r.text?.trim() && r.label?.trim())
    .map((r) => ({ text: r.text, label: r.label.trim() }));
}
