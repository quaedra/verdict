/**
 * Interpreter for checked .vd programs. Decisions compile to Verdict runtime decisions,
 * so escalation, batching (decide … { }), tracing and the builtin/Nodd/Jet tiers are
 * exactly the ones the TypeScript API uses.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Backend } from "../backend.js";
import { jet } from "../backends/jet.js";
import { nodd } from "../backends/nodd.js";
import { type Decision, choice, noul, score, withExamples } from "../decision.js";
import { builtinFromDisk, parseCsv, readExamplesCsv } from "../node.js";
import type { Outcome } from "../outcome.js";
import { decide, decideAll } from "../runtime.js";
import type { DecisionDecl, Expr, FnDecl, Program, Stmt } from "./ast.js";
import { check } from "./checker.js";
import { type Pos, VdError } from "./lexer.js";
import { parse } from "./parser.js";

export type Value = string | number | boolean | null | Value[] | Rec | Outcome;
export interface Rec {
  readonly __rec: true;
  [k: string]: Value | true;
}

class ReturnSignal {
  constructor(readonly value: Value) {}
}

export interface CompileOptions {
  /** Artifact dir for the builtin tier (default .verdict in the working directory). */
  artifacts?: string;
}

/** Parse + check. Throws a CheckError listing every problem. */
export class CheckError extends Error {
  constructor(
    readonly errors: VdError[],
    readonly src: string,
  ) {
    super(errors.map((e) => e.format(src)).join("\n\n") + `\n\n${errors.length} error${errors.length === 1 ? "" : "s"}`);
    this.name = "CheckError";
  }
}

export function compile(src: string, file = "<input>"): Program {
  let program: Program;
  try {
    program = parse(src, file);
  } catch (e) {
    if (e instanceof VdError) throw new CheckError([e], src);
    throw e;
  }
  const { errors } = check(program);
  if (errors.length) throw new CheckError(errors, src);
  return program;
}

/** Turn declarations into runtime decisions. Tiers of the same kind/target are shared so decide{} can batch. */
export function buildDecisions(p: Program, o: CompileOptions = {}): Map<string, Decision> {
  const base = p.file.startsWith("<") ? process.cwd() : dirname(resolve(p.file));
  const shared = new Map<string, Backend>();
  const tier = (kind: string, arg?: string): Backend => {
    const key = `${kind}:${arg ?? ""}`;
    let b = shared.get(key);
    if (!b) {
      b = kind === "builtin" ? builtinFromDisk(o.artifacts) : kind === "jet" ? jet(arg ? { url: arg } : {}) : nodd(isAbsolute(arg!) ? arg! : resolve(base, arg!));
      shared.set(key, b);
    }
    return b;
  };
  const out = new Map<string, Decision>();
  for (const d of p.decisions) out.set(d.name, toDecision(d, base, tier));
  return out;
}

function toDecision(d: DecisionDecl, base: string, tier: (kind: string, arg?: string) => Backend): Decision {
  const hasExamples = d.examples.length > 0 || d.examplesFrom.length > 0;
  const tiers = d.tiers.length ? d.tiers.map((t) => tier(t.kind, t.arg)) : hasExamples ? [tier("builtin"), tier("jet")] : [tier("jet")];
  const common = {
    instructions: d.instructions,
    threshold: d.threshold,
    backends: tiers,
  };
  const desc = Object.fromEntries(d.labels.map((l) => [l.name, l.description]));
  let dec: Decision =
    d.type === "noul"
      ? noul(d.name, { ...common, yes: desc.yes, no: desc.no })
      : d.type === "score"
        ? score(d.name, { ...common, levels: desc })
        : choice(d.name, { ...common, options: desc });
  const rows = d.examples.map((e) => ({ text: e.text, label: e.label }));
  for (const f of d.examplesFrom) {
    try {
      rows.push(...readExamplesCsv(isAbsolute(f.path) ? f.path : resolve(base, f.path)));
    } catch (e) {
      throw new VdError(`can't read examples: ${(e as Error).message}`, f.pos);
    }
  }
  if (rows.length) dec = withExamples(dec, rows);
  return dec;
}

