// docs-interop.js — full interoperability with the existing office standards.
//
// Reads and WRITES the two ISO office-document standards, ENTIRELY IN THE BROWSER
// (no server, no CDN, no vendored office library):
//   • OOXML  (ISO/IEC 29500) — .docx (WordprocessingML), .xlsx (SpreadsheetML),
//     .pptx (PresentationML)
//   • ODF    (ISO/IEC 26300) — .odt, .ods, .odp (OpenDocument)
// Both are ZIP-of-XML containers; we use the lean platform primitives
// (../../_shared/holo-zip.js → Compression Streams) for the container and a tiny
// dependency-free XML parser here for the parts. Imported files become a holo-collab
// CvRDT document (then content-addressed as holo://κ); any document exports back to
// these formats. So a file authored in Word/Excel/PowerPoint or LibreOffice can be
// opened, co-edited live, saved as κ, and exported back — round-trip interop.

import { zip, unzip, fromUtf8 } from "./_shared/holo-zip.js";
import { Formula, refA1, numToCol, parseA1 } from "./docs-formula.js";

// ════════════════════════════════════════ XML ════════════════════════════════════
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const aesc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function decodeEntities(s) { return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }

// Minimal namespace-tolerant XML → tree. node = {tag, attrs, children, text}.
function parseXML(xml) {
  xml = String(xml).replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const root = { tag: "#root", attrs: {}, children: [], text: "" }; const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[5] != null) { const node = stack[stack.length - 1]; node.text += decodeEntities(m[5]); continue; }
    if (m[1] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {}; const are = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let am;
    while ((am = are.exec(m[3]))) attrs[am[1]] = decodeEntities(am[2] != null ? am[2] : am[3]);
    const node = { tag: m[2], attrs, children: [], text: "" }; stack[stack.length - 1].children.push(node);
    if (m[4] !== "/") stack.push(node);
  }
  return root;
}
const local = (t) => t.slice(t.indexOf(":") + 1);
function attr(node, name) { if (!node) return undefined; if (name in node.attrs) return node.attrs[name]; for (const k in node.attrs) if (local(k) === name) return node.attrs[k]; return undefined; }
function kids(node, name) { return node ? node.children.filter((c) => local(c.tag) === name) : []; }
function kid(node, name) { return kids(node, name)[0]; }
function all(node, name, out = []) { if (!node) return out; for (const c of node.children) { if (local(c.tag) === name) out.push(c); all(c, name, out); } return out; }
function allText(node) { if (!node) return ""; let t = node.text || ""; for (const c of node.children) t += allText(c); return t; }
const XMLHEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ════════════════════════════════ model read/build ════════════════════════════════
// `R` is a reader (a holo-collab Session, or docReader(Doc)): text/seqIds/seqVals/
// val/mapKeys/getAsset. Build targets a holo-collab Doc.

export function docReader(doc) {
  return {
    text: (n) => doc.rga(n).text(), seqIds: (n) => doc.rga(n).liveIds(), seqVals: (n) => doc.rga(n).vals(),
    val: (n, k) => doc.map(n).get(k), mapKeys: (n) => doc.map(n).keys(), getAsset: async () => null,
  };
}
const markSig = (m) => `${m.b ? 1 : 0}${m.i ? 1 : 0}${m.u ? 1 : 0}${m.s ? 1 : 0}${m.link || ""}${m.color || ""}`;

// WRITER ─ paragraphs [{type,align,runs:[{text,b,i,u,s,link,color}]}]
function readWriter(R) {
  const ids = R.seqIds("text"), vals = R.seqVals("text"); const paras = []; let buf = [];
  const flush = (ba) => { const runs = []; let cur = null;
    for (const c of buf) { const sig = markSig(c.m); if (!cur || cur.sig !== sig) { cur = { sig, text: "", b: !!c.m.b, i: !!c.m.i, u: !!c.m.u, s: !!c.m.s, link: c.m.link, color: c.m.color }; runs.push(cur); } cur.text += c.ch; }
    paras.push({ type: ba.type || "p", align: ba.align || "", runs }); buf = []; };
  for (let g = 0; g < ids.length; g++) { const ch = vals[g]; if (ch === "\n") flush(R.val("blocks", ids[g]) || {}); else buf.push({ ch, m: R.val("marks", ids[g]) || {} }); }
  flush(R.val("blocks", "tail") || {});
  return paras;
}
function buildWriter(doc, paras) {
  paras.forEach((p, pi) => {
    const last = pi === paras.length - 1; const startLen = doc.rga("text").len();
    let text = ""; const ranges = [];
    for (const r of p.runs) { const from = text.length; text += r.text; const m = {}; if (r.b) m.b = 1; if (r.i) m.i = 1; if (r.u) m.u = 1; if (r.s) m.s = 1; if (r.link) m.link = r.link; if (r.color) m.color = r.color; ranges.push({ from, to: text.length, m }); }
    if (text.length) doc.insert("text", startLen, [...text]);
    let termId = "tail";
    if (!last) { const nlAt = doc.rga("text").len(); doc.insert("text", nlAt, ["\n"]); termId = doc.rga("text").liveIds()[nlAt]; }
    const ids = doc.rga("text").liveIds();
    for (const rr of ranges) { if (!Object.keys(rr.m).length) continue; for (let k = rr.from; k < rr.to; k++) doc.set("marks", ids[startLen + k], rr.m); }
    const ba = {}; if (p.type && p.type !== "p") ba.type = p.type; if (p.align) ba.align = p.align;
    if (Object.keys(ba).length) doc.set("blocks", termId, ba);
  });
}

