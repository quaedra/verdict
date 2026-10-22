/**
 * Static checker for .vd programs. Runs before anything executes and reports every
 * problem it finds, not just the first. The core guarantee: a `match` on a decision
 * handles every label and `uncertain`, and only those.
 */
import type { DecisionDecl, Expr, FnDecl, Program, Stmt, TypeName } from "./ast.js";
import { type Pos, VdError } from "./lexer.js";

export type Ty =
  | { k: "text"; labelsOf?: string } // labelsOf: this text is a label of that decision
  | { k: "num" }
  | { k: "bool" }
  | { k: "void" }
  | { k: "any" }
  | { k: "list"; of: Ty }
  | { k: "outcome"; d: string }
  | { k: "record"; fields: Record<string, Ty> };

const T = {
  text: { k: "text" } as Ty,
  num: { k: "num" } as Ty,
  bool: { k: "bool" } as Ty,
  void: { k: "void" } as Ty,
  any: { k: "any" } as Ty,
  list: (of: Ty = { k: "any" }): Ty => ({ k: "list", of }),
};

export function show(t: Ty): string {
  switch (t.k) {
    case "list": return t.of.k === "any" ? "list" : `list of ${show(t.of)}`;
    case "outcome": return `${t.d} outcome`;
    case "record": return `{${Object.entries(t.fields).map(([k, v]) => `${k}: ${show(v)}`).join(", ")}}`;
    default: return t.k;
  }
}

function fits(actual: Ty, expected: Ty): boolean {
  if (actual.k === "any" || expected.k === "any") return true;
  if (actual.k !== expected.k) return false;
  if (actual.k === "outcome") return actual.d === (expected as { d: string }).d;
  if (actual.k === "list") return fits(actual.of, (expected as { of: Ty }).of);
  return true;
}

function same(a: Ty, b: Ty): boolean {
  return fits(a, b) && fits(b, a);
}

/** Built-in functions: [min args, max args, arg type (or any), return type]. */
export const BUILTINS: Record<string, { min: number; max: number; args?: Ty[]; ret: (args: Ty[]) => Ty; doc: string }> = {
  print: { min: 0, max: Infinity, ret: () => T.void, doc: "print(values…) — print a line" },
  len: { min: 1, max: 1, ret: () => T.num, doc: "len(text | list)" },
  lower: { min: 1, max: 1, args: [T.text], ret: () => T.text, doc: "lower(text)" },
  upper: { min: 1, max: 1, args: [T.text], ret: () => T.text, doc: "upper(text)" },
  trim: { min: 1, max: 1, args: [T.text], ret: () => T.text, doc: "trim(text)" },
  contains: { min: 2, max: 2, ret: () => T.bool, doc: "contains(text | list, value)" },
  split: { min: 2, max: 2, args: [T.text, T.text], ret: () => T.list(T.text), doc: "split(text, sep)" },
  join: { min: 2, max: 2, args: [T.list(), T.text], ret: () => T.text, doc: "join(list, sep)" },
  str: { min: 1, max: 1, ret: () => T.text, doc: "str(value) — to text" },
  num: { min: 1, max: 1, ret: () => T.num, doc: "num(text) — to number" },
  round: { min: 1, max: 2, args: [T.num, T.num], ret: () => T.num, doc: "round(n, digits?)" },
  range: { min: 1, max: 2, args: [T.num, T.num], ret: () => T.list(T.num), doc: "range(n) or range(from, to)" },
  push: { min: 2, max: 2, ret: (a) => a[0], doc: "push(list, value) — new list with value appended" },
  read_lines: { min: 1, max: 1, args: [T.text], ret: () => T.list(T.text), doc: "read_lines(path) — non-empty lines" },
  read_csv: { min: 1, max: 1, args: [T.text], ret: () => T.list(T.any), doc: "read_csv(path) — rows as records" },
  prob: { min: 2, max: 2, args: [T.any, T.text], ret: () => T.num, doc: "prob(outcome, \"label\") — p(label)" },
};

const OUTCOME_FIELDS: Record<string, Ty> = {
  label: T.text, confidence: T.num, certain: T.bool, source: T.text, score: T.num, latency_ms: T.num,
};

const NAME = /^[a-z][a-z0-9_]*$/;

interface Scope {
  vars: Map<string, Ty>;
  parent?: Scope;
}

export interface Checked {
  program: Program;
  /** Resolved decision labels by name, in order. */
  labels: Map<string, string[]>;
}

