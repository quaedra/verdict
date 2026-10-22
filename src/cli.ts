#!/usr/bin/env node
/**
 * verdict run    <program.vd>                     check and run a Verdict program
 * verdict check  <program.vd | module>            type-check a program / validate decisions
 * verdict build  <module> [--out .verdict]        train + calibrate + evaluate the builtin tier
 * verdict eval   <module> <decision> <data.csv>   run the full escalation chain on labeled data
 * verdict label  <module> <decision> <inputs.txt|csv> --out <file.csv> [--tier jet]
 *                                                 label raw inputs with a tier (teacher) → Nodd CSV
 * verdict questions <module>                      print decisions as Jet questions (dry run)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { train } from "./backends/builtin.js";
import { type Decision, isDecision } from "./decision.js";
import { toJetQuestion } from "./backends/jet.js";
import { decide } from "./runtime.js";
import { ARTIFACT_DIR, csvField, parseCsv, readExamplesCsv } from "./node.js";

const args = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

async function load(mod: string): Promise<Map<string, Decision>> {
  if (mod.endsWith(".vd")) {
    const { compile, buildDecisions } = await import("./lang/interp.js");
    return buildDecisions(compile(readFileSync(mod, "utf8"), mod));
  }
  const url = pathToFileURL(resolve(mod)).href;
  let m: Record<string, unknown>;
  if (/\.[cm]?tsx?$/.test(mod)) {
    const { tsImport } = await import("tsx/esm/api");
    m = (await tsImport(url, import.meta.url)) as Record<string, unknown>;
  } else m = (await import(url)) as Record<string, unknown>;
  const out = new Map<string, Decision>();
  for (const v of Object.values(m)) if (isDecision(v)) out.set(v.name, v);
  if (out.size === 0) fail(`${mod} exports no decisions`);
  return out;
}

function fail(msg: string): never {
  console.error(`verdict: ${msg}`);
  process.exit(1);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function table(rows: (string | number)[][]) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const [j, r] of rows.entries()) {
    console.log(r.map((c, i) => (typeof c === "number" || /^[\d.]+%?$/.test(String(c)) ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join("  "));
    if (j === 0) console.log(w.map((n) => "─".repeat(n)).join("  "));
  }
}

function check(ds: Map<string, Decision>): number {
  let errors = 0;
  for (const d of ds.values()) {
    const counts = Object.fromEntries(d.labels.map((l) => [l, 0]));
    for (const [, l] of d.examples) counts[l]++;
    const tiers = d.backends.map((b) => b.name + (b.types.includes(d.type) ? "" : " (skipped: no " + d.type + ")")).join(" → ") || "(none)";
    console.log(`${d.name}  ${d.type}  [${d.labels.join(", ")}]  threshold ${d.threshold}`);
    console.log(`  tiers: ${tiers}`);
    console.log(`  examples: ${d.examples.length}  ` + d.labels.map((l) => `${l}=${counts[l]}`).join(" "));
    if (!d.backends.some((b) => b.types.includes(d.type))) { console.log("  ✗ no tier supports this decision type"); errors++; }
    if (d.backends.some((b) => b.name === "builtin")) {
      const missing = d.labels.filter((l) => counts[l] === 0);
      const thin = d.labels.filter((l) => counts[l] > 0 && counts[l] < 5);
      if (missing.length) { console.log(`  ✗ builtin tier: no examples for ${missing.join(", ")}`); errors++; }
      if (thin.length) console.log(`  ! fewer than 5 examples for ${thin.join(", ")}`);
    }
  }
  return errors;
}

async function main() {
  const out = flag("out");
  const tierName = flag("tier");
  const limitArg = flag("limit");
  const [cmd, mod, ...rest] = args;
  if (!cmd || !mod) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^[\s\S]*?\/\*\*\n/, "").replace(/^ \* ?/gm, ""));
    process.exit(cmd ? 1 : 0);
  }
  if (mod.endsWith(".vd") && (cmd === "run" || cmd === "check")) {
    const src = readFileSync(mod, "utf8");
    const { compile, run, CheckError, VdError } = await import("./lang/interp.js");
    try {
      if (cmd === "check") {
        const p = compile(src, mod);
        console.log(`${mod}: ok — ${p.decisions.length} decision${p.decisions.length === 1 ? "" : "s"}, ${p.fns.length} function${p.fns.length === 1 ? "" : "s"}`);
      } else await run(src, mod);
    } catch (e) {
      if (e instanceof CheckError) fail("\n" + e.message);
      if (e instanceof VdError) fail("runtime error\n" + e.format(src));
      throw e;
    }
    return;
  }
  if (cmd === "run") fail("run takes a .vd program");
  const ds = await load(mod);

  if (cmd === "check") {
    process.exit(check(ds) ? 1 : 0);
  }

  if (cmd === "questions") {
    console.log(JSON.stringify(Object.fromEntries([...ds.values()].map((d) => [d.name, toJetQuestion(d)])), null, 2));
    return;
  }

  if (cmd === "build") {
    if (check(ds)) fail("check failed");
    const dir = out ?? ARTIFACT_DIR;
    mkdirSync(dir, { recursive: true });
    const rows: (string | number)[][] = [["decision", "examples", "held-out", "accuracy", "macro-F1", "threshold", "kept", "acc. kept", "T", "size"]];
    for (const d of ds.values()) {
      if (!d.examples.length) continue;
      const t0 = performance.now();
      const m = train(d);
      const json = JSON.stringify(m);
      writeFileSync(join(dir, `${d.name}.json`), json);
      const s = m.metrics;
      rows.push([d.name, s.examples, s.heldOut, pct(s.accuracy), s.macroF1.toFixed(3), s.threshold, pct(s.coverage), pct(s.accuracyKept), s.temperature, `${(json.length / 1024).toFixed(0)} KB`]);
      console.error(`  trained ${d.name} in ${(performance.now() - t0).toFixed(0)} ms`);
    }
    console.log();
    table(rows);
    console.log(`\nwrote ${dir}/  ("kept" = share the builtin tier answers itself; the rest escalate)`);
    return;
  }

  const d = ds.get(rest[0] ?? "") ?? fail(`decision "${rest[0]}" not found; have: ${[...ds.keys()].join(", ")}`);

  if (cmd === "eval") {
    const data = rest[1] ? readExamplesCsv(rest[1]) : fail("usage: verdict eval <module> <decision> <data.csv>");
    const limit = Number(limitArg ?? 0) || data.length;
    const bySource = new Map<string, { n: number; ok: number }>();
    let correct = 0, uncertain = 0, n = 0;
    for (const r of data.slice(0, limit)) {
      const o = await decide(d, r.text);
      n++;
      const key = o.certain ? o.source : "uncertain";
      const s = bySource.get(key) ?? { n: 0, ok: 0 };
      s.n++;
      if (o.label === r.label) { s.ok++; correct++; }
      if (!o.certain) uncertain++;
      bySource.set(key, s);
    }
    const rows: (string | number)[][] = [["answered by", "inputs", "share", "accuracy"]];
    for (const [k, s] of bySource) rows.push([k, s.n, pct(s.n / n), pct(s.ok / s.n)]);
    rows.push(["total", n, "100.0%", pct(correct / n)]);
    table(rows);
    console.log(`\n${uncertain} of ${n} went to the uncertain arm (accuracy counts their best guess).`);
    return;
  }

  if (cmd === "label") {
    const file = rest[1] ?? fail("usage: verdict label <module> <decision> <inputs> --out <file.csv>");
    const src = readFileSync(file, "utf8");
    const inputs = file.endsWith(".csv") ? parseCsv(src).map((r) => r.text).filter(Boolean) : src.split(/\r?\n/).filter((l) => l.trim());
    const teacher = tierName ? d.backends.find((b) => b.name === tierName || b.name.startsWith(tierName + ":")) : d.backends.at(-1);
    if (!teacher) fail(`tier "${tierName}" not in ${d.name}'s chain`);
    const lines = ["text,label,confidence,source"];
    let i = 0;
    for (const text of inputs) {
      const raw = await teacher.decide(d, text);
      const [label, prob] = Object.entries(raw.probabilities).sort((a, b) => b[1] - a[1])[0];
      lines.push([csvField(text), label, (raw.confidence ?? prob).toFixed(4), csvField(teacher.name)].join(","));
      if (++i % 25 === 0) console.error(`  labeled ${i}/${inputs.length}`);
    }
    const dest = out ?? fail("--out <file.csv> is required");
    writeFileSync(dest, lines.join("\n") + "\n");
    console.log(`labeled ${inputs.length} inputs with ${teacher.name} → ${dest} (Nodd data format)`);
    return;
  }

  fail(`unknown command "${cmd}"`);
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
