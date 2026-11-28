// The syntax tree of the bash parser (D3). Words are lists of parts; the
// interpreter expands them in the bash order.

export type WordPart =
  /** Unquoted literal text. Globs and braces stay active. */
  | { k: "lit"; v: string }
  /** Quoted literal text ('...', $'...', or a backslash escape). */
  | { k: "sq"; v: string }
  | { k: "dq"; parts: WordPart[] }
  | ParamPart
  | { k: "cmd"; script: Script; src: string }
  | { k: "arith"; expr: Word }
  | { k: "proc"; dir: "<" | ">"; script: Script }
  /** `name=(a b)` as an argument of declare, local, export, readonly. */
  | { k: "arr"; items: ArrayItem[] };

export type Word = WordPart[];

export interface ParamPart {
  k: "param";
  /** Variable name, digits, or one of @ * # ? - $ ! _ 0. */
  name: string;
  /** `[idx]` of an array reference; "@" and "*" for all items. */
  idx?: Word | "@" | "*";
  /** `${#name}` */
  len?: boolean;
  /** `${!name}` (indirect) or `${!name[@]}` (keys) */
  bang?: boolean;
  /** :- - := = :? ? :+ + # ## % %% / // /# /% : ^ ^^ , ,, */
  op?: string;
  arg?: Word;
  arg2?: Word;
}

export interface ArrayItem {
  key?: Word;
  value: Word;
}

export interface Assign {
  name: string;
  idx?: Word;
  append: boolean;
  value: Word | null;
  array?: ArrayItem[];
}

export type RedirOp =
  ">" | ">>" | "<" | ">&" | "<&" | "<>" | ">|" | "&>" | "&>>" | "<<" | "<<<";

export interface Redir {
  /** File descriptor on the left, if written. */
  fd?: number;
  op: RedirOp;
  target: Word;
  heredoc?: { body: Word; strip: boolean; quoted: boolean };
}

interface Base {
  line: number;
  redirs?: Redir[];
  bg?: boolean;
  /** The source text of a node that ends with `&`, for the job table (B9). */
  text?: string;
}

export interface Simple extends Base {
  type: "simple";
  assigns: Assign[];
  words: Word[];
}
export interface Pipeline extends Base {
  type: "pipeline";
  negate: boolean;
  cmds: Node[];
}
export interface AndOr extends Base {
  type: "andor";
  first: Node;
  rest: { op: "&&" | "||"; node: Node }[];
}
export interface If extends Base {
  type: "if";
  clauses: { cond: Node[]; body: Node[] }[];
  else: Node[] | null;
}
export interface Case extends Base {
  type: "case";
  word: Word;
  clauses: { patterns: Word[]; body: Node[]; term: ";;" | ";&" | ";;&" }[];
}
export interface For extends Base {
  type: "for";
  name: string;
  words: Word[] | null;
  body: Node[];
  /** `select NAME in WORDS` (B4): the same shape, a menu loop. */
  select?: true;
}
export interface CFor extends Base {
  type: "cfor";
  init: Word;
  cond: Word;
  step: Word;
  body: Node[];
}
export interface While extends Base {
  type: "while" | "until";
  cond: Node[];
  body: Node[];
}
export interface Group extends Base {
  type: "group";
  body: Node[];
}
export interface Subshell extends Base {
  type: "subshell";
  body: Node[];
}
export interface FunctionDef extends Base {
  type: "function";
  name: string;
  body: Node;
  src: string;
}
export interface ArithCmd extends Base {
  type: "arith";
  expr: Word;
}
export interface CondCmd extends Base {
  type: "cond";
  expr: CondExpr;
}

export type CondExpr =
  | { op: "&&" | "||"; l: CondExpr; r: CondExpr }
  | { op: "!"; e: CondExpr }
  | { op: "unary"; flag: string; w: Word }
  | { op: "binary"; cmp: string; l: Word; r: Word }
  | { op: "word"; w: Word };

export type Node =
  | Simple
  | Pipeline
  | AndOr
  | If
  | Case
  | For
  | CFor
  | While
  | Group
  | Subshell
  | FunctionDef
  | ArithCmd
  | CondCmd;

export interface Script {
  type: "script";
  items: Node[];
}
