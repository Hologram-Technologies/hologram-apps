// holo-forge.mjs — a real, deterministic Holo-C → WebAssembly compiler, in pure JavaScript,
// with ZERO dependencies, running identically in Node and the browser. This is the engine of
// Holo Forge (ADR-0051): the COMPILER ITSELF is a content-addressed UOR object, and a build is
// a re-derivable κ-transform —  κ(source) ⊕ κ(compiler) ⊕ κ(flags) → κ(artifact)  — so any peer
// can re-run the compile and verify the output byte-for-byte, with no build server to trust.
//
// The whole point is REPRODUCIBILITY: identical source bytes ⇒ identical WebAssembly bytes, on
// every machine, forever (no timestamps, no randomness, no host paths, no ordering by hash-map
// iteration — functions, types and exports are emitted in deterministic source order). That is
// what makes a build a self-verifying observation on the κ-graph (Law L5), exactly like every
// other object in the OS. This module computes NO hashes — it is the pure transform; the κ /
// receipt layer (holo-uor.mjs in Node, WebCrypto in the browser) hashes its byte-stable output.
//
// Holo-C is a small but real subset of C: int- and void-typed functions, parameters and locals, the
// full arithmetic / relational / logical / bitwise / shift operator set (+ - * / %, < <= > >= == !=,
// && || !, & | ^ << >>) with C precedence and short-circuit && / ||, the ternary ?: conditional,
// if / else, while, return, and function calls (mutual recursion allowed). A minimal preprocessor
// (#include strip + object-like #define) and the fixed-width integer types (uint8_t/uint32_t/… → i32,
// with (cast) syntax) let real, header-free vendored C compile verbatim. Every integer value is a
// 32-bit signed integer; every function is exported. It emits a spec-valid WebAssembly module binary
// (no Emscripten, no toolchain, no WASI imports — pure compute that runs in any engine).
//
// Authorities: WebAssembly Core Specification 2.0 (W3C, the binary format emitted here) ·
// IEEE-754-free integer semantics of WASM i32 · the κ-transform reproducibility property is the
// product realization of the engine's deterministic content-addressed executor (run_holo, ADR-008).

export const VERSION = "holo-forge/1.2.0 · holo-c → wasm-core-2.0";
export const LANG = "holo-c";

// ─────────────────────────────────────────── errors ───────────────────────────────────────────
export class CompileError extends Error {
  constructor(message, line, col) {
    super(line ? `${message} (line ${line}:${col})` : message);
    this.name = "CompileError";
    this.line = line; this.col = col;
  }
}

// ───────────────────────────────────────────── lexer ──────────────────────────────────────────
const KEYWORDS = new Set(["int", "if", "else", "while", "return"]);
// multi-char operators first so the longest match wins (<< before <, && before &, || before |)
const OPS = ["==", "!=", "<=", ">=", "<<", ">>", "&&", "||", "&", "|", "^", "?", ":", "+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "{", "}", ",", ";", "!"];
// binary-operator precedence — lower binds looser (C order); all left-associative. Ternary ?: sits
// below || (handled in parseExpr, right-associative). Bitwise | ^ & sit below equality, shifts above it.
const BINOP = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, "<=": 7, ">": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };

