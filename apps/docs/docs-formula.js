// docs-formula.js — a real, dependency-free spreadsheet formula engine for the
// Holo Docs CALC editor. Recursive-descent parser + evaluator with A1
// references, ranges, the standard operators, a function library, error values,
// and (driven by the caller's resolver) dependency recalculation with cycle
// detection. Pure: no globals, no I/O — the caller supplies a `resolve(sheet,col,
// row)` that returns already-computed scalar values.

// ── A1 ⇄ (col,row) helpers ─────────────────────────────────────────────────────
export function colToNum(s) { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; } // "A"→0
export function numToCol(n) { let s = ""; n++; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
export function refA1(col, row) { return numToCol(col) + (row + 1); }            // (0,0)→"A1"
export function parseA1(a1) { const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(a1.trim()); if (!m) return null; return { col: colToNum(m[1]), row: parseInt(m[2], 10) - 1 }; }

const ERR = (e) => ({ err: e });
const isErr = (v) => v && typeof v === "object" && "err" in v;
const isRange = (v) => v && typeof v === "object" && "range" in v;
function num(v) { if (isErr(v)) return v; if (typeof v === "number") return v; if (typeof v === "boolean") return v ? 1 : 0; if (v == null || v === "") return 0; const n = Number(String(v).trim()); return isNaN(n) ? ERR("#VALUE!") : n; }
function str(v) { if (isErr(v)) return v; if (v == null) return ""; if (typeof v === "boolean") return v ? "TRUE" : "FALSE"; return String(v); }
function flat(v) { if (isRange(v)) return v.cells; return [v]; }

// ── tokenizer ──────────────────────────────────────────────────────────────────
function tokenize(src) {
  const toks = []; let i = 0; const n = src.length;
  const peek = () => src[i];
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (c >= "0" && c <= "9" || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      let j = i + 1; while (j < n && (/[0-9.eE]/.test(src[j]) || ((src[j] === "+" || src[j] === "-") && /[eE]/.test(src[j - 1])))) j++;
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (c === '"') { let j = i + 1, s = ""; while (j < n) { if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += src[j++]; } toks.push({ t: "str", v: s }); i = j + 1; continue; }
    if (c === "'") { let j = i + 1, s = ""; while (j < n && src[j] !== "'") s += src[j++]; toks.push({ t: "sheet", v: s }); i = j + 1; continue; } // 'Sheet name'
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < n && /[A-Za-z0-9_.]/.test(src[j])) j++; toks.push({ t: "name", v: src.slice(i, j) }); i = j; continue; }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { toks.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/^%&=<>(),:!".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    return [{ t: "err" }];
  }
  toks.push({ t: "end" }); return toks;
}