export class Checker {
  private errors: VdError[] = [];
  private decisions = new Map<string, DecisionDecl>();
  private fns = new Map<string, FnDecl>();
  private fnReturn: Ty[] | null = null;

  constructor(private readonly p: Program) {}

  private err(msg: string, pos: Pos) {
    this.errors.push(new VdError(msg, pos, this.p.file));
  }

  check(): { errors: VdError[]; checked: Checked } {
    const labels = new Map<string, string[]>();
    for (const d of this.p.decisions) {
      if (this.decisions.has(d.name)) this.err(`decision '${d.name}' is declared twice`, d.pos);
      this.decisions.set(d.name, d);
      labels.set(d.name, this.checkDecision(d));
    }
    for (const f of this.p.fns) {
      if (this.fns.has(f.name) || this.decisions.has(f.name) || f.name in BUILTINS) {
        this.err(`'${f.name}' is already defined${f.name in BUILTINS ? " as a built-in" : ""}`, f.pos);
      }
      this.fns.set(f.name, f);
    }
    for (const f of this.p.fns) this.checkFn(f);
    this.block(this.p.main, { vars: new Map() });
    this.errors.sort((a, b) => a.pos.offset - b.pos.offset);
    return { errors: this.errors, checked: { program: this.p, labels } };
  }

  // ---------- decisions ----------
  private checkDecision(d: DecisionDecl): string[] {
    if (!NAME.test(d.name)) this.err(`decision name '${d.name}' must be snake_case`, d.pos);
    if (d.name in BUILTINS) this.err(`'${d.name}' is a built-in function`, d.pos);
    if (!d.instructions.trim()) this.err("the question can't be empty", d.pos);
    const seen = new Set<string>();
    for (const l of d.labels) {
      if (seen.has(l.name)) this.err(`label '${l.name}' is declared twice`, l.pos);
      seen.add(l.name);
      if (!NAME.test(l.name)) this.err(`label '${l.name}' must be snake_case`, l.pos);
    }
    let labels = d.labels.map((l) => l.name);
    if (d.type === "noul") {
      for (const l of d.labels) if (l.name !== "yes" && l.name !== "no") this.err(`a noul decision only has 'yes' and 'no', not '${l.name}'`, l.pos);
      labels = ["no", "yes"];
    } else if (d.type === "choice" && (labels.length < 2 || labels.length > 255)) {
      this.err(`a choice needs 2–255 options, '${d.name}' has ${labels.length}`, d.pos);
    } else if (d.type === "score" && (labels.length < 2 || labels.length > 10)) {
      this.err(`a score needs 2–10 levels (low → high), '${d.name}' has ${labels.length}`, d.pos);
    }
    for (const e of d.examples) {
      if (!labels.includes(e.label)) this.err(`'${e.label}' is not a label of ${d.name} (labels: ${labels.join(", ")})`, e.pos);
    }
    if (d.threshold !== undefined && !(d.threshold > 0 && d.threshold <= 1)) this.err("threshold must be in (0, 1]", d.pos);
    const hasExamples = d.examples.length > 0 || d.examplesFrom.length > 0;
    for (const t of d.tiers) {
      if (t.kind === "builtin" && !hasExamples) this.err(`the builtin tier learns from examples, but ${d.name} has none`, t.pos);
      if (t.kind === "nodd" && d.type === "score") this.err("Nodd models are classifiers; use builtin or jet for score decisions", t.pos);
    }
    return labels;
  }

  // ---------- functions ----------
  private tyOf(t: TypeName, pos: Pos): Ty {
    if (t.kind === "outcome") {
      if (!this.decisions.has(t.decision)) {
        this.err(`unknown type '${t.decision}' (types: text, num, bool, list, any, or a decision name)`, pos);
        return T.any;
      }
      return { k: "outcome", d: t.decision };
    }
    return t.kind === "list" ? T.list() : ({ k: t.kind } as Ty);
  }

  private checkFn(f: FnDecl) {
    const scope: Scope = { vars: new Map() };
    for (const p of f.params) {
      if (scope.vars.has(p.name)) this.err(`parameter '${p.name}' is declared twice`, p.pos);
      scope.vars.set(p.name, this.tyOf(p.type, p.pos));
    }
    this.fnReturn = [];
    const last = this.block(f.body, scope);
    const returns = this.fnReturn;
    this.fnReturn = null;
    if (f.returns) {
      const want = this.tyOf(f.returns, f.pos);
      const tail = f.body.at(-1);
      // The last expression is the implicit return value, like a match arm.
      const all = [...returns, ...(tail && tail.node === "expr" ? [last] : [])];
      if (!all.length) this.err(`'${f.name}' says it returns ${show(want)} but never returns a value`, f.pos);
      for (const r of all) if (!fits(r, want)) this.err(`'${f.name}' returns ${show(r)}, but its signature says ${show(want)}`, f.pos);
    }
  }