// ── minimal C preprocessor ──
// Strips #include lines and expands object-like #define macros, so REAL vendored C (e.g. a header-
// free translation unit like UOR-Foundation's minimal_wrapper.c) can be compiled verbatim. IDENTITY
// when the source has no `#` directives — so every existing Holo-C program compiles to byte-for-byte
// identical wasm. Object-like defines only (no function macros, no #if); other directives are dropped.
function preprocess(src) {
  if (!/^[ \t]*#/m.test(src)) return src;                       // no directives ⇒ unchanged bytes
  const defs = [];
  const kept = src.split("\n").filter((ln) => {
    if (/^[ \t]*#[ \t]*include\b/.test(ln)) return false;
    const m = ln.match(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+(.+?)[ \t]*$/);
    if (m) { defs.push([m[1], m[2]]); return false; }
    return !/^[ \t]*#/.test(ln);                                // drop any other directive (#ifndef/#endif/#pragma…)
  });
  let out = kept.join("\n");
  for (const [name, value] of defs) out = out.replace(new RegExp("\\b" + name + "\\b", "g"), () => value);
  return out;
}

function tokenize(src) {
  const toks = [];
  let i = 0, line = 1, col = 1;
  const at = () => src[i];
  const adv = (n = 1) => { for (let k = 0; k < n; k++) { if (src[i] === "\n") { line++; col = 1; } else col++; i++; } };
  while (i < src.length) {
    const c = at();
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { adv(); continue; }
    // comments: // line  and  /* block */
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && at() !== "\n") adv(); continue; }
    if (c === "/" && src[i + 1] === "*") {
      adv(2);
      while (i < src.length && !(at() === "*" && src[i + 1] === "/")) adv();
      if (i >= src.length) throw new CompileError("unterminated /* comment", line, col);
      adv(2); continue;
    }
    const startLine = line, startCol = col;
    // number: decimal or 0x-hex
    if (c >= "0" && c <= "9") {
      let s = "";
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        s = "0x"; adv(2);
        while (i < src.length && /[0-9a-fA-F]/.test(at())) { s += at(); adv(); }
        if (s.length <= 2) throw new CompileError("malformed hex literal", startLine, startCol);
      } else {
        while (i < src.length && at() >= "0" && at() <= "9") { s += at(); adv(); }
      }
      if (i < src.length && /[A-Za-z_]/.test(at())) throw new CompileError("invalid number", startLine, startCol);
      const v = Number(s);
      if (!Number.isFinite(v)) throw new CompileError("invalid number", startLine, startCol);
      toks.push({ t: "num", v: v | 0, line: startLine, col: startCol });
      continue;
    }
    // identifier / keyword
    if (/[A-Za-z_]/.test(c)) {
      let s = "";
      while (i < src.length && /[A-Za-z0-9_]/.test(at())) { s += at(); adv(); }
      toks.push({ t: KEYWORDS.has(s) ? s : "id", v: s, line: startLine, col: startCol });
      continue;
    }
    // operator / punctuation
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new CompileError(`unexpected character '${c}'`, startLine, startCol);
    adv(op.length);
    toks.push({ t: op, v: op, line: startLine, col: startCol });
  }
  toks.push({ t: "eof", v: "", line, col });
  return toks;
}