// ── parser (→ AST) ───────────────────────────────────────────────────────────────
function parse(src) {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p]; const next = () => toks[p++];
  const eat = (v) => { if (peek().t === "op" && peek().v === v) { p++; return true; } return false; };
  function parseExpr() { return parseCompare(); }
  function parseCompare() { let l = parseConcat(); while (peek().t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(peek().v)) { const op = next().v; const r = parseConcat(); l = { k: "bin", op, l, r }; } return l; }
  function parseConcat() { let l = parseAdd(); while (peek().t === "op" && peek().v === "&") { next(); l = { k: "bin", op: "&", l, r: parseAdd() }; } return l; }
  function parseAdd() { let l = parseMul(); while (peek().t === "op" && (peek().v === "+" || peek().v === "-")) { const op = next().v; l = { k: "bin", op, l, r: parseMul() }; } return l; }
  function parseMul() { let l = parsePow(); while (peek().t === "op" && (peek().v === "*" || peek().v === "/")) { const op = next().v; l = { k: "bin", op, l, r: parsePow() }; } return l; }
  function parsePow() { let l = parseUnary(); if (peek().t === "op" && peek().v === "^") { next(); return { k: "bin", op: "^", l, r: parsePow() }; } return l; }
  function parseUnary() { if (peek().t === "op" && (peek().v === "-" || peek().v === "+")) { const op = next().v; return { k: "un", op, e: parseUnary() }; } return parsePostfix(); }
  function parsePostfix() { let e = parsePrimary(); while (peek().t === "op" && peek().v === "%") { next(); e = { k: "pct", e }; } return e; }
  function parsePrimary() {
    const t = peek();
    if (t.t === "num") { next(); return { k: "num", v: t.v }; }
    if (t.t === "str") { next(); return { k: "str", v: t.v }; }
    if (t.t === "op" && t.v === "(") { next(); const e = parseExpr(); eat(")"); return e; }
    let sheet = null;
    if (t.t === "sheet") { next(); if (!eat("!")) return { k: "err" }; sheet = t.v; }
    if (peek().t === "name") {
      const nm = next().v;
      if (peek().t === "op" && peek().v === "(") { next(); const args = []; if (!(peek().t === "op" && peek().v === ")")) { args.push(parseExpr()); while (eat(",")) args.push(parseExpr()); } eat(")"); return { k: "call", fn: nm.toUpperCase(), args }; }
      if (peek().t === "op" && peek().v === "!") { next(); /* Sheet!ref */ const r = peek(); if (r.t === "name") { next(); return makeRefOrRange(nm, r.v); } }
      // upper-case keywords
      const U = nm.toUpperCase(); if (U === "TRUE") return { k: "bool", v: true }; if (U === "FALSE") return { k: "bool", v: false };
      return makeRefOrRange(sheet, nm);
    }
    return { k: "err" };
    function makeRefOrRange(sh, a) {
      if (peek().t === "op" && peek().v === ":") { next(); const b = peek().t === "name" ? next().v : null; return { k: "range", sheet: sh, a, b }; }
      return { k: "ref", sheet: sh, a };
    }
  }
  return parseExpr();
}