// CALC ─ sheets [{id,name,cells:{A1:raw},fmt:{A1:{...}}}]
function readCalc(R) {
  const keys = R.mapKeys("sheetmeta"); const m = new Map();
  for (const k of keys) m.set(k, R.val("sheetmeta", k) || { name: k, ord: 0 });
  if (!m.has("s1")) m.set("s1", { name: "Sheet1", ord: 0 });
  const order = [...m].sort((a, b) => (a[1].ord || 0) - (b[1].ord || 0) || (a[0] < b[0] ? -1 : 1));
  const sheets = order.map(([id, meta]) => ({ id, name: meta.name || id, cells: {}, fmt: {} }));
  const byId = Object.fromEntries(sheets.map((s) => [s.id, s]));
  for (const k of R.mapKeys("cells")) { const i = k.indexOf("!"); const sid = k.slice(0, i), a1 = k.slice(i + 1); const v = R.val("cells", k); if (byId[sid] && v != null && v !== "") byId[sid].cells[a1] = String(v); }
  for (const k of R.mapKeys("cellfmt")) { const i = k.indexOf("!"); const sid = k.slice(0, i), a1 = k.slice(i + 1); if (byId[sid]) byId[sid].fmt[a1] = R.val("cellfmt", k) || {}; }
  return sheets;
}
function calcCompute(sheets) {                                  // → compute(sid,A1) cached value
  const byId = Object.fromEntries(sheets.map((s) => [s.id, s])); const byName = Object.fromEntries(sheets.map((s) => [s.name.toLowerCase(), s]));
  const memo = new Map();
  function compute(sid, a1, stack) { const key = sid + "!" + a1; if (memo.has(key)) return memo.get(key); if (stack.has(key)) return { err: "#CYCLE!" };
    const s = byId[sid]; const raw = s && s.cells[a1]; if (raw == null || raw === "") { memo.set(key, ""); return ""; }
    if (String(raw)[0] === "=") { stack.add(key); const v = Formula.evaluate(String(raw).slice(1), { sheet: sid, resolve: (sh, c, r) => { const t = sh ? (byName[String(sh).toLowerCase()] || byId[sh]) : s; return t ? compute(t.id, refA1(c, r), stack) : ""; } }); stack.delete(key); memo.set(key, v); return v; }
    const n = Number(String(raw)); const v = !isNaN(n) && String(raw).trim() !== "" ? n : raw; memo.set(key, v); return v;
  }
  return (sid, a1) => compute(sid, a1, new Set());
}
function buildCalc(doc, sheets) {
  sheets.forEach((s, i) => { const id = i === 0 ? "s1" : s.id || "s" + Math.random().toString(16).slice(2, 8); s._id = id; doc.set("sheetmeta", id, { name: s.name || "Sheet" + (i + 1), ord: i }); });
  for (const s of sheets) { for (const a1 in s.cells) doc.set("cells", s._id + "!" + a1, s.cells[a1]); for (const a1 in (s.fmt || {})) if (Object.keys(s.fmt[a1]).length) doc.set("cellfmt", s._id + "!" + a1, s.fmt[a1]); }
}

// IMPRESS ─ slides [{bg,notes,els:[{type,x,y,w,h,text,fill,stroke,color,fontSize,align,bold,img:{bytes,mime}|dataURL}]}]
function readImpress(R) {
  const keys = R.mapKeys("slidemeta"); const m = new Map();
  for (const k of keys) { const v = R.val("slidemeta", k); if (v && !v.del) m.set(k, v); }
  if (!m.size) m.set("sl1", { ord: 0 });
  const order = [...m].sort((a, b) => (a[1].ord || 0) - (b[1].ord || 0) || (a[0] < b[0] ? -1 : 1));
  return order.map(([sid, meta]) => {
    const els = [];
    for (const id of R.mapKeys("elmeta")) { const em = R.val("elmeta", id); if (!em || em.del || em.slide !== sid) continue;
      const pos = R.val("elpos", id) || { x: 0.1, y: 0.1, w: 0.3, h: 0.15 }; const sty = R.val("elsty", id) || {};
      els.push({ id, type: em.type, z: em.z || 0, x: pos.x, y: pos.y, w: pos.w, h: pos.h, text: R.val("eltext", id) || "", src: R.val("elsrc", id) || "", ...sty }); }
    els.sort((a, b) => (a.z || 0) - (b.z || 0));
    return { id: sid, bg: meta.bg || "", notes: meta.notes || "", els };
  });
}
function buildImpress(doc, slides) {
  slides.forEach((s, i) => { const sid = i === 0 ? "sl1" : "s" + Math.random().toString(16).slice(2, 8); doc.set("slidemeta", sid, { ord: i, bg: s.bg || "", notes: s.notes || "" });
    s.els.forEach((e, j) => { const eid = "e" + Math.random().toString(16).slice(2, 10);
      doc.set("elmeta", eid, { slide: sid, type: e.type, z: j + 1, del: 0 });
      doc.set("elpos", eid, { x: e.x, y: e.y, w: e.w, h: e.h });
      const sty = {}; for (const k of ["fill", "stroke", "color", "fontSize", "align", "bold"]) if (e[k] != null) sty[k] = e[k]; if (Object.keys(sty).length) doc.set("elsty", eid, sty);
      if (e.type === "text") doc.set("eltext", eid, e.text || "");
      if (e.type === "image" && e.dataURL) doc.set("elsrc", eid, e.dataURL);
    });
  });
}