// ──────────────────────────────────────────── parser ──────────────────────────────────────────
// Recursive-descent + precedence-climbing. Produces a plain AST (no host objects), so the parse
// of identical source is byte-for-byte identical regardless of platform.
function parse(src) {
  const toks = tokenize(preprocess(src));
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isAt = (t) => toks[p].t === t;
  const eat = (t) => { const tok = toks[p]; if (tok.t !== t) throw new CompileError(`expected '${t}' but found '${tok.v || tok.t}'`, tok.line, tok.col); p++; return tok; };

  // C integer type keywords — all are the one machine type here (i32). `void` is its own kind.
  const INT_TYPES = new Set(["int", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t",
    "int32_t", "int64_t", "uintptr_t", "intptr_t", "size_t", "unsigned", "signed", "long", "short", "char"]);
  const isTypeTok = (tok) => tok.t === "int" || (tok.t === "id" && (INT_TYPES.has(tok.v) || tok.v === "void"));
  const eatType = () => { const tok = peek();
    if (tok.t === "int") { next(); return "int"; }
    if (tok.t === "id" && tok.v === "void") { next(); return "void"; }
    if (tok.t === "id" && INT_TYPES.has(tok.v)) { next(); return "int"; }
    throw new CompileError(`expected a type but found '${tok.v || tok.t}'`, tok.line, tok.col); };

  const functions = [];
  while (!isAt("eof")) functions.push(parseFunction());
  if (!functions.length) throw new CompileError("a program must define at least one function");
  return { functions };

  function parseFunction() {
    const ret = eatType();                       // int | void | (uint8_t/uint32_t/… → int)
    const name = eat("id").v;
    eat("(");
    const params = [];
    if (!isAt(")")) {
      if (peek().t === "id" && peek().v === "void" && toks[p + 1].t === ")") next();   // (void) ⇒ no params
      else do { eatType(); params.push(eat("id").v); } while (isAt(",") && (next(), true));
    }
    eat(")");
    const body = parseBlock();
    return { name, params, body, ret };
  }
  function parseBlock() {
    const tok = eat("{");
    const stmts = [];
    while (!isAt("}")) { if (isAt("eof")) throw new CompileError("unterminated block", tok.line, tok.col); stmts.push(parseStatement()); }
    eat("}");
    return { k: "block", stmts };
  }
  function parseStatement() {
    const tok = peek();
    if (tok.t === "{") return parseBlock();
    if (tok.t === "int") { next(); const name = eat("id").v; let init = null; if (isAt("=")) { next(); init = parseExpr(); } eat(";"); return { k: "decl", name, init, line: tok.line, col: tok.col }; }
    if (tok.t === "if") {
      next(); eat("("); const cond = parseExpr(); eat(")");
      const then = parseStatement();
      let alt = null; if (isAt("else")) { next(); alt = parseStatement(); }
      return { k: "if", cond, then, alt };
    }
    if (tok.t === "while") { next(); eat("("); const cond = parseExpr(); eat(")"); const body = parseStatement(); return { k: "while", cond, body }; }
    if (tok.t === "return") { next(); let value = null; if (!isAt(";")) value = parseExpr(); eat(";"); return { k: "return", value }; }
    // assignment  (id = expr ;)  vs  expression statement
    if (tok.t === "id" && toks[p + 1].t === "=") { const name = next().v; eat("="); const value = parseExpr(); eat(";"); return { k: "assign", name, value, line: tok.line, col: tok.col }; }
    const value = parseExpr(); eat(";"); return { k: "exprstmt", value };
  }

  // a full expression = a binary precedence-climb, with the ternary ?: layered on top (lowest
  // precedence, right-associative, exactly as C). Every caller wanting an expression calls this.
  function parseExpr() {
    const cond = parseBinary(1);
    if (!isAt("?")) return cond;
    next();
    const then = parseExpr();              // C: the middle operand is a full expression
    eat(":");
    const alt = parseExpr();               // right-associative — chains a ? b : c ? d : e
    return { k: "ternary", cond, then, alt };
  }
  // precedence climbing — lower binds looser (BINOP table at module scope)
  function parseBinary(minPrec) {
    let left = parseUnary();
    while (true) {
      const op = peek().t;
      const prec = BINOP[op];
      if (!prec || prec < minPrec) break;
      next();
      const right = parseBinary(prec + 1);   // left-associative
      left = { k: "bin", op, left, right };
    }
    return left;
  }
  function parseUnary() {
    const tok = peek();
    // C cast  ( type ) expr  — every integer type is i32 here, so the cast is the identity; (void)x
    // evaluates x (its value is dropped by the enclosing expression statement). Disambiguated from a
    // parenthesized group by a type keyword immediately after '(' (no variable is named like a type).
    if (tok.t === "(" && isTypeTok(toks[p + 1]) && toks[p + 2].t === ")") { next(); eatType(); eat(")"); return parseUnary(); }
    if (tok.t === "-" || tok.t === "!") { next(); return { k: "unary", op: tok.t, expr: parseUnary() }; }
    if (tok.t === "+") { next(); return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary() {
    const tok = peek();
    if (tok.t === "num") { next(); return { k: "num", v: tok.v }; }
    if (tok.t === "(") { next(); const e = parseExpr(); eat(")"); return e; }
    if (tok.t === "id") {
      const name = next().v;
      if (isAt("(")) {
        next(); const args = [];
        if (!isAt(")")) { do { args.push(parseExpr()); } while (isAt(",") && (next(), true)); }
        eat(")");
        return { k: "call", name, args, line: tok.line, col: tok.col };
      }
      return { k: "var", name, line: tok.line, col: tok.col };
    }
    throw new CompileError(`unexpected '${tok.v || tok.t}'`, tok.line, tok.col);
  }
}

// ───────────────────────────────────── WebAssembly encoding ────────────────────────────────────
const I32 = 0x7f;
// opcodes
const OP = {
  block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, br_if: 0x0d, ret: 0x0f,
  call: 0x10, drop: 0x1a, localGet: 0x20, localSet: 0x21, i32const: 0x41, eqz: 0x45,
  eq: 0x46, ne: 0x47, lt_s: 0x48, gt_s: 0x4a, le_s: 0x4c, ge_s: 0x4e,
  add: 0x6a, sub: 0x6b, mul: 0x6c, div_s: 0x6d, rem_s: 0x6f,
  and: 0x71, or: 0x72, xor: 0x73, shl: 0x74, shr_s: 0x75,
};
const CMP = { "==": OP.eq, "!=": OP.ne, "<": OP.lt_s, ">": OP.gt_s, "<=": OP.le_s, ">=": OP.ge_s };
const ARITH = { "+": OP.add, "-": OP.sub, "*": OP.mul, "/": OP.div_s, "%": OP.rem_s };
// bitwise & shift — signed shift (shr_s) matches Holo-C's signed-i32 semantics (cf. div_s / rem_s).
const BIT = { "&": OP.and, "|": OP.or, "^": OP.xor, "<<": OP.shl, ">>": OP.shr_s };

function unsignedLEB(n) {
  const out = []; n >>>= 0;
  do { let b = n & 0x7f; n >>>= 7; if (n !== 0) b |= 0x80; out.push(b); } while (n !== 0);
  return out;
}
function signedLEB(n) {
  n |= 0; const out = []; let more = true;
  while (more) {
    let b = n & 0x7f; n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false; else b |= 0x80;
    out.push(b);
  }
  return out;
}
const str = (s) => { const bytes = [...new TextEncoder().encode(s)]; return [...unsignedLEB(bytes.length), ...bytes]; };
const vec = (items) => [...unsignedLEB(items.length), ...items.flat()];
const section = (id, payload) => [id, ...unsignedLEB(payload.length), ...payload];

// ─────────────────────────────────────────── codegen ──────────────────────────────────────────
function compileModule(ast) {
  // function table: name → { index, params, localNames, code }
  const order = ast.functions.map((f) => f.name);
  const table = new Map();
  ast.functions.forEach((f, idx) => {
    if (table.has(f.name)) throw new CompileError(`function '${f.name}' redefined`);
    table.set(f.name, { index: idx, fn: f, arity: f.params.length });
  });

  const bodies = ast.functions.map((f) => emitFunction(f, table));

  // type section — dedup signatures by (param count, result). Result is [i32] for int functions and
  // [] for void. Keying includes the return so a void `()->()` and an int `()->(i32)` stay distinct;
  // for int-only programs the key is `${a}:int` ⇒ identical bytes/order to before (backward-compatible).
  const sigByKey = new Map();   // `${arity}:${ret}` → typeIndex
  const types = [];
  const funcTypeIdx = [];
  for (const f of ast.functions) {
    const a = f.params.length, key = `${a}:${f.ret || "int"}`;
    if (!sigByKey.has(key)) {
      sigByKey.set(key, types.length);
      const result = f.ret === "void" ? vec([]) : vec([I32]);
      types.push([0x60, ...vec(new Array(a).fill(I32)), ...result]);   // (i32^a) -> (i32 | ε)
    }
    funcTypeIdx.push(sigByKey.get(key));
  }

  const typeSec = section(1, vec(types));
  const funcSec = section(3, vec(funcTypeIdx.map((t) => unsignedLEB(t))));
  const exportSec = section(7, vec(ast.functions.map((f, idx) => [...str(f.name), 0x00, ...unsignedLEB(idx)])));
  const codeSec = section(10, vec(bodies.map((b) => [...unsignedLEB(b.length), ...b])));

  const wasm = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,   // \0asm, version 1
    ...typeSec, ...funcSec, ...exportSec, ...codeSec,
  ]);
  return { wasm, order, exportsMeta: ast.functions.map((f) => ({ name: f.name, params: f.params.slice() })) };
}

