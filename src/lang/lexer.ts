/** Lexer for .vd programs. */

export interface Pos {
  line: number;
  col: number;
  offset: number;
}

export type TokType = "ident" | "kw" | "num" | "str" | "op" | "eof";

/** A string literal is a list of parts: text, or an interpolated expression's raw source. */
export type StrPart = { text: string } | { expr: string; pos: Pos };

export interface Token {
  type: TokType;
  value: string;
  pos: Pos;
  /** A newline separates this token from the previous one (blocks calls across lines). */
  nl: boolean;
  parts?: StrPart[];
}

export const KEYWORDS = new Set([
  "decision", "choice", "noul", "score", "examples", "from", "tiers", "threshold",
  "fn", "let", "if", "else", "for", "in", "while", "return", "match", "decide",
  "true", "false", "and", "or", "not", "uncertain", "builtin", "jet", "nodd",
]);

const OPS = ["=>", "->", "==", "!=", "<=", ">=", "+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "{", "}", "[", "]", ",", ":", ".", "@"];

export class VdError extends Error {
  constructor(
    message: string,
    readonly pos: Pos,
    readonly file = "<input>",
  ) {
    super(message);
    this.name = "VdError";
  }

  /** `file:line:col: message` + the source line with a caret. */
  format(src: string): string {
    const line = src.split(/\r?\n/)[this.pos.line - 1] ?? "";
    return `${this.file}:${this.pos.line}:${this.pos.col}: ${this.message}\n  ${line}\n  ${" ".repeat(Math.max(0, this.pos.col - 1))}^`;
  }
}

export function lex(src: string, file = "<input>", base: Pos = { line: 1, col: 1, offset: 0 }): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = base.line;
  let col = base.col;
  let nl = false;
  const pos = (): Pos => ({ line, col, offset: base.offset + i });
  const adv = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      nl = true;
      adv();
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      adv();
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") adv();
      continue;
    }
    const start = pos();
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      adv(j - i);
      toks.push({ type: KEYWORDS.has(word) ? "kw" : "ident", value: word, pos: start, nl });
      nl = false;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9_]/.test(src[j])) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const raw = src.slice(i, j);
      adv(j - i);
      toks.push({ type: "num", value: raw.replace(/_/g, ""), pos: start, nl });
      nl = false;
      continue;
    }
    if (c === '"') {
      adv();
      const parts: StrPart[] = [];
      let text = "";
      for (;;) {
        if (i >= src.length || src[i] === "\n") throw new VdError("unterminated string", start, file);
        const ch = src[i];
        if (ch === '"') {
          adv();
          break;
        }
        if (ch === "\\") {
          const e = src[i + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", "{": "{", "}": "}" };
          if (!(e in map)) throw new VdError(`unknown escape \\${e ?? ""}`, pos(), file);
          text += map[e];
          adv(2);
          continue;
        }
        if (ch === "{") {
          if (text) parts.push({ text });
          text = "";
          adv();
          const exprPos = pos();
          let depth = 1;
          let expr = "";
          while (i < src.length && src[i] !== "\n") {
            if (src[i] === "{") depth++;
            if (src[i] === "}" && --depth === 0) break;
            expr += src[i];
            adv();
          }
          if (src[i] !== "}") throw new VdError("unterminated {…} in string", exprPos, file);
          adv();
          if (!expr.trim()) throw new VdError("empty {} in string (use \\{ for a literal brace)", exprPos, file);
          parts.push({ expr, pos: exprPos });
          continue;
        }
        text += ch;
        adv();
      }
      if (text || parts.length === 0) parts.push({ text });
      const value = parts.map((p) => ("text" in p ? p.text : `{${p.expr}}`)).join("");
      toks.push({ type: "str", value, pos: start, nl, parts });
      nl = false;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new VdError(`unexpected character '${c}'`, start, file);
    adv(op.length);
    toks.push({ type: "op", value: op, pos: start, nl });
    nl = false;
  }
  toks.push({ type: "eof", value: "end of file", pos: pos(), nl: true });
  return toks;
}