// ════════════════════════════════════ DOCX ════════════════════════════════════════
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const styleToType = { Heading1: "h1", Heading2: "h2", Heading3: "h3", Title: "h1", Quote: "quote" };
const typeToStyle = { h1: "Heading1", h2: "Heading2", h3: "Heading3", quote: "Quote" };
async function writeDocx(paras) {
  const body = paras.map((p) => {
    const ppr = []; if (typeToStyle[p.type]) ppr.push(`<w:pStyle w:val="${typeToStyle[p.type]}"/>`);
    if (p.type === "ul") ppr.push(`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`);
    if (p.type === "ol") ppr.push(`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>`);
    if (p.align) ppr.push(`<w:jc w:val="${p.align === "center" ? "center" : p.align === "right" ? "right" : p.align === "justify" ? "both" : "left"}"/>`);
    const runs = p.runs.map((r) => { const rpr = []; if (r.b) rpr.push("<w:b/>"); if (r.i) rpr.push("<w:i/>"); if (r.u) rpr.push('<w:u w:val="single"/>'); if (r.s) rpr.push("<w:strike/>"); if (r.color) rpr.push(`<w:color w:val="${aesc(r.color.replace("#", ""))}"/>`);
      return `<w:r>${rpr.length ? `<w:rPr>${rpr.join("")}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`; }).join("");
    return `<w:p>${ppr.length ? `<w:pPr>${ppr.join("")}</w:pPr>` : ""}${runs}</w:p>`;
  }).join("");
  const document = `${XMLHEAD}<w:document xmlns:w="${W_NS}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  const styles = `${XMLHEAD}<w:styles xmlns:w="${W_NS}">` +
    `<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>` +
    ["Heading1", "Heading2", "Heading3"].map((h, i) => `<w:style w:type="paragraph" w:styleId="${h}"><w:name w:val="heading ${i + 1}"/><w:pPr><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - i * 4}"/></w:rPr></w:style>`).join("") +
    `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:rPr><w:i/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style></w:styles>`;
  const numbering = `${XMLHEAD}<w:numbering xmlns:w="${W_NS}">` +
    `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  return zip([
    { name: "[Content_Types].xml", data: CT([["/word/document.xml", "wordprocessingml.document.main"], ["/word/styles.xml", "wordprocessingml.styles"], ["/word/numbering.xml", "wordprocessingml.numbering"]], "word") },
    { name: "_rels/.rels", data: RELS([["rId1", "officeDocument", "word/document.xml"]]) },
    { name: "word/_rels/document.xml.rels", data: RELS([["rId1", "styles", "styles.xml"], ["rId2", "numbering", "numbering.xml"]]) },
    { name: "word/document.xml", data: document }, { name: "word/styles.xml", data: styles }, { name: "word/numbering.xml", data: numbering },
  ]);
}
function readDocx(parts) {
  const root = parseXML(fromUtf8(parts.get("word/document.xml") || "")); const paras = [];
  for (const p of all(root, "p")) {
    const ppr = kid(p, "pPr"); let type = "p", align = "";
    if (ppr) { const ps = kid(ppr, "pStyle"); const sv = ps && attr(ps, "val"); if (sv && styleToType[sv]) type = styleToType[sv];
      const np = kid(ppr, "numPr"); if (np) { const nid = kid(np, "numId"); type = attr(nid, "val") === "2" ? "ol" : "ul"; }
      const jc = kid(ppr, "jc"); const jv = jc && attr(jc, "val"); if (jv) align = jv === "both" ? "justify" : jv; }
    const runs = [];
    for (const r of kids(p, "r")) { const rpr = kid(r, "rPr"); const t = kids(r, "t").map(allText).join("");
      if (!t) continue; const run = { text: t }; if (rpr) { if (kid(rpr, "b")) run.b = 1; if (kid(rpr, "i")) run.i = 1; if (kid(rpr, "u")) run.u = 1; if (kid(rpr, "strike")) run.s = 1; const col = kid(rpr, "color"); const cv = col && attr(col, "val"); if (cv && cv !== "auto") run.color = "#" + cv; } runs.push(run); }
    paras.push({ type, align, runs });
  }
  if (!paras.length) paras.push({ type: "p", align: "", runs: [] });
  return paras;
}

// ════════════════════════════════════ XLSX ════════════════════════════════════════
const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
async function writeXlsx(sheets) {
  const compute = calcCompute(sheets);
  const sheetXmls = sheets.map((s) => {
    const rows = {}; for (const a1 in s.cells) { const ref = parseA1(a1); if (!ref) continue; (rows[ref.row] ||= []).push({ a1, ref, raw: s.cells[a1] }); }
    const rowXml = Object.keys(rows).map(Number).sort((a, b) => a - b).map((r) => {
      const cells = rows[r].sort((a, b) => a.ref.col - b.ref.col).map(({ a1, raw }) => {
        if (raw[0] === "=") { const v = compute(s.id, a1); const cv = v && typeof v === "object" ? "" : (typeof v === "number" ? v : `<![CDATA[${v}]]>`); const t = typeof v === "string" ? ` t="str"` : ""; return `<c r="${a1}"${t}><f>${esc(raw.slice(1))}</f><v>${typeof v === "number" ? v : esc(String(v && v.err ? "" : v))}</v></c>`; }
        const n = Number(raw); if (raw.trim() !== "" && !isNaN(n)) return `<c r="${a1}"><v>${n}</v></c>`;
        return `<c r="${a1}" t="inlineStr"><is><t xml:space="preserve">${esc(raw)}</t></is></c>`;
      }).join(""); return `<row r="${r + 1}">${cells}</row>`;
    }).join("");
    return `${XMLHEAD}<worksheet xmlns="${S_NS}"><sheetData>${rowXml}</sheetData></worksheet>`;
  });
  const wbSheets = sheets.map((s, i) => `<sheet name="${aesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const workbook = `${XMLHEAD}<workbook xmlns="${S_NS}" xmlns:r="${R_NS}"><sheets>${wbSheets}</sheets></workbook>`;
  const wbRels = RELS([...sheets.map((s, i) => [`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`]), [`rId${sheets.length + 1}`, "styles", "styles.xml"]]);
  const styles = `${XMLHEAD}<styleSheet xmlns="${S_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;
  const files = [
    { name: "[Content_Types].xml", data: CT([["/xl/workbook.xml", "spreadsheetml.sheet.main"], ["/xl/styles.xml", "spreadsheetml.styles"], ...sheets.map((s, i) => [`/xl/worksheets/sheet${i + 1}.xml`, "spreadsheetml.worksheet"])], "xl") },
    { name: "_rels/.rels", data: RELS([["rId1", "officeDocument", "xl/workbook.xml"]]) },
    { name: "xl/_rels/workbook.xml.rels", data: wbRels }, { name: "xl/workbook.xml", data: workbook }, { name: "xl/styles.xml", data: styles },
    ...sheetXmls.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })),
  ];
  return zip(files);
}
function readXlsx(parts) {
  const shared = []; const sst = parts.get("xl/sharedStrings.xml"); if (sst) for (const si of all(parseXML(fromUtf8(sst)), "si")) shared.push(kids(si, "t").map(allText).join("") || all(si, "t").map(allText).join(""));
  const wb = parseXML(fromUtf8(parts.get("xl/workbook.xml") || "")); const rels = parseXML(fromUtf8(parts.get("xl/_rels/workbook.xml.rels") || ""));
  const relMap = {}; for (const r of all(rels, "Relationship")) relMap[attr(r, "Id")] = attr(r, "Target");
  const sheets = [];
  for (const sh of all(wb, "sheet")) {
    const name = attr(sh, "name") || "Sheet"; const rid = attr(sh, "r:id") || attr(sh, "id"); let target = relMap[rid] || "";
    if (target && !target.startsWith("xl/")) target = "xl/" + target.replace(/^\//, ""); const x = parts.get(target); if (!x) { sheets.push({ name, cells: {}, fmt: {} }); continue; }
    const ws = parseXML(fromUtf8(x)); const cells = {};
    for (const c of all(ws, "c")) { const a1 = attr(c, "r"); if (!a1) continue; const t = attr(c, "t"); const f = kid(c, "f");
      if (f) { cells[a1] = "=" + allText(f); continue; }
      if (t === "inlineStr") { cells[a1] = allText(kid(c, "is")); continue; }
      const v = kid(c, "v"); const raw = v ? allText(v) : ""; if (raw === "") continue;
      if (t === "s") cells[a1] = shared[+raw] ?? ""; else if (t === "str" || t === "b") cells[a1] = t === "b" ? (raw === "1" ? "TRUE" : "FALSE") : raw; else cells[a1] = raw;
    }
    sheets.push({ name, cells, fmt: {} });
  }
  if (!sheets.length) sheets.push({ name: "Sheet1", cells: {}, fmt: {} });
  return sheets;
}

// ════════════════════════════════════ PPTX ════════════════════════════════════════
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const EMU_W = 12192000, EMU_H = 6858000; const px2emu_w = (f) => Math.round(f * EMU_W), px2emu_h = (f) => Math.round(f * EMU_H);
async function writePptx(slides, getImage) {
  const media = []; // {name, bytes, ct}
  const slideXmls = []; const slideRels = [];
  let shapeId = 1;
  for (let si = 0; si < slides.length; si++) {
    const s = slides[si]; const rels = []; let body = "";
    for (const e of s.els) {
      shapeId++; const off = `<a:off x="${px2emu_w(e.x)}" y="${px2emu_h(e.y)}"/><a:ext cx="${px2emu_w(e.w)}" cy="${px2emu_h(e.h)}"/>`;
      if (e.type === "image") { const img = await getImage(e.src); if (img) { const ext = img.mime.includes("png") ? "png" : img.mime.includes("gif") ? "gif" : "jpg"; const nm = `image${media.length + 1}.${ext}`; media.push({ name: nm, bytes: img.bytes, ct: img.mime }); const rid = `rId${rels.length + 1}`; rels.push([rid, "image", `../media/${nm}`]);
        body += `<p:pic><p:nvPicPr><p:cNvPr id="${shapeId}" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm>${off}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`; continue; } }
      const geom = e.type === "ellipse" ? "ellipse" : "rect";
      const fill = e.type === "text" ? (e.fill ? `<a:solidFill><a:srgbClr val="${aesc((e.fill || "").replace("#", "") || "FFFFFF")}"/></a:solidFill>` : "") : `<a:solidFill><a:srgbClr val="${aesc(((e.fill) || (e.type === "ellipse" ? "#2dd4bf" : "#58a6ff")).replace("#", ""))}"/></a:solidFill>`;
      let txBody = "<p:txBody><a:bodyPr/><a:p/></p:txBody>";
      if (e.type === "text") { const algn = e.align === "center" ? ` algn="ctr"` : e.align === "right" ? ` algn="r"` : ""; const rpr = `sz="${(e.fontSize || 28) * 100}"${e.bold ? ' b="1"' : ""}`; const colorFill = e.color ? `<a:solidFill><a:srgbClr val="${aesc((e.color || "").replace("#", "") || "1F2328")}"/></a:solidFill>` : "";
        const lines = String(e.text || "").split("\n").map((ln) => `<a:p>${algn ? `<a:pPr${algn}/>` : ""}<a:r><a:rPr lang="en-US" ${rpr}>${colorFill}</a:rPr><a:t>${esc(ln)}</a:t></a:r></a:p>`).join("");
        txBody = `<p:txBody><a:bodyPr wrap="square"/>${lines || "<a:p/>"}</p:txBody>`; }
      body += `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId}" name="Shape ${shapeId}"/><p:cNvSpPr${e.type === "text" ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm>${off}</a:xfrm><a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill}</p:spPr>${txBody}</p:sp>`;
    }
    const bg = s.bg ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${aesc(s.bg.replace("#", ""))}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` : "";
    slideXmls.push(`${XMLHEAD}<p:sld xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`);
    rels.push([`rIdL`, "slideLayout", "../slideLayouts/slideLayout1.xml"]);
    slideRels.push(RELS(rels));
  }
  const presRels = RELS([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ...slides.map((_, i) => [`rId${i + 2}`, "slide", `slides/slide${i + 1}.xml`]), [`rId${slides.length + 2}`, "theme", "theme/theme1.xml"]]);
  const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  const presentation = `${XMLHEAD}<p:presentation xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${EMU_W}" cy="${EMU_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const theme = THEME1();
  const master = `${XMLHEAD}<p:sldMaster xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  const layout = `${XMLHEAD}<p:sldLayout xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`;
  const files = [
    { name: "[Content_Types].xml", data: CTpptx(slides.length, media) },
    { name: "_rels/.rels", data: RELS([["rId1", "officeDocument", "ppt/presentation.xml"]]) },
    { name: "ppt/presentation.xml", data: presentation }, { name: "ppt/_rels/presentation.xml.rels", data: presRels },
    { name: "ppt/theme/theme1.xml", data: theme },
    { name: "ppt/slideMasters/slideMaster1.xml", data: master }, { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: RELS([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rIdT", "theme", "../theme/theme1.xml"]]) },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: layout }, { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: RELS([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]) },
    ...slideXmls.map((x, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: x })),
    ...slideRels.map((x, i) => ({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: x })),
    ...media.map((m) => ({ name: `ppt/media/${m.name}`, data: m.bytes, store: false })),
  ];
  return zip(files);
}
function readPptx(parts) {
  const pres = parseXML(fromUtf8(parts.get("ppt/presentation.xml") || "")); const sz = all(pres, "sldSz")[0]; const W = +(attr(sz, "cx") || EMU_W), H = +(attr(sz, "cy") || EMU_H);
  const rels = parseXML(fromUtf8(parts.get("ppt/_rels/presentation.xml.rels") || "")); const relMap = {}; for (const r of all(rels, "Relationship")) relMap[attr(r, "Id")] = attr(r, "Target");
  const order = all(pres, "sldId").map((n) => attr(n, "r:id") || attr(n, "id")).map((rid) => relMap[rid]).filter(Boolean);
  const slides = [];
  for (const tgt of order) {
    const path = tgt.startsWith("ppt/") ? tgt : "ppt/" + tgt.replace(/^\//, ""); const xml = parts.get(path); if (!xml) continue;
    const sld = parseXML(fromUtf8(xml)); const els = []; let bg = "";
    const bgEl = all(sld, "bg")[0]; const bgClr = bgEl && all(bgEl, "solidFill")[0]; const bc = bgClr && kid(bgClr, "srgbClr"); if (bc) bg = "#" + attr(bc, "val");
    const srels = parseXML(fromUtf8(parts.get(path.replace(/slides\/(slide\d+\.xml)/, "slides/_rels/$1.rels")) || "")); const srelMap = {}; for (const r of all(srels, "Relationship")) srelMap[attr(r, "Id")] = attr(r, "Target");
    const tree = all(sld, "spTree")[0]; if (!tree) { slides.push({ bg, notes: "", els: [] }); continue; }
    for (const sp of kids(tree, "sp")) els.push(readShape(sp, W, H));
    for (const pic of kids(tree, "pic")) { const e = readFrame(pic, W, H, "image"); const blip = kid(kid(pic, "blipFill"), "blip"); const rid = blip && (attr(blip, "r:embed") || attr(blip, "embed")); let tg = srelMap[rid]; if (tg) { const mp = ("ppt/" + tg.replace(/^\.\.\//, "").replace(/^\//, "")); const b = parts.get(mp); if (b) e.dataURL = toDataURL(b, guessMime(mp)); } els.push(e); }
    slides.push({ bg, notes: "", els: els.filter(Boolean) });
  }
  if (!slides.length) slides.push({ bg: "", notes: "", els: [] });
  return slides;
}
function readFrame(node, W, H, type) {
  const xfrm = kid(kid(node, "spPr"), "xfrm"); const off = kid(xfrm, "off"), ext = kid(xfrm, "ext");
  return { type, x: off ? +attr(off, "x") / W : 0.1, y: off ? +attr(off, "y") / H : 0.1, w: ext ? +attr(ext, "cx") / W : 0.3, h: ext ? +attr(ext, "cy") / H : 0.2 };
}
function readShape(sp, W, H) {
  const geom = kid(kid(sp, "spPr"), "prstGeom"); const prst = geom && attr(geom, "prst");
  const tx = kid(sp, "txBody"); const hasText = tx && all(tx, "t").some((t) => allText(t).trim());
  const e = readFrame(sp, W, H, hasText ? "text" : prst === "ellipse" ? "ellipse" : "rect");
  const fillClr = kid(kid(kid(sp, "spPr"), "solidFill"), "srgbClr"); if (fillClr) e.fill = "#" + attr(fillClr, "val");
  if (hasText) { e.text = all(tx, "p").map((p) => all(p, "t").map(allText).join("")).join("\n");
    const rpr = kid(kid(kid(tx, "p"), "r"), "rPr"); if (rpr) { const sz = attr(rpr, "sz"); if (sz) e.fontSize = Math.round(+sz / 100); if (attr(rpr, "b") === "1") e.bold = 1; const cf = kid(kid(rpr, "solidFill"), "srgbClr"); if (cf) e.color = "#" + attr(cf, "val"); }
    const pPr = kid(kid(tx, "p"), "pPr"); const algn = pPr && attr(pPr, "algn"); if (algn === "ctr") e.align = "center"; else if (algn === "r") e.align = "right"; }
  return e;
}

// ════════════════════════════════════ ODF ═════════════════════════════════════════
const ODF = { text: "application/vnd.oasis.opendocument.text", spreadsheet: "application/vnd.oasis.opendocument.spreadsheet", presentation: "application/vnd.oasis.opendocument.presentation" };
const ODF_NS = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"`;
function odfManifest(kind, extra = []) {
  const entries = [`<manifest:file-entry manifest:full-path="/" manifest:media-type="${ODF[kind]}"/>`, `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>`, `<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>`, ...extra];
  return `${XMLHEAD}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">${entries.join("")}</manifest:manifest>`;
}
async function writeOdfDoc(contentBody, automatic, kind, extraFiles = []) {
  const content = `${XMLHEAD}<office:document-content ${ODF_NS} office:version="1.3"><office:automatic-styles>${automatic}</office:automatic-styles><office:body>${contentBody}</office:body></office:document-content>`;
  const styles = `${XMLHEAD}<office:document-styles ${ODF_NS} office:version="1.3"><office:styles/></office:document-styles>`;
  return zip([{ name: "mimetype", data: ODF[kind], store: true }, { name: "META-INF/manifest.xml", data: odfManifest(kind, extraFiles.map((f) => `<manifest:file-entry manifest:full-path="${f.name}" manifest:media-type="${f.ct}"/>`)) }, { name: "content.xml", data: content }, { name: "styles.xml", data: styles }, ...extraFiles.map((f) => ({ name: f.name, data: f.bytes, store: false }))]);
}
// ODT
async function writeOdt(paras) {
  const styles = []; const sIdx = { v: 0 }; const styleFor = (run) => { const props = []; if (run.b) props.push(`fo:font-weight="bold"`); if (run.i) props.push(`fo:font-style="italic"`); if (run.u) props.push(`style:text-underline-style="solid"`); if (run.s) props.push(`style:text-line-through-style="solid"`); if (run.color) props.push(`fo:color="${aesc(run.color)}"`); if (!props.length) return ""; const name = "T" + ++sIdx.v; styles.push(`<style:style style:name="${name}" style:family="text"><style:text-properties ${props.join(" ")}/></style:style>`); return name; };
  const body = paras.map((p) => {
    const isH = p.type === "h1" || p.type === "h2" || p.type === "h3"; const lvl = isH ? p.type[1] : 0;
    let pStyleName = ""; if (p.align) { pStyleName = "P" + ++sIdx.v; styles.push(`<style:style style:name="${pStyleName}" style:family="paragraph"><style:paragraph-properties fo:text-align="${p.align === "center" ? "center" : p.align === "right" ? "end" : p.align === "justify" ? "justify" : "start"}"/></style:style>`); }
    const inner = p.runs.map((r) => { const sn = styleFor(r); return sn ? `<text:span text:style-name="${sn}">${esc(r.text)}</text:span>` : esc(r.text); }).join("");
    const attrs = pStyleName ? ` text:style-name="${pStyleName}"` : "";
    if (isH) return `<text:h text:outline-level="${lvl}"${attrs}>${inner}</text:h>`;
    if (p.type === "ul" || p.type === "ol") return `<text:list><text:list-item><text:p${attrs}>${inner}</text:p></text:list-item></text:list>`;
    return `<text:p${attrs}>${inner}</text:p>`;
  }).join("");
  return writeOdfDoc(`<office:text>${body}</office:text>`, styles.join(""), "text");
}
function readOdt(parts) {
  const root = parseXML(fromUtf8(parts.get("content.xml") || "")); const styleMap = odfTextStyles(root); const paras = [];
  const body = all(root, "text")[0]; if (!body) return [{ type: "p", align: "", runs: [] }];
  const walk = (container) => { for (const node of container.children) { const ln = local(node.tag);
    if (ln === "h" || ln === "p") { const type = ln === "h" ? "h" + (attr(node, "outline-level") || "1") : "p"; paras.push({ type: type === "h1" || type === "h2" || type === "h3" ? type : (ln === "h" ? "h3" : "p"), align: "", runs: odfRuns(node, styleMap) }); }
    else if (ln === "list") { for (const li of all(node, "p")) paras.push({ type: "ul", align: "", runs: odfRuns(li, styleMap) }); }
  } };
  walk(body); if (!paras.length) paras.push({ type: "p", align: "", runs: [] });
  return paras;
}
function odfTextStyles(root) { const map = {}; for (const s of all(root, "style")) { if (attr(s, "family") !== "text") continue; const tp = kid(s, "text-properties"); if (!tp) continue; const m = {}; if (attr(tp, "font-weight") === "bold") m.b = 1; if (attr(tp, "font-style") === "italic") m.i = 1; if (attr(tp, "text-underline-style") && attr(tp, "text-underline-style") !== "none") m.u = 1; if (attr(tp, "text-line-through-style") && attr(tp, "text-line-through-style") !== "none") m.s = 1; const col = attr(tp, "color"); if (col) m.color = col; map[attr(s, "name")] = m; } return map; }
function odfRuns(p, styleMap) { const runs = []; const visit = (node, inherited) => { for (const c of node.children) { if (local(c.tag) === "span") { const m = { ...inherited, ...(styleMap[attr(c, "style-name")] || {}) }; if (c.text) runs.push({ text: c.text, ...m }); visit(c, m); } else if (local(c.tag) === "s") { runs.push({ text: " ".repeat(+(attr(c, "c") || 1)), ...inherited }); } } if (node.text) runs.unshift({ text: node.text, ...inherited }); };
  // direct text + spans
  if (p.text) runs.push({ text: p.text }); for (const c of p.children) { if (local(c.tag) === "span") { const m = styleMap[attr(c, "style-name")] || {}; runs.push({ text: allText(c), ...m }); } else if (local(c.tag) === "s") runs.push({ text: " " }); }
  return runs.length ? runs : [{ text: "" }];
}
// ODS — ODF formula dialect: of:=SUM([.A1:.B2]); refs [.A1]
const toOdfFormula = (f) => "of:=" + f.replace(/(\$?[A-Za-z]+\$?\d+)(?::(\$?[A-Za-z]+\$?\d+))?/g, (m, a, b) => b ? `[.${a}:.${b}]` : `[.${a}]`);
const fromOdfFormula = (f) => String(f).replace(/^of:=|^oooc:=|^=/,"").replace(/\[\.(\$?[A-Za-z]+\$?\d+)(?::\.?(\$?[A-Za-z]+\$?\d+))?\]/g, (m, a, b) => b ? `${a}:${b}` : a);
async function writeOds(sheets) {
  const compute = calcCompute(sheets);
  const tables = sheets.map((s) => {
    let maxR = 0, maxC = 0; for (const a1 in s.cells) { const r = parseA1(a1); if (r) { maxR = Math.max(maxR, r.row); maxC = Math.max(maxC, r.col); } }
    let rowsXml = ""; for (let r = 0; r <= maxR; r++) { let cellsXml = ""; for (let c = 0; c <= maxC; c++) { const a1 = numToCol(c) + (r + 1); const raw = s.cells[a1];
      if (raw == null || raw === "") { cellsXml += "<table:table-cell/>"; continue; }
      if (raw[0] === "=") { const v = compute(s.id, a1); const isNum = typeof v === "number"; cellsXml += `<table:table-cell table:formula="${aesc(toOdfFormula(raw.slice(1)))}" office:value-type="${isNum ? "float" : "string"}"${isNum ? ` office:value="${v}"` : ""}><text:p>${esc(isNum ? v : (v && v.err ? v.err : v))}</text:p></table:table-cell>`; continue; }
      const n = Number(raw); if (raw.trim() !== "" && !isNaN(n)) cellsXml += `<table:table-cell office:value-type="float" office:value="${n}"><text:p>${esc(raw)}</text:p></table:table-cell>`;
      else cellsXml += `<table:table-cell office:value-type="string"><text:p>${esc(raw)}</text:p></table:table-cell>`; }
      rowsXml += `<table:table-row>${cellsXml}</table:table-row>`; }
    return `<table:table table:name="${aesc(s.name)}">${rowsXml}</table:table>`;
  }).join("");
  return writeOdfDoc(`<office:spreadsheet>${tables}</office:spreadsheet>`, "", "spreadsheet");
}
function readOds(parts) {
  const root = parseXML(fromUtf8(parts.get("content.xml") || "")); const sheets = [];
  for (const t of all(root, "table")) { const name = attr(t, "name") || "Sheet"; const cells = {}; let r = 0;
    for (const row of kids(t, "table-row")) { let c = 0; const rep = +(attr(row, "number-rows-repeated") || 1);
      for (const cell of kids(row, "table-cell")) { const span = +(attr(cell, "number-columns-repeated") || 1); const f = attr(cell, "formula"); const vt = attr(cell, "value-type"); const val = attr(cell, "value");
        let raw = ""; if (f) raw = "=" + fromOdfFormula(f); else if (vt === "float" || vt === "percentage" || vt === "currency") raw = val != null ? String(val) : allText(cell); else raw = all(cell, "p").map(allText).join("\n");
        if (raw !== "") for (let k = 0; k < span; k++) cells[numToCol(c + k) + (r + 1)] = raw; c += span; }
      r += rep; }
    sheets.push({ name, cells, fmt: {} });
  }
  if (!sheets.length) sheets.push({ name: "Sheet1", cells: {}, fmt: {} });
  return sheets;
}
// ODP
const CM_W = 25.4, CM_H = 14.288;            // 16:9 page in cm
async function writeOdp(slides, getImage) {
  const media = []; const styles = []; const sIdx = { v: 0 };
  const pages = []; let pi = 0;
  for (const s of slides) { pi++; let frames = "";
    for (const e of s.els) { const x = (e.x * CM_W).toFixed(3), y = (e.y * CM_H).toFixed(3), w = (e.w * CM_W).toFixed(3), hh = (e.h * CM_H).toFixed(3); const pos = `svg:x="${x}cm" svg:y="${y}cm" svg:width="${w}cm" svg:height="${hh}cm"`;
      if (e.type === "image") { const img = await getImage(e.src); if (img) { const ext = img.mime.includes("png") ? "png" : img.mime.includes("gif") ? "gif" : "jpg"; const nm = `Pictures/img${media.length + 1}.${ext}`; media.push({ name: nm, bytes: img.bytes, ct: img.mime }); frames += `<draw:frame ${pos}><draw:image xlink:href="${nm}" xlink:type="simple"/></draw:frame>`; continue; } }
      if (e.type === "text") { const gs = "gr" + ++sIdx.v; styles.push(`<style:style style:name="${gs}" style:family="graphic"><style:graphic-properties draw:fill="none" draw:stroke="none"/></style:style>`); const ps = "pp" + ++sIdx.v; styles.push(`<style:style style:name="${ps}" style:family="paragraph"><style:paragraph-properties fo:text-align="${e.align === "center" ? "center" : e.align === "right" ? "end" : "start"}"/><style:text-properties fo:font-size="${e.fontSize || 28}pt"${e.bold ? ' fo:font-weight="bold"' : ""}${e.color ? ` fo:color="${aesc(e.color)}"` : ""}/></style:style>`);
        const lines = String(e.text || "").split("\n").map((ln) => `<text:p text:style-name="${ps}">${esc(ln)}</text:p>`).join(""); frames += `<draw:frame draw:style-name="${gs}" ${pos}><draw:text-box>${lines}</draw:text-box></draw:frame>`; continue; }
      const gs = "gr" + ++sIdx.v; const fill = (e.fill || (e.type === "ellipse" ? "#2dd4bf" : "#58a6ff")); styles.push(`<style:style style:name="${gs}" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="${aesc(fill)}"/></style:style>`);
      frames += `<draw:${e.type === "ellipse" ? "ellipse" : "rect"} draw:style-name="${gs}" ${pos}/>`;
    }
    pages.push(`<draw:page draw:name="Slide ${pi}">${frames}${s.notes ? `<presentation:notes><draw:frame svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="8cm"><draw:text-box><text:p>${esc(s.notes)}</text:p></draw:text-box></draw:frame></presentation:notes>` : ""}</draw:page>`);
  }
  return writeOdfDoc(`<office:presentation>${pages.join("")}</office:presentation>`, styles.join(""), "presentation", media.map((m) => ({ name: m.name, bytes: m.bytes, ct: m.ct })));
}
function readOdp(parts) {
  const root = parseXML(fromUtf8(parts.get("content.xml") || "")); const styleMap = {};
  for (const s of all(root, "style")) { const gp = kid(s, "graphic-properties"); const tp = kid(s, "text-properties"); const pp = kid(s, "paragraph-properties"); styleMap[attr(s, "name")] = { fill: gp && attr(gp, "fill-color"), fontSize: tp && attr(tp, "font-size"), bold: tp && attr(tp, "font-weight") === "bold", color: tp && attr(tp, "color"), align: pp && attr(pp, "text-align") }; }
  const slides = [];
  for (const pg of all(root, "page")) { const els = [];
    for (const fr of kids(pg, "frame")) { const x = parseLen(attr(fr, "x")) / CM_W, y = parseLen(attr(fr, "y")) / CM_H, w = parseLen(attr(fr, "width")) / CM_W, h = parseLen(attr(fr, "height")) / CM_H;
      const tb = kid(fr, "text-box"); const img = kid(fr, "image");
      if (img) { const href = attr(img, "href"); const b = parts.get(href) || parts.get(href.replace(/^\//, "")); els.push({ type: "image", x, y, w, h, dataURL: b ? toDataURL(b, guessMime(href)) : "" }); }
      else if (tb) { const st = styleMap[attr(kid(tb, "p"), "style-name")] || {}; const text = all(tb, "p").map(allText).join("\n"); els.push({ type: "text", x, y, w, h, text, fontSize: st.fontSize ? Math.round(parseFloat(st.fontSize)) : 28, bold: st.bold ? 1 : 0, color: st.color, align: st.align === "center" ? "center" : st.align === "end" ? "right" : "left" }); } }
    for (const sh of [...kids(pg, "rect"), ...kids(pg, "ellipse"), ...kids(pg, "custom-shape")]) { const x = parseLen(attr(sh, "x")) / CM_W, y = parseLen(attr(sh, "y")) / CM_H, w = parseLen(attr(sh, "width")) / CM_W, h = parseLen(attr(sh, "height")) / CM_H; const st = styleMap[attr(sh, "style-name")] || {}; els.push({ type: local(sh.tag) === "ellipse" ? "ellipse" : "rect", x, y, w, h, fill: st.fill }); }
    slides.push({ bg: "", notes: "", els });
  }
  if (!slides.length) slides.push({ bg: "", notes: "", els: [] });
  return slides;
}
function parseLen(s) { if (!s) return 0; const v = parseFloat(s); if (s.endsWith("cm")) return v; if (s.endsWith("mm")) return v / 10; if (s.endsWith("in")) return v * 2.54; if (s.endsWith("pt")) return v * 0.0352778; return v; }

// ════════════════════════════════ shared OOXML bits ═══════════════════════════════
const CT_TYPE = (t) => `application/vnd.openxmlformats-officedocument.${t}+xml`;
function CT(overrides, _root) {
  return `${XMLHEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([part, t]) => `<Override PartName="${part}" ContentType="${CT_TYPE(t)}"/>`).join("")}</Types>`;
}
function CTpptx(nSlides, media) {
  const exts = new Set(media.map((m) => m.name.split(".").pop())); const defs = [...exts].map((e) => `<Default Extension="${e}" ContentType="image/${e === "jpg" ? "jpeg" : e}"/>`).join("");
  const ov = [["/ppt/presentation.xml", "presentationml.presentation.main"], ["/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster"], ["/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout"], ["/ppt/theme/theme1.xml", "theme"]];
  for (let i = 0; i < nSlides; i++) ov.push([`/ppt/slides/slide${i + 1}.xml`, "presentationml.slide"]);
  const themeCT = `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`;
  const overrides = ov.filter(([p]) => !p.endsWith("theme1.xml")).map(([part, t]) => `<Override PartName="${part}" ContentType="${CT_TYPE(t)}"/>`).join("");
  return `${XMLHEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defs}${overrides}${themeCT}</Types>`;
}
function RELS(rels) {
  return `${XMLHEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`;
}
function THEME1() {
  const c = (n, v) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
  return `${XMLHEAD}<a:theme xmlns:a="${A_NS}" name="Holo"><a:themeElements><a:clrScheme name="Holo"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>${c("dk2", "1F2328")}${c("lt2", "EEEEEE")}${c("accent1", "2DD4BF")}${c("accent2", "58A6FF")}${c("accent3", "D2A8FF")}${c("accent4", "F2CC60")}${c("accent5", "7EE787")}${c("accent6", "FF7B72")}${c("hlink", "0969DA")}${c("folHlink", "8250DF")}</a:clrScheme><a:fontScheme name="Holo"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Holo"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

// ════════════════════════════ images / data URLs ══════════════════════════════════
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToB64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 3) { const a = u8[i], b = u8[i + 1], c = u8[i + 2]; s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (b === undefined ? "=" : B64[((b & 15) << 2) | (c >> 6)]) + (c === undefined ? "=" : B64[c & 63]); } return s; }
function b64ToBytes(b64) { b64 = b64.replace(/[^A-Za-z0-9+/]/g, ""); const out = []; for (let i = 0; i < b64.length; i += 4) { const a = B64.indexOf(b64[i]), b = B64.indexOf(b64[i + 1]), c = B64.indexOf(b64[i + 2]), d = B64.indexOf(b64[i + 3]); out.push((a << 2) | (b >> 4)); if (c >= 0) out.push(((b & 15) << 4) | (c >> 2)); if (d >= 0) out.push(((c & 3) << 6) | d); } return new Uint8Array(out); }
const toDataURL = (u8, mime) => `data:${mime};base64,${bytesToB64(u8)}`;
function guessMime(name) { const e = name.split(".").pop().toLowerCase(); return e === "png" ? "image/png" : e === "gif" ? "image/gif" : e === "svg" ? "image/svg+xml" : e === "webp" ? "image/webp" : "image/jpeg"; }
// resolve an impress elsrc (a content-addressed κ via session, or an inline data: URL) → {bytes,mime}
function imageGetter(R) { return async (src) => { if (!src) return null; if (src.startsWith("data:")) { const m = /^data:([^;]+);base64,(.*)$/.exec(src); return m ? { bytes: b64ToBytes(m[2]), mime: m[1] } : null; } const bytes = await R.getAsset(src); return bytes ? { bytes, mime: "image/png" } : null; }; }

// ═══════════════════════════════════ public API ═══════════════════════════════════
export const FORMATS = {
  writer: [{ fmt: "docx", label: "Word (.docx — OOXML)" }, { fmt: "odt", label: "OpenDocument Text (.odt — ODF)" }],
  calc: [{ fmt: "xlsx", label: "Excel (.xlsx — OOXML)" }, { fmt: "ods", label: "OpenDocument Spreadsheet (.ods — ODF)" }],
  impress: [{ fmt: "pptx", label: "PowerPoint (.pptx — OOXML)" }, { fmt: "odp", label: "OpenDocument Presentation (.odp — ODF)" }],
};
const MIME = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", odt: ODF.text, ods: ODF.spreadsheet, odp: ODF.presentation };

export async function exportInterop(kind, R, fmt) {
  let bytes, name = "document." + fmt;
  if (fmt === "docx") bytes = await writeDocx(readWriter(R));
  else if (fmt === "odt") bytes = await writeOdt(readWriter(R));
  else if (fmt === "xlsx") bytes = await writeXlsx(readCalc(R));
  else if (fmt === "ods") bytes = await writeOds(readCalc(R));
  else if (fmt === "pptx") bytes = await writePptx(readImpress(R), imageGetter(R));
  else if (fmt === "odp") bytes = await writeOdp(readImpress(R), imageGetter(R));
  else throw new Error("unknown format " + fmt);
  return { name, mime: MIME[fmt], blob: new Blob([bytes], { type: MIME[fmt] }) };
}

export function detectKind(name, parts) {
  if (parts) { if (parts.has("word/document.xml")) return { kind: "writer", fmt: "docx" }; if (parts.has("xl/workbook.xml")) return { kind: "calc", fmt: "xlsx" }; if (parts.has("ppt/presentation.xml")) return { kind: "impress", fmt: "pptx" };
    const mt = parts.get("mimetype"); const s = mt ? fromUtf8(mt) : ""; if (s.includes("text")) return { kind: "writer", fmt: "odt" }; if (s.includes("spreadsheet")) return { kind: "calc", fmt: "ods" }; if (s.includes("presentation")) return { kind: "impress", fmt: "odp" }; }
  const e = (name || "").toLowerCase().split(".").pop();
  return ({ docx: { kind: "writer", fmt: "docx" }, odt: { kind: "writer", fmt: "odt" }, xlsx: { kind: "calc", fmt: "xlsx" }, ods: { kind: "calc", fmt: "ods" }, pptx: { kind: "impress", fmt: "pptx" }, odp: { kind: "impress", fmt: "odp" } })[e] || null;
}

// Parse an imported file (ArrayBuffer/Uint8Array + name) → { kind, snapshot } using a
// holo-collab Doc constructor (opts.Doc; defaults to the global HoloCollab.Doc).
export async function importFile(buf, name, opts = {}) {
  const Doc = opts.Doc || (globalThis.HoloCollab && globalThis.HoloCollab.Doc);
  if (!Doc) throw new Error("HoloCollab.Doc unavailable");
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const parts = await unzip(u8); const det = detectKind(name, parts); if (!det) throw new Error("unrecognized document format");
  const doc = new Doc(det.kind);
  if (det.fmt === "docx") buildWriter(doc, readDocx(parts));
  else if (det.fmt === "odt") buildWriter(doc, readOdt(parts));
  else if (det.fmt === "xlsx") buildCalc(doc, readXlsx(parts));
  else if (det.fmt === "ods") buildCalc(doc, readOds(parts));
  else if (det.fmt === "pptx") buildImpress(doc, readPptx(parts));
  else if (det.fmt === "odp") buildImpress(doc, readOdp(parts));
  return { kind: det.kind, fmt: det.fmt, snapshot: doc.snapshot() };
}

export default { FORMATS, exportInterop, importFile, detectKind, docReader, parseXML };
