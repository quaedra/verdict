/** AST for .vd programs. Every node carries its source position for error messages. */
import type { Pos } from "./lexer.js";

export type TypeName =
  | { kind: "text" | "num" | "bool" | "any" | "list" }
  | { kind: "outcome"; decision: string };

export interface TierAst {
  kind: "builtin" | "jet" | "nodd";
  arg?: string;
  pos: Pos;
}

export interface DecisionDecl {
  node: "decision";
  name: string;
  type: "choice" | "noul" | "score";
  instructions: string;
  /** choice options / score levels / noul yes-no descriptions, in order. */
  labels: { name: string; description: string; pos: Pos }[];
  examples: { text: string; label: string; pos: Pos }[];
  examplesFrom: { path: string; pos: Pos }[];
  tiers: TierAst[];
  threshold?: number;
  pos: Pos;
}

export interface FnDecl {
  node: "fn";
  name: string;
  params: { name: string; type: TypeName; pos: Pos }[];
  returns?: TypeName;
  body: Stmt[];
  pos: Pos;
}

export type Stmt =
  | { node: "let"; name: string; value: Expr; pos: Pos }
  | { node: "assign"; name: string; value: Expr; pos: Pos }
  | { node: "if"; cond: Expr; then: Stmt[]; else?: Stmt[]; pos: Pos }
  | { node: "for"; name: string; iter: Expr; body: Stmt[]; pos: Pos }
  | { node: "while"; cond: Expr; body: Stmt[]; pos: Pos }
  | { node: "return"; value?: Expr; pos: Pos }
  | { node: "expr"; expr: Expr; pos: Pos };

export interface Arm {
  label: string; // a decision label or "uncertain"
  guard?: number; // `toxic @ 0.9 => …`
  body: Stmt[]; // value = last expression statement
  pos: Pos;
}

export type Expr =
  | { node: "num"; value: number; pos: Pos }
  | { node: "str"; parts: (string | Expr)[]; pos: Pos }
  | { node: "bool"; value: boolean; pos: Pos }
  | { node: "list"; items: Expr[]; pos: Pos }
  | { node: "var"; name: string; pos: Pos }
  | { node: "unary"; op: "-" | "not"; arg: Expr; pos: Pos }
  | { node: "binary"; op: string; left: Expr; right: Expr; pos: Pos }
  | { node: "call"; callee: string; args: Expr[]; pos: Pos }
  | { node: "field"; target: Expr; name: string; pos: Pos }
  | { node: "index"; target: Expr; index: Expr; pos: Pos }
  | { node: "match"; subject: Expr; arms: Arm[]; pos: Pos }
  | { node: "decide"; input: Expr; entries: { key: string; decision: string; pos: Pos }[]; pos: Pos };

export interface Program {
  file: string;
  decisions: DecisionDecl[];
  fns: FnDecl[];
  main: Stmt[];
}