  fnReturnType(f: FnDecl): Ty {
    return f.returns ? this.tyOf(f.returns, f.pos) : T.any;
  }

  // ---------- statements ----------
  /** Returns the type of the block's value (its last expression statement), else void. */
  private block(stmts: Stmt[], parent: Scope): Ty {
    const scope: Scope = { vars: new Map(), parent };
    let last: Ty = T.void;
    for (const s of stmts) last = this.stmt(s, scope);
    return last;
  }

  private lookup(scope: Scope | undefined, name: string): Ty | undefined {
    for (let s = scope; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
    return undefined;
  }

  private stmt(s: Stmt, scope: Scope): Ty {
    switch (s.node) {
      case "let": {
        if (scope.vars.has(s.name)) this.err(`'${s.name}' is already declared in this block (use '${s.name} = …' to change it)`, s.pos);
        if (this.decisions.has(s.name) || this.fns.has(s.name)) this.err(`'${s.name}' is a ${this.decisions.has(s.name) ? "decision" : "function"} name`, s.pos);
        const t = this.expr(s.value, scope);
        if (t.k === "void") this.err("this expression has no value", s.value.pos);
        scope.vars.set(s.name, t);
        return T.void;
      }
      case "assign": {
        const cur = this.lookup(scope, s.name);
        if (!cur) this.err(`'${s.name}' is not declared (use 'let ${s.name} = …')`, s.pos);
        const t = this.expr(s.value, scope);
        if (cur && !fits(t, cur)) this.err(`'${s.name}' is ${show(cur)}, can't assign ${show(t)}`, s.pos);
        return T.void;
      }
      case "if": {
        this.cond(s.cond, scope, "if");
        this.block(s.then, scope);
        if (s.else) this.block(s.else, scope);
        return T.void;
      }
      case "while":
        this.cond(s.cond, scope, "while");
        this.block(s.body, scope);
        return T.void;
      case "for": {
        const it = this.expr(s.iter, scope);
        if (it.k !== "list" && it.k !== "any") this.err(`'for' needs a list, got ${show(it)}`, s.iter.pos);
        const inner: Scope = { vars: new Map([[s.name, it.k === "list" ? it.of : T.any]]), parent: scope };
        this.block(s.body, inner);
        return T.void;
      }
      case "return": {
        if (!this.fnReturn) this.err("'return' outside a function", s.pos);
        const t = s.value ? this.expr(s.value, scope) : T.void;
        this.fnReturn?.push(t);
        return T.void;
      }
      case "expr":
        return this.expr(s.expr, scope);
    }
  }

  private cond(e: Expr, scope: Scope, what: string) {
    const t = this.expr(e, scope);
    if (t.k !== "bool" && t.k !== "any") {
      const hint = t.k === "outcome" ? " — use match to branch on a decision" : "";
      this.err(`'${what}' needs a bool, got ${show(t)}${hint}`, e.pos);
    }
  }

  // ---------- expressions ----------
  private expr(e: Expr, scope: Scope): Ty {
    switch (e.node) {
      case "num": return T.num;
      case "bool": return T.bool;
      case "str":
        for (const p of e.parts) if (typeof p !== "string") this.expr(p, scope);
        return T.text;
      case "list": {
        const items = e.items.map((i) => this.expr(i, scope));
        const of = items.length && items.every((t) => same(t, items[0])) ? items[0] : T.any;
        return T.list(of);
      }
      case "var": {
        const t = this.lookup(scope, e.name);
        if (t) return t;
        if (this.decisions.has(e.name)) this.err(`'${e.name}' is a decision — call it with an input: ${e.name}(text)`, e.pos);
        else if (this.fns.has(e.name) || e.name in BUILTINS) this.err(`'${e.name}' is a function — call it: ${e.name}(…)`, e.pos);
        else this.err(`'${e.name}' is not defined`, e.pos);
        return T.any;
      }
      case "unary": {
        const t = this.expr(e.arg, scope);
        const want = e.op === "-" ? T.num : T.bool;
        if (!fits(t, want)) this.err(`'${e.op}' needs ${show(want)}, got ${show(t)}`, e.pos);
        return want;
      }
      case "binary": return this.binary(e, scope);
      case "call": return this.call(e, scope);
      case "field": {
        const t = this.expr(e.target, scope);
        if (t.k === "outcome") {
          if (!(e.name in OUTCOME_FIELDS)) {
            this.err(`an outcome has no '${e.name}' (fields: ${Object.keys(OUTCOME_FIELDS).join(", ")})`, e.pos);
            return T.any;
          }
          if (e.name === "score" && this.decisions.get(t.d)?.type !== "score") this.err(`'score' only exists on score decisions; ${t.d} is a ${this.decisions.get(t.d)?.type}`, e.pos);
          return e.name === "label" ? { k: "text", labelsOf: t.d } : OUTCOME_FIELDS[e.name];
        }
        if (t.k === "record") {
          if (!(e.name in t.fields)) this.err(`no field '${e.name}' (fields: ${Object.keys(t.fields).join(", ")})`, e.pos);
          return t.fields[e.name] ?? T.any;
        }
        if (t.k !== "any") this.err(`${show(t)} has no fields`, e.pos);
        return T.any;
      }
      case "index": {
        const t = this.expr(e.target, scope);
        const i = this.expr(e.index, scope);
        if (t.k === "list") {
          if (!fits(i, T.num)) this.err(`list index must be a number, got ${show(i)}`, e.index.pos);
          return t.of;
        }
        if (t.k === "text") return T.text;
        if (t.k !== "any") this.err(`can't index ${show(t)}`, e.pos);
        return T.any;
      }
      case "match": return this.match(e, scope);
      case "decide": {
        const it = this.expr(e.input, scope);
        if (!fits(it, T.text)) this.err(`decisions take text, got ${show(it)}`, e.input.pos);
        const fields: Record<string, Ty> = {};
        for (const en of e.entries) {
          if (en.key in fields) this.err(`'${en.key}' appears twice`, en.pos);
          if (!this.decisions.has(en.decision)) this.err(`'${en.decision}' is not a decision`, en.pos);
          fields[en.key] = this.decisions.has(en.decision) ? { k: "outcome", d: en.decision } : T.any;
        }
        if (!e.entries.length) this.err("'decide' needs at least one decision", e.pos);
        return { k: "record", fields };
      }
    }
  }

  private binary(e: Extract<Expr, { node: "binary" }>, scope: Scope): Ty {
    const l = this.expr(e.left, scope);
    const r = this.expr(e.right, scope);
    const bad = () => this.err(`can't use '${e.op}' on ${show(l)} and ${show(r)}`, e.pos);
    switch (e.op) {
      case "and":
      case "or":
        if (!fits(l, T.bool) || !fits(r, T.bool)) bad();
        return T.bool;
      case "==":
      case "!=": {
        // Comparing a decision's label to a literal: the literal must be one of its labels.
        for (const [lab, other] of [[l, e.right], [r, e.left]] as const) {
          if (lab.k === "text" && lab.labelsOf && other.node === "str" && other.parts.length === 1 && typeof other.parts[0] === "string") {
            const labels = this.labelsOf(lab.labelsOf);
            if (!labels.includes(other.parts[0])) this.err(`"${other.parts[0]}" is never a label of ${lab.labelsOf} (labels: ${labels.join(", ")})`, other.pos);
          }
        }
        if (!fits(l, r) && !fits(r, l)) bad();
        return T.bool;
      }
      case "<": case ">": case "<=": case ">=":
        if (!(fits(l, T.num) && fits(r, T.num)) && !(fits(l, T.text) && fits(r, T.text))) bad();
        return T.bool;
      case "+":
        if (l.k === "text" || r.k === "text") return T.text;
        if (l.k === "list" && fits(r, T.list())) return l;
        if (!fits(l, T.num) || !fits(r, T.num)) bad();
        return l.k === "any" || r.k === "any" ? T.any : T.num;
      default:
        if (!fits(l, T.num) || !fits(r, T.num)) bad();
        return T.num;
    }
  }

  labelsOf(d: string): string[] {
    const decl = this.decisions.get(d);
    if (!decl) return [];
    return decl.type === "noul" ? ["no", "yes"] : decl.labels.map((l) => l.name);
  }

  private call(e: Extract<Expr, { node: "call" }>, scope: Scope): Ty {
    const args = e.args.map((a) => this.expr(a, scope));
    if (this.lookup(scope, e.callee)) {
      this.err(`'${e.callee}' is a variable, not a function`, e.pos);
      return T.any;
    }
    const d = this.decisions.get(e.callee);
    if (d) {
      if (args.length !== 1) this.err(`decision ${d.name} takes one text input, got ${args.length} arguments`, e.pos);
      else if (!fits(args[0], T.text)) this.err(`decision ${d.name} takes text, got ${show(args[0])}`, e.args[0].pos);
      return { k: "outcome", d: d.name };
    }
    const f = this.fns.get(e.callee);
    if (f) {
      if (args.length !== f.params.length) this.err(`${f.name} takes ${f.params.length} argument${f.params.length === 1 ? "" : "s"}, got ${args.length}`, e.pos);
      f.params.forEach((p, i) => {
        if (i >= args.length) return;
        const want = this.tyOf(p.type, p.pos);
        if (!fits(args[i], want)) this.err(`${f.name}: '${p.name}' is ${show(want)}, got ${show(args[i])}`, e.args[i].pos);
      });
      return this.fnReturnType(f);
    }
    const b = BUILTINS[e.callee];
    if (b) {
      if (args.length < b.min || args.length > b.max) this.err(`${b.doc} — got ${args.length} argument${args.length === 1 ? "" : "s"}`, e.pos);
      b.args?.forEach((want, i) => {
        if (i < args.length && !fits(args[i], want)) this.err(`${e.callee}: argument ${i + 1} should be ${show(want)}, got ${show(args[i])}`, e.args[i].pos);
      });
      if (e.callee === "prob" && args[0]?.k === "outcome") {
        const lit = e.args[1];
        const labels = this.labelsOf(args[0].d);
        if (lit?.node === "str" && typeof lit.parts[0] === "string" && lit.parts.length === 1 && !labels.includes(lit.parts[0])) {
          this.err(`"${lit.parts[0]}" is not a label of ${args[0].d} (labels: ${labels.join(", ")})`, lit.pos);
        }
      } else if (e.callee === "prob" && args[0] && args[0].k !== "any") this.err(`prob() needs an outcome, got ${show(args[0])}`, e.args[0].pos);
      return b.ret(args);
    }
    this.err(`'${e.callee}' is not a function, decision or built-in`, e.pos);
    return T.any;
  }

  private match(e: Extract<Expr, { node: "match" }>, scope: Scope): Ty {
    const subj = this.expr(e.subject, scope);
    if (subj.k !== "outcome") {
      const hint = subj.k === "any" ? " — give the parameter a decision type, e.g. (o: comment_moderation)" : "";
      this.err(`match needs a decision outcome, got ${show(subj)}${hint}`, e.subject.pos);
      for (const a of e.arms) this.block(a.body, scope);
      return T.any;
    }
    const labels = this.labelsOf(subj.d);
    const seen = new Set<string>();
    const types: Ty[] = [];
    for (const a of e.arms) {
      // Several arms per label are fine while the earlier ones are guarded:
      // `high @ 0.8 => …` then `high => …` — first passing guard wins.
      if (seen.has(a.label)) {
        const earlier = e.arms.slice(0, e.arms.indexOf(a)).filter((x) => x.label === a.label);
        if (earlier.some((x) => x.guard === undefined)) this.err(`'${a.label}' is already handled above without a guard, so this arm never runs`, a.pos);
      }
      seen.add(a.label);
      if (a.label !== "uncertain" && !labels.includes(a.label)) {
        this.err(`'${a.label}' is not a label of ${subj.d} (labels: ${labels.join(", ")})`, a.pos);
      }
      if (a.guard !== undefined) {
        if (a.label === "uncertain") this.err("'uncertain' can't have a guard", a.pos);
        else if (!(a.guard > 0 && a.guard <= 1)) this.err(`guard must be in (0, 1], got ${a.guard}`, a.pos);
      }
      types.push(this.block(a.body, scope));
    }
    const missing = labels.filter((l) => !seen.has(l));
    if (missing.length) this.err(`match on ${subj.d} doesn't handle: ${missing.join(", ")}`, e.pos);
    if (!seen.has("uncertain")) {
      this.err(`match on ${subj.d} needs an 'uncertain' arm — what should happen when no tier is confident?`, e.pos);
    }
    const valued = types.filter((t) => t.k !== "void");
    return valued.length === types.length && valued.every((t) => same(t, valued[0])) ? valued[0] : T.any;
  }
}

export function check(p: Program) {
  return new Checker(p).check();
}