function emitFunction(fn, table) {
  // locals: params occupy indices 0..p-1; declared vars follow. One flat scope per function.
  const slots = new Map();
  fn.params.forEach((name, i) => { if (slots.has(name)) throw new CompileError(`duplicate parameter '${name}' in '${fn.name}'`); slots.set(name, i); });
  let nextLocal = fn.params.length;
  const declare = (name, line, col) => { if (slots.has(name)) throw new CompileError(`'${name}' redeclared in '${fn.name}'`, line, col); const idx = nextLocal++; slots.set(name, idx); return idx; };
  const ref = (name, line, col) => { if (!slots.has(name)) throw new CompileError(`undefined variable '${name}' in '${fn.name}'`, line, col); return slots.get(name); };

  const code = [];
  emitBlock(fn.body, code, { slots, declare, ref, table, fn });
  if (fn.ret !== "void") code.push(OP.i32const, ...signedLEB(0));   // fall-through return value (int fns leave one i32 at `end`; void fns leave none)

  const localCount = nextLocal - fn.params.length;
  const localsDecl = localCount > 0 ? vec([[...unsignedLEB(localCount), I32]]) : vec([]);
  return [...localsDecl, ...code, OP.end];
}

function emitBlock(block, code, ctx) { for (const s of block.stmts) emitStatement(s, code, ctx); }