export interface RunOptions extends CompileOptions {
  print?: (line: string) => void;
}

export async function run(src: string, file = "<input>", o: RunOptions = {}): Promise<void> {
  const program = compile(src, file);
  const decisions = buildDecisions(program, o);
  await new Interp(program, decisions, o.print ?? ((l) => console.log(l)), src).main();
}

// ---------- values ----------

const isOutcome = (v: Value): v is Outcome => typeof v === "object" && v !== null && !Array.isArray(v) && "trail" in v && "decision" in v;
const isRec = (v: Value): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v) && "__rec" in v;

export function display(v: Value, nested = false): string {
  if (v === null) return "none";
  if (typeof v === "string") return nested ? JSON.stringify(v) : v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e4) / 1e4);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => display(x, true)).join(", ")}]`;
  if (isOutcome(v)) return `${v.certain ? "" : "uncertain "}${v.label} (${Math.round(v.confidence * 100)}% via ${v.source})`;
  return `{${Object.entries(v).filter(([k]) => k !== "__rec").map(([k, x]) => `${k}: ${display(x as Value, true)}`).join(", ")}}`;
}

function equal(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Env {
  vars: Map<string, Value>;
  parent?: Env;
}

class Interp {
  private fns: Map<string, FnDecl>;
  constructor(
    private readonly p: Program,
    private readonly decisions: Map<string, Decision>,
    private readonly print: (s: string) => void,
    private readonly src: string,
  ) {
    this.fns = new Map(p.fns.map((f) => [f.name, f]));
  }

  private fail(msg: string, pos: Pos): never {
    throw new VdError(msg, pos, this.p.file);
  }

  async main() {
    await this.block(this.p.main, { vars: new Map() });
  }

  private find(env: Env | undefined, name: string): Env | undefined {
    for (let e = env; e; e = e.parent) if (e.vars.has(name)) return e;
    return undefined;
  }

  /** Runs statements in a new scope; returns the last expression statement's value. */
  private async block(stmts: Stmt[], parent: Env): Promise<Value> {
    const env: Env = { vars: new Map(), parent };
    let last: Value = null;
    for (const s of stmts) last = await this.stmt(s, env);
    return last;
  }

  private async stmt(s: Stmt, env: Env): Promise<Value> {
    switch (s.node) {
      case "let":
        env.vars.set(s.name, await this.expr(s.value, env));
        return null;
      case "assign": {
        const v = await this.expr(s.value, env);
        this.find(env, s.name)!.vars.set(s.name, v);
        return null;
      }
      case "if":
        if (await this.truthy(s.cond, env)) await this.block(s.then, env);
        else if (s.else) await this.block(s.else, env);
        return null;
      case "while": {
        let guard = 0;
        while (await this.truthy(s.cond, env)) {
          if (++guard > 1_000_000) this.fail("loop ran over a million times", s.pos);
          await this.block(s.body, env);
        }
        return null;
      }
      case "for": {
        const it = await this.expr(s.iter, env);
        if (!Array.isArray(it)) this.fail(`'for' needs a list, got ${display(it)}`, s.iter.pos);
        for (const v of it) await this.block(s.body, { vars: new Map([[s.name, v]]), parent: env });
        return null;
      }
      case "return":
        throw new ReturnSignal(s.value ? await this.expr(s.value, env) : null);
      case "expr":
        return this.expr(s.expr, env);
    }
  }

  private async truthy(e: Expr, env: Env): Promise<boolean> {
    const v = await this.expr(e, env);
    if (typeof v !== "boolean") this.fail(`expected true or false, got ${display(v)}`, e.pos);
    return v;
  }

  private async expr(e: Expr, env: Env): Promise<Value> {
    switch (e.node) {
      case "num": return e.value;
      case "bool": return e.value;
      case "str": {
        let s = "";
        for (const p of e.parts) s += typeof p === "string" ? p : display(await this.expr(p, env));
        return s;
      }
      case "list": {
        const out: Value[] = [];
        for (const i of e.items) out.push(await this.expr(i, env));
        return out;
      }
      case "var": return this.find(env, e.name)!.vars.get(e.name)!;
      case "unary": {
        const v = await this.expr(e.arg, env);
        if (e.op === "-") {
          if (typeof v !== "number") this.fail(`'-' needs a number, got ${display(v)}`, e.pos);
          return -v;
        }
        if (typeof v !== "boolean") this.fail(`'not' needs true or false, got ${display(v)}`, e.pos);
        return !v;
      }
      case "binary": return this.binary(e, env);
      case "call": return this.call(e, env);
      case "field": {
        const t = await this.expr(e.target, env);
        if (isOutcome(t)) {
          const map: Record<string, Value> = {
            label: t.label, confidence: t.confidence, certain: t.certain, source: t.source,
            score: t.score ?? null, latency_ms: t.latencyMs,
          };
          return map[e.name];
        }
        if (isRec(t) && e.name in t) return t[e.name] as Value;
        return this.fail(`${display(t)} has no field '${e.name}'`, e.pos);
      }
      case "index": {
        const t = await this.expr(e.target, env);
        const i = await this.expr(e.index, env);
        if ((Array.isArray(t) || typeof t === "string") && typeof i === "number") {
          const k = i < 0 ? t.length + i : i;
          if (!Number.isInteger(k) || k < 0 || k >= t.length) this.fail(`index ${i} is out of range (length ${t.length})`, e.index.pos);
          return t[k];
        }
        if (isRec(t) && typeof i === "string" && i in t) return t[i] as Value;
        return this.fail(`can't index ${display(t)} with ${display(i)}`, e.pos);
      }
      case "match": {
        const o = await this.expr(e.subject, env);
        if (!isOutcome(o)) this.fail(`match needs a decision outcome, got ${display(o)}`, e.subject.pos);
        const p = (o.probabilities as Record<string, number>)[o.label] ?? 0;
        // First arm for the label whose guard passes; none (or not certain) → uncertain.
        const arm =
          (o.certain ? e.arms.find((a) => a.label === o.label && (a.guard === undefined || p >= a.guard)) : undefined) ??
          e.arms.find((a) => a.label === "uncertain")!;
        return this.block(arm.body, env);
      }
      case "decide": {
        const input = await this.expr(e.input, env);
        if (typeof input !== "string") this.fail(`decisions take text, got ${display(input)}`, e.input.pos);
        const ds = Object.fromEntries(e.entries.map((en) => [en.key, this.decisions.get(en.decision)!]));
        const r = await this.guard(e.pos, () => decideAll(input, ds));
        return { __rec: true, ...r } as Rec;
      }
    }
  }

  private async guard<R>(pos: Pos, f: () => Promise<R>): Promise<R> {
    try {
      return await f();
    } catch (err) {
      if (err instanceof VdError || err instanceof ReturnSignal) throw err;
      return this.fail((err as Error).message, pos);
    }
  }

  private async binary(e: Extract<Expr, { node: "binary" }>, env: Env): Promise<Value> {
    if (e.op === "and") return (await this.truthy(e.left, env)) && (await this.truthy(e.right, env));
    if (e.op === "or") return (await this.truthy(e.left, env)) || (await this.truthy(e.right, env));
    const l = await this.expr(e.left, env);
    const r = await this.expr(e.right, env);
    const bad = (): never => this.fail(`can't use '${e.op}' on ${display(l, true)} and ${display(r, true)}`, e.pos);
    switch (e.op) {
      case "==": return equal(l, r);
      case "!=": return !equal(l, r);
      case "+":
        if (typeof l === "string" || typeof r === "string") return display(l) + display(r);
        if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
        if (typeof l === "number" && typeof r === "number") return l + r;
        return bad();
    }
    if (typeof l === "string" && typeof r === "string" && ["<", ">", "<=", ">="].includes(e.op)) {
      return e.op === "<" ? l < r : e.op === ">" ? l > r : e.op === "<=" ? l <= r : l >= r;
    }
    if (typeof l !== "number" || typeof r !== "number") return bad();
    switch (e.op) {
      case "-": return l - r;
      case "*": return l * r;
      case "/": return r === 0 ? this.fail("division by zero", e.pos) : l / r;
      case "%": return r === 0 ? this.fail("division by zero", e.pos) : l % r;
      case "<": return l < r;
      case ">": return l > r;
      case "<=": return l <= r;
      case ">=": return l >= r;
    }
    return bad();
  }

  private async call(e: Extract<Expr, { node: "call" }>, env: Env): Promise<Value> {
    const args: Value[] = [];
    for (const a of e.args) args.push(await this.expr(a, env));
    const d = this.decisions.get(e.callee);
    if (d) {
      if (typeof args[0] !== "string") this.fail(`decision ${d.name} takes text, got ${display(args[0])}`, e.args[0].pos);
      return this.guard(e.pos, () => decide(d, args[0] as string));
    }
    const f = this.fns.get(e.callee);
    if (f) {
      const vars = new Map<string, Value>(f.params.map((p, i) => [p.name, args[i]]));
      try {
        return await this.block(f.body, { vars });
      } catch (sig) {
        if (sig instanceof ReturnSignal) return sig.value;
        throw sig;
      }
    }
    return this.builtin(e, args);
  }

  private builtin(e: Extract<Expr, { node: "call" }>, a: Value[]): Value {
    const need = (ok: boolean, what: string): void => {
      if (!ok) this.fail(`${e.callee}: expected ${what}`, e.pos);
    };
    switch (e.callee) {
      case "print":
        this.print(a.map((v) => display(v)).join(" "));
        return null;
      case "len":
        need(typeof a[0] === "string" || Array.isArray(a[0]), "text or a list");
        return (a[0] as string | Value[]).length;
      case "lower": return String(a[0]).toLowerCase();
      case "upper": return String(a[0]).toUpperCase();
      case "trim": return String(a[0]).trim();
      case "contains":
        if (typeof a[0] === "string") return a[0].includes(display(a[1]));
        need(Array.isArray(a[0]), "text or a list");
        return (a[0] as Value[]).some((x) => equal(x, a[1]));
      case "split": return String(a[0]).split(String(a[1]));
      case "join":
        need(Array.isArray(a[0]), "a list");
        return (a[0] as Value[]).map((v) => display(v)).join(String(a[1]));
      case "str": return display(a[0]);
      case "num": {
        const n = Number(a[0]);
        if (Number.isNaN(n)) this.fail(`num: ${display(a[0], true)} is not a number`, e.pos);
        return n;
      }
      case "round": {
        const f = 10 ** (Number(a[1] ?? 0));
        return Math.round(Number(a[0]) * f) / f;
      }
      case "range": {
        const [from, to] = a.length === 1 ? [0, Number(a[0])] : [Number(a[0]), Number(a[1])];
        if (to - from > 1_000_000) this.fail("range is too large", e.pos);
        return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
      }
      case "push":
        need(Array.isArray(a[0]), "a list");
        return [...(a[0] as Value[]), a[1]];
      case "read_lines": return this.read(e, String(a[0])).split(/\r?\n/).filter((l) => l.trim());
      case "read_csv": return parseCsv(this.read(e, String(a[0]))).map((r) => ({ __rec: true, ...r }) as Rec);
      case "prob": {
        need(isOutcome(a[0]), "an outcome");
        return ((a[0] as Outcome).probabilities as Record<string, number>)[String(a[1])] ?? 0;
      }
    }
    return this.fail(`unknown function '${e.callee}'`, e.pos);
  }

  private read(e: Expr, path: string): string {
    const base = this.p.file.startsWith("<") ? process.cwd() : dirname(resolve(this.p.file));
    try {
      return readFileSync(isAbsolute(path) ? path : resolve(base, path), "utf8");
    } catch (err) {
      return this.fail(`can't read ${path}: ${(err as Error).message}`, e.pos);
    }
  }
}

export { VdError } from "./lexer.js";
export { parse } from "./parser.js";
export { check } from "./checker.js";
