/** Recursive-descent parser for .vd programs. */
import type { Arm, DecisionDecl, Expr, FnDecl, Program, Stmt, TierAst, TypeName } from "./ast.js";
import { type Pos, type Token, VdError, lex } from "./lexer.js";

const SIMPLE_TYPES = new Set(["text", "num", "bool", "any", "list"]);

export function parse(src: string, file = "<input>"): Program {
  return new Parser(lex(src, file), file).program();
}

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Token[],
    private readonly file: string,
  ) {}

  // ---------- helpers ----------
  private get t(): Token {
    return this.toks[this.i];
  }
  private peek(n = 1): Token {
    return this.toks[Math.min(this.i + n, this.toks.length - 1)];
  }
  private err(msg: string, pos: Pos = this.t.pos): never {
    throw new VdError(msg, pos, this.file);
  }
  private is(value: string, type?: Token["type"]): boolean {
    return this.t.value === value && (type ? this.t.type === type : this.t.type === "op" || this.t.type === "kw");
  }
  private eat(value: string): boolean {
    if (this.is(value)) {
      this.i++;
      return true;
    }
    return false;
  }
  private describe(t: Token): string {
    return t.type === "eof" ? "end of file" : t.type === "str" ? "a string" : `'${t.value}'`;
  }
  private expect(value: string, what?: string): Token {
    if (!this.is(value)) this.err(`expected ${what ?? `'${value}'`}, found ${this.describe(this.t)}`);
    return this.toks[this.i++];
  }
  private ident(what = "a name"): Token {
    if (this.t.type !== "ident") {
      const hint = this.t.type === "kw" ? ` ('${this.t.value}' is a keyword)` : "";
      this.err(`expected ${what}, found ${this.describe(this.t)}${hint}`);
    }
    return this.toks[this.i++];
  }
  private str(what = "a string"): Token {
    if (this.t.type !== "str") this.err(`expected ${what}, found ${this.describe(this.t)}`);
    if (this.t.parts?.some((p) => "expr" in p)) this.err(`${what} can't contain {…} interpolation`);
    return this.toks[this.i++];
  }
  private num(what = "a number"): number {
    if (this.t.type !== "num") this.err(`expected ${what}, found ${this.describe(this.t)}`);
    return Number(this.toks[this.i++].value);
  }
  private sep() {
    this.eat(",");
  }

  // ---------- program ----------
  program(): Program {
    const p: Program = { file: this.file, decisions: [], fns: [], main: [] };
    while (this.t.type !== "eof") {
      if (this.is("decision")) p.decisions.push(this.decision());
      else if (this.is("fn")) p.fns.push(this.fn());
      else p.main.push(this.stmt());
    }
    return p;
  }

  private decision(): DecisionDecl {
    const pos = this.expect("decision").pos;
    const name = this.ident("a decision name").value;
    this.expect(":");
    const typeTok = this.t;
    if (!["choice", "noul", "score"].includes(typeTok.value) || typeTok.type !== "kw") {
      this.err(`expected a decision type (choice, noul or score), found ${this.describe(typeTok)}`);
    }
    this.i++;
    const instructions = this.str("the question, as a string").value;
    const d: DecisionDecl = {
      node: "decision", name, type: typeTok.value as DecisionDecl["type"], instructions,
      labels: [], examples: [], examplesFrom: [], tiers: [], pos,
    };
    this.expect("{", "'{' to start the decision body");
    while (!this.is("}")) {
      if (this.t.type === "eof") this.err("unclosed decision body", pos);
      if (this.eat("examples")) {
        if (this.eat("from")) {
          d.examplesFrom.push({ path: this.str("a CSV path").value, pos: this.toks[this.i - 1].pos });
          continue;
        }
        this.expect("{", "'{' or 'from' after examples");
        while (!this.is("}")) {
          const text = this.str("an example text");
          this.expect("=>");
          const label = this.t.type === "kw" ? this.err(`'${this.t.value}' is a keyword, not a label`) : this.ident("a label");
          d.examples.push({ text: text.value, label: label.value, pos: text.pos });
          this.sep();
        }
        this.expect("}");
      } else if (this.eat("tiers")) {
        do d.tiers.push(this.tier());
        while (this.eat("->") || this.eat(","));
      } else if (this.eat("threshold")) {
        d.threshold = this.num("a threshold between 0 and 1");
      } else {
        const label = this.ident("a label, examples, tiers or threshold");
        this.expect(":", `':' after label '${label.value}'`);
        d.labels.push({ name: label.value, description: this.str(`a description for '${label.value}'`).value, pos: label.pos });
      }
      this.sep();
    }
    this.expect("}");
    return d;
  }

  private tier(): TierAst {
    const t = this.t;
    if (t.type === "kw" && (t.value === "builtin" || t.value === "jet")) {
      this.i++;
      return { kind: t.value, pos: t.pos, ...(this.t.type === "str" && !this.t.nl ? { arg: this.toks[this.i++].value } : {}) };
    }
    if (t.type === "kw" && t.value === "nodd") {
      this.i++;
      return { kind: "nodd", arg: this.str("the Nodd model folder").value, pos: t.pos };
    }
    return this.err(`expected a tier (builtin, nodd "dir" or jet), found ${this.describe(t)}`);
  }

  private type(): TypeName {
    const t = this.ident("a type (text, num, bool, list, any or a decision name)");
    return SIMPLE_TYPES.has(t.value) ? { kind: t.value as "text" } : { kind: "outcome", decision: t.value };
  }

  private fn(): FnDecl {
    const pos = this.expect("fn").pos;
    const name = this.ident("a function name").value;
    this.expect("(");
    const params: FnDecl["params"] = [];
    while (!this.is(")")) {
      const p = this.ident("a parameter name");
      this.expect(":", `':' and a type after parameter '${p.value}'`);
      params.push({ name: p.value, type: this.type(), pos: p.pos });
      if (!this.eat(",")) break;
    }
    this.expect(")");
    const returns = this.eat("->") ? this.type() : undefined;
    return { node: "fn", name, params, returns, body: this.block(), pos };
  }

  private block(): Stmt[] {
    const open = this.expect("{", "'{'");
    const out: Stmt[] = [];
    while (!this.is("}")) {
      if (this.t.type === "eof") this.err("unclosed '{'", open.pos);
      out.push(this.stmt());
    }
    this.expect("}");
    return out;
  }

  // ---------- statements ----------
  private stmt(): Stmt {
    const pos = this.t.pos;
    if (this.eat("let")) {
      const name = this.ident("a variable name").value;
      this.expect("=");
      return { node: "let", name, value: this.expr(), pos };
    }
    if (this.t.type === "ident" && this.peek().value === "=" && this.peek().type === "op") {
      const name = this.toks[this.i].value;
      this.i += 2;
      return { node: "assign", name, value: this.expr(), pos };
    }
    if (this.eat("if")) return this.ifRest(pos);
    if (this.eat("for")) {
      const name = this.ident("a loop variable").value;
      this.expect("in");
      return { node: "for", name, iter: this.expr(), body: this.block(), pos };
    }
    if (this.eat("while")) return { node: "while", cond: this.expr(), body: this.block(), pos };
    if (this.eat("return")) {
      const bare = this.is("}") || this.t.nl || this.t.type === "eof";
      return { node: "return", value: bare ? undefined : this.expr(), pos };
    }
    return { node: "expr", expr: this.expr(), pos };
  }

  private ifRest(pos: Pos): Stmt {
    const cond = this.expr();
    const then = this.block();
    let els: Stmt[] | undefined;
    if (this.eat("else")) {
      const p = this.t.pos;
      els = this.eat("if") ? [this.ifRest(p)] : this.block();
    }
    return { node: "if", cond, then, else: els, pos };
  }

  // ---------- expressions ----------
  expr(): Expr {
    return this.or();
  }
  private bin(next: () => Expr, ops: string[]): Expr {
    let left = next();
    while (ops.some((o) => this.is(o))) {
      const op = this.toks[this.i++];
      left = { node: "binary", op: op.value, left, right: next(), pos: op.pos };
    }
    return left;
  }
  private or = (): Expr => this.bin(this.and, ["or"]);
  private and = (): Expr => this.bin(this.not, ["and"]);
  private not = (): Expr => {
    if (this.is("not")) {
      const pos = this.toks[this.i++].pos;
      return { node: "unary", op: "not", arg: this.not(), pos };
    }
    return this.cmp();
  };
  private cmp = (): Expr => this.bin(this.add, ["==", "!=", "<=", ">=", "<", ">"]);
  private add = (): Expr => this.bin(this.mul, ["+", "-"]);
  private mul = (): Expr => this.bin(this.unary, ["*", "/", "%"]);
  private unary = (): Expr => {
    if (this.is("-")) {
      const pos = this.toks[this.i++].pos;
      return { node: "unary", op: "-", arg: this.unary(), pos };
    }
    return this.postfix();
  };

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.is(".")) {
        const pos = this.toks[this.i++].pos;
        // Keywords are fine as field names (o.score).
        const name = this.t.type === "kw" ? this.toks[this.i++].value : this.ident("a field name").value;
        e = { node: "field", target: e, name, pos };
      } else if (this.is("[") && !this.t.nl) {
        const pos = this.toks[this.i++].pos;
        const index = this.expr();
        this.expect("]");
        e = { node: "index", target: e, index, pos };
      } else return e;
    }
  }

  private primary(): Expr {
    const t = this.t;
    if (t.type === "num") {
      this.i++;
      return { node: "num", value: Number(t.value), pos: t.pos };
    }
    if (t.type === "str") {
      this.i++;
      const parts = t.parts!.map((p) => {
        if ("text" in p) return p.text;
        const sub = new Parser(lex(p.expr, this.file, p.pos), this.file);
        const e = sub.expr();
        if (sub.t.type !== "eof") sub.err(`unexpected ${sub.describe(sub.t)} in {…}`);
        return e;
      });
      return { node: "str", parts, pos: t.pos };
    }
    if (this.eat("true")) return { node: "bool", value: true, pos: t.pos };
    if (this.eat("false")) return { node: "bool", value: false, pos: t.pos };
    if (this.eat("(")) {
      const e = this.expr();
      this.expect(")");
      return e;
    }
    if (this.eat("[")) {
      const items: Expr[] = [];
      while (!this.is("]")) {
        items.push(this.expr());
        if (!this.eat(",")) break;
      }
      this.expect("]");
      return { node: "list", items, pos: t.pos };
    }
    if (this.eat("match")) return this.match(t.pos);
    if (this.eat("decide")) return this.decide(t.pos);
    if (t.type === "ident") {
      this.i++;
      if (this.is("(") && !this.t.nl) {
        this.i++;
        const args: Expr[] = [];
        while (!this.is(")")) {
          args.push(this.expr());
          if (!this.eat(",")) break;
        }
        this.expect(")");
        return { node: "call", callee: t.value, args, pos: t.pos };
      }
      return { node: "var", name: t.value, pos: t.pos };
    }
    return this.err(`expected an expression, found ${this.describe(t)}`);
  }

  private match(pos: Pos): Expr {
    const subject = this.expr();
    this.expect("{", "'{' to start the match arms");
    const arms: Arm[] = [];
    while (!this.is("}")) {
      if (this.t.type === "eof") this.err("unclosed match", pos);
      const lt = this.t;
      let label: string;
      if (lt.type === "kw" && lt.value === "uncertain") label = "uncertain";
      else label = this.ident("a label or 'uncertain'").value;
      if (lt.type === "kw") this.i++;
      let guard: number | undefined;
      if (this.eat("@")) guard = this.num("a probability after '@'");
      this.expect("=>", "'=>' after the arm label");
      const body: Stmt[] = this.is("{") ? this.block() : [{ node: "expr", expr: this.expr(), pos: this.t.pos }];
      arms.push({ label, guard, body, pos: lt.pos });
      this.sep();
    }
    this.expect("}");
    return { node: "match", subject, arms, pos };
  }

  private decide(pos: Pos): Expr {
    const input = this.expr();
    this.expect("{", "'{' and the decisions to run");
    const entries: { key: string; decision: string; pos: Pos }[] = [];
    while (!this.is("}")) {
      const k = this.ident("a decision name");
      const decision = this.eat(":") ? this.ident("a decision name").value : k.value;
      entries.push({ key: k.value, decision, pos: k.pos });
      this.sep();
    }
    this.expect("}");
    return { node: "decide", input, entries, pos };
  }
}