function emitStatement(s, code, ctx) {
  switch (s.k) {
    case "block": emitBlock(s, code, ctx); break;
    case "decl": {
      const idx = ctx.declare(s.name, s.line, s.col);
      if (s.init) { emitExpr(s.init, code, ctx); code.push(OP.localSet, ...unsignedLEB(idx)); }
      break;
    }
    case "assign": { const idx = ctx.ref(s.name, s.line, s.col); emitExpr(s.value, code, ctx); code.push(OP.localSet, ...unsignedLEB(idx)); break; }
    case "return": {
      if (s.value) emitExpr(s.value, code, ctx);
      else if (ctx.fn.ret !== "void") code.push(OP.i32const, ...signedLEB(0));   // `return;` in a void fn returns nothing
      code.push(OP.ret); break;
    }
    case "exprstmt": emitExpr(s.value, code, ctx); code.push(OP.drop); break;   // result unused
    case "if": {
      emitExpr(s.cond, code, ctx);
      code.push(OP.if, 0x40);                  // void block; cond on stack, nonzero = true
      emitStatement(s.then, code, ctx);
      if (s.alt) { code.push(OP.else); emitStatement(s.alt, code, ctx); }
      code.push(OP.end);
      break;
    }
    case "while": {
      code.push(OP.block, 0x40);               // $exit  (br_if 1 / br 1)
      code.push(OP.loop, 0x40);                // $cont  (br 0)
      emitExpr(s.cond, code, ctx);
      code.push(OP.eqz, OP.br_if, ...unsignedLEB(1));   // cond == 0 → break to $exit
      emitStatement(s.body, code, ctx);
      code.push(OP.br, ...unsignedLEB(0));     // continue
      code.push(OP.end);                       // loop
      code.push(OP.end);                       // block
      break;
    }
    default: throw new CompileError(`internal: unknown statement '${s.k}'`);
  }
}

// every expression leaves exactly one i32 on the stack
function emitExpr(e, code, ctx) {
  switch (e.k) {
    case "num": code.push(OP.i32const, ...signedLEB(e.v)); break;
    case "var": code.push(OP.localGet, ...unsignedLEB(ctx.ref(e.name, e.line, e.col))); break;
    case "unary":
      if (e.op === "-") { code.push(OP.i32const, ...signedLEB(0)); emitExpr(e.expr, code, ctx); code.push(OP.sub); }
      else { emitExpr(e.expr, code, ctx); code.push(OP.eqz); }   // !x → 0/1
      break;
    case "call": {
      const target = ctx.table.get(e.name);
      if (!target) throw new CompileError(`call to undefined function '${e.name}'`, e.line, e.col);
      if (e.args.length !== target.arity) throw new CompileError(`'${e.name}' expects ${target.arity} arg(s), got ${e.args.length}`, e.line, e.col);
      for (const a of e.args) emitExpr(a, code, ctx);
      code.push(OP.call, ...unsignedLEB(target.index));
      break;
    }
    case "bin": emitBinary(e, code, ctx); break;
    case "ternary": {                              // cond ? then : alt — both arms leave one i32
      emitExpr(e.cond, code, ctx);
      code.push(OP.if, I32);
      emitExpr(e.then, code, ctx);
      code.push(OP.else);
      emitExpr(e.alt, code, ctx);
      code.push(OP.end);
      break;
    }
    default: throw new CompileError(`internal: unknown expression '${e.k}'`);
  }
}