// ── evaluator ────────────────────────────────────────────────────────────────────
// resolve(sheet|null, col, row) → scalar value (number|string|boolean|""|{err}).
export function evaluate(src, ctx) {
  const resolve = ctx.resolve; const curSheet = ctx.sheet || null;
  let ast; try { ast = parse(src); } catch { return ERR("#ERROR!"); }
  function ev(node) {
    switch (node.k) {
      case "num": return node.v; case "str": return node.v; case "bool": return node.v; case "err": return ERR("#ERROR!");
      case "ref": { const r = parseA1(node.a); if (!r) return ERR("#REF!"); return resolve(node.sheet || curSheet, r.col, r.row); }
      case "range": { const a = parseA1(node.a), b = node.b ? parseA1(node.b) : null; if (!a || !b) return ERR("#REF!");
        const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col), r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
        const cells = []; for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(resolve(node.sheet || curSheet, c, r)); return { range: true, cells }; }
      case "un": { const v = ev(node.e); if (isErr(v)) return v; const x = num(v); if (isErr(x)) return x; return node.op === "-" ? -x : +x; }
      case "pct": { const v = ev(node.e); const x = num(v); if (isErr(x)) return x; return x / 100; }
      case "bin": return bin(node.op, ev(node.l), ev(node.r));
      case "call": return call(node.fn, node.args);
    }
    return ERR("#ERROR!");
  }
  function bin(op, l, r) {
    if (op === "&") { const a = str(l), b = str(r); if (isErr(a)) return a; if (isErr(b)) return b; return a + b; }
    if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
      if (isErr(l)) return l; if (isErr(r)) return r;
      let a = isRange(l) ? l.cells[0] : l, b = isRange(r) ? r.cells[0] : r;
      const bothNum = typeof a === "number" && typeof b === "number";
      if (!bothNum && (typeof a === "string" || typeof b === "string")) { a = str(a).toLowerCase(); b = str(b).toLowerCase(); }
      switch (op) { case "=": return a === b; case "<>": return a !== b; case "<": return a < b; case ">": return a > b; case "<=": return a <= b; case ">=": return a >= b; }
    }
    const a = num(l), b = num(r); if (isErr(a)) return a; if (isErr(b)) return b;
    switch (op) { case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return b === 0 ? ERR("#DIV/0!") : a / b; case "^": return Math.pow(a, b); }
    return ERR("#ERROR!");
  }
  function nums(args) { const out = []; for (const a of args) for (const v of flat(ev(a))) { if (isErr(v)) return v; if (v === "" || v == null) continue; const n = typeof v === "number" ? v : (typeof v === "boolean" ? (v ? 1 : 0) : (String(v).trim() === "" ? null : Number(v))); if (n != null && !isNaN(n)) out.push(n); } return out; }
  function allVals(args) { const out = []; for (const a of args) for (const v of flat(ev(a))) out.push(v); return out; }
  function matchIf(cells, cond) { // SUMIF/COUNTIF criteria: ">5", "=x", "text"
    const m = /^(<=|>=|<>|<|>|=)?\s*(.*)$/.exec(String(cond)); const op = m[1] || "="; let rhs = m[2];
    const rn = Number(rhs); const isNum = rhs !== "" && !isNaN(rn);
    return (v) => { let a = v; if (isNum && typeof a !== "number") a = Number(a); const b = isNum ? rn : String(rhs).toLowerCase(); const A = isNum ? a : String(a).toLowerCase();
      switch (op) { case "=": return A === b; case "<>": return A !== b; case "<": return A < b; case ">": return A > b; case "<=": return A <= b; case ">=": return A >= b; } return false; };
  }
  function call(fn, args) {
    const F = {
      SUM: () => { const a = nums(args); return isErr(a) ? a : a.reduce((s, x) => s + x, 0); },
      AVERAGE: () => { const a = nums(args); if (isErr(a)) return a; return a.length ? a.reduce((s, x) => s + x, 0) / a.length : ERR("#DIV/0!"); },
      COUNT: () => nums(args).length,
      COUNTA: () => allVals(args).filter((v) => v !== "" && v != null && !isErr(v)).length,
      MIN: () => { const a = nums(args); if (isErr(a)) return a; return a.length ? Math.min(...a) : 0; },
      MAX: () => { const a = nums(args); if (isErr(a)) return a; return a.length ? Math.max(...a) : 0; },
      PRODUCT: () => nums(args).reduce((s, x) => s * x, 1),
      ABS: () => Math.abs(num(ev(args[0]))), SQRT: () => { const x = num(ev(args[0])); return x < 0 ? ERR("#NUM!") : Math.sqrt(x); },
      ROUND: () => { const x = num(ev(args[0])), d = args[1] ? num(ev(args[1])) : 0; const f = Math.pow(10, d); return Math.round(x * f) / f; },
      ROUNDUP: () => { const x = num(ev(args[0])), d = args[1] ? num(ev(args[1])) : 0; const f = Math.pow(10, d); return Math.ceil(Math.abs(x) * f) / f * Math.sign(x); },
      ROUNDDOWN: () => { const x = num(ev(args[0])), d = args[1] ? num(ev(args[1])) : 0; const f = Math.pow(10, d); return Math.floor(Math.abs(x) * f) / f * Math.sign(x); },
      INT: () => Math.floor(num(ev(args[0]))), MOD: () => { const a = num(ev(args[0])), b = num(ev(args[1])); return b === 0 ? ERR("#DIV/0!") : a - b * Math.floor(a / b); },
      POWER: () => Math.pow(num(ev(args[0])), num(ev(args[1]))), FLOOR: () => { const x = num(ev(args[0])), s = args[1] ? num(ev(args[1])) : 1; return Math.floor(x / s) * s; },
      CEILING: () => { const x = num(ev(args[0])), s = args[1] ? num(ev(args[1])) : 1; return Math.ceil(x / s) * s; },
      PI: () => Math.PI, RAND: () => Math.random(), TRUNC: () => Math.trunc(num(ev(args[0]))), SIGN: () => Math.sign(num(ev(args[0]))),
      IF: () => { const c = ev(args[0]); if (isErr(c)) return c; const t = typeof c === "boolean" ? c : (typeof c === "number" ? c !== 0 : String(c).toLowerCase() === "true"); return t ? ev(args[1]) : (args[2] ? ev(args[2]) : false); },
      IFERROR: () => { const v = ev(args[0]); return isErr(v) ? ev(args[1]) : v; },
      AND: () => allVals(args).every((v) => (typeof v === "boolean" ? v : num(v) !== 0)),
      OR: () => allVals(args).some((v) => (typeof v === "boolean" ? v : num(v) !== 0)),
      NOT: () => { const v = ev(args[0]); return !(typeof v === "boolean" ? v : num(v) !== 0); },
      CONCAT: () => allVals(args).map(str).join(""), CONCATENATE: () => allVals(args).map(str).join(""),
      LEN: () => str(ev(args[0])).length, UPPER: () => str(ev(args[0])).toUpperCase(), LOWER: () => str(ev(args[0])).toLowerCase(), TRIM: () => str(ev(args[0])).trim(),
      LEFT: () => str(ev(args[0])).slice(0, args[1] ? num(ev(args[1])) : 1), RIGHT: () => { const s = str(ev(args[0])), n = args[1] ? num(ev(args[1])) : 1; return s.slice(s.length - n); },
      MID: () => { const s = str(ev(args[0])), st = num(ev(args[1])), ln = num(ev(args[2])); return s.substr(st - 1, ln); },
      REPLACE: () => { const s = str(ev(args[0])), st = num(ev(args[1])), ln = num(ev(args[2])), nw = str(ev(args[3])); return s.slice(0, st - 1) + nw + s.slice(st - 1 + ln); },
      TEXT: () => str(ev(args[0])), VALUE: () => num(ev(args[0])),
      TODAY: () => { const d = new Date(); return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000); },
      NOW: () => { const d = new Date(); return (d.getTime() - Date.UTC(1899, 11, 30)) / 86400000; },
      SUMIF: () => { const rng = flat(ev(args[0])); const pred = matchIf(rng, str(ev(args[1]))); const sumRng = args[2] ? flat(ev(args[2])) : rng; let s = 0; rng.forEach((v, i) => { if (pred(v)) s += num(sumRng[i]) || 0; }); return s; },
      COUNTIF: () => { const rng = flat(ev(args[0])); const pred = matchIf(rng, str(ev(args[1]))); return rng.filter(pred).length; },
      AVERAGEIF: () => { const rng = flat(ev(args[0])); const pred = matchIf(rng, str(ev(args[1]))); const avgRng = args[2] ? flat(ev(args[2])) : rng; const xs = []; rng.forEach((v, i) => { if (pred(v)) { const n = num(avgRng[i]); if (!isErr(n)) xs.push(n); } }); return xs.length ? xs.reduce((a, b) => a + b) / xs.length : ERR("#DIV/0!"); },
      VLOOKUP: () => { const key = ev(args[0]); const rng = ev(args[1]); const colIx = num(ev(args[2])); if (!isRange(rng)) return ERR("#VALUE!");
        // infer width from the range ast (b - a)
        const ra = args[1]; const a = parseA1(ra.a), b = ra.b ? parseA1(ra.b) : a; const w = Math.abs(b.col - a.col) + 1; const rows = rng.cells.length / w;
        for (let r = 0; r < rows; r++) { const cell = rng.cells[r * w]; const K = typeof key === "number" ? num(cell) : str(cell).toLowerCase(); const KK = typeof key === "number" ? key : str(key).toLowerCase(); if (K === KK) return rng.cells[r * w + (colIx - 1)]; } return ERR("#N/A"); },
      ROW: () => { const r = args[0] && args[0].k === "ref" ? parseA1(args[0].a) : null; return r ? r.row + 1 : 0; },
      COLUMN: () => { const r = args[0] && args[0].k === "ref" ? parseA1(args[0].a) : null; return r ? r.col + 1 : 0; },
    };
    if (!F[fn]) return ERR("#NAME?");
    try { const v = F[fn](); return v === undefined || v === null ? "" : v; } catch { return ERR("#VALUE!"); }
  }
  const v = ev(ast); return isRange(v) ? (v.cells[0] ?? "") : v;
}

// Format an evaluated value for display, honoring a number format string.
export function formatValue(v, fmt) {
  if (v && typeof v === "object" && "err" in v) return v.err;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    if (!isFinite(v)) return "#NUM!";
    if (fmt === "percent") return (v * 100).toFixed(2) + "%";
    if (fmt === "currency") return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (fmt === "int") return Math.round(v).toLocaleString();
    if (fmt === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 10 });
    return Number.isInteger(v) ? String(v) : (Math.round(v * 1e10) / 1e10).toString();
  }
  return String(v);
}

export const Formula = { evaluate, formatValue, colToNum, numToCol, refA1, parseA1 };
export default Formula;