function emitBinary(e, code, ctx) {
  if (e.op === "&&") {                          // short-circuit; result 0/1
    emitExpr(e.left, code, ctx);
    code.push(OP.if, I32);                       // if (left) { right!=0 } else { 0 }
    emitTruthy(e.right, code, ctx);
    code.push(OP.else, OP.i32const, ...signedLEB(0), OP.end);
    return;
  }
  if (e.op === "||") {
    emitExpr(e.left, code, ctx);
    code.push(OP.if, I32);                        // if (left) { 1 } else { right!=0 }
    code.push(OP.i32const, ...signedLEB(1), OP.else);
    emitTruthy(e.right, code, ctx);
    code.push(OP.end);
    return;
  }
  emitExpr(e.left, code, ctx);
  emitExpr(e.right, code, ctx);
  if (CMP[e.op]) code.push(CMP[e.op]);
  else if (ARITH[e.op]) code.push(ARITH[e.op]);
  else if (BIT[e.op]) code.push(BIT[e.op]);
  else throw new CompileError(`internal: unknown operator '${e.op}'`);
}

// normalize an expression to 0/1 (x != 0)
function emitTruthy(e, code, ctx) { emitExpr(e, code, ctx); code.push(OP.i32const, ...signedLEB(0), OP.ne); }

// ──────────────────────────────────────── public API ──────────────────────────────────────────
// compile(source) → { wasm: Uint8Array, exports: [{name, params}], lang, version }
// Deterministic: identical `source` ⇒ identical `wasm` bytes, on every platform.
export function compile(source, _opts = {}) {
  if (typeof source !== "string") throw new CompileError("source must be a string");
  const ast = parse(source);
  const { wasm, exportsMeta } = compileModule(ast);
  return { wasm, exports: exportsMeta, lang: LANG, version: VERSION };
}

// ───────────────────────────── the κ-transform receipt (pure, isomorphic) ──────────────────────
// forgeReceipt(fields) → the canonical receipt object (WITHOUT its `id`), a PROV-O activity that
// links the source κ → artifact κ via the compiler κ + flags κ. Identical inputs ⇒ identical
// object ⇒ identical address on every platform. The caller seals it (hashes jcs() bytes) with
// its platform crypto — holo-object.address() in Node, WebCrypto in the browser — yielding the
// build's own did:holo. This is the build made into a first-class, re-derivable κ-object.
export function forgeReceipt({ sourceKappa, compilerKappa, flagsKappa, artifactKappa, lang = LANG, exports = [] }) {
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      { schema: "https://schema.org/", prov: "http://www.w3.org/ns/prov#", hosc: "https://hologram.os/ns/conformance#" },
    ],
    "@type": ["prov:Activity", "hosc:Compilation", "schema:CreateAction"],
    "schema:name": "Holo Forge compilation",
    "hosc:lang": lang,
    "hosc:tool": { "@id": compilerKappa, "schema:name": "holo-forge", "schema:softwareVersion": VERSION },
    "hosc:flags": flagsKappa,
    "prov:used": { "@id": sourceKappa, "@type": ["prov:Entity", "schema:SoftwareSourceCode"], "schema:programmingLanguage": lang },
    "prov:generated": { "@id": artifactKappa, "@type": ["prov:Entity", "schema:SoftwareApplication"], "schema:encodingFormat": "application/wasm" },
    "schema:result": exports.map((e) => (typeof e === "string" ? e : e.name)).sort(),
  };
}

// jcs — RFC 8785 JSON Canonicalization Scheme (the byte-stable canonical form both Node and the
// browser hash to address an object). Kept identical to holo-uor.mjs so a receipt addresses the
// same way everywhere. Pure; no crypto here (Law L2: canonicalize once, hash elsewhere).
export const jcs = (v) => Array.isArray(v) ? "[" + v.map(jcs).join(",") + "]"
  : (v && typeof v === "object") ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}"
  : JSON.stringify(v);
