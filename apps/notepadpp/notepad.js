// notepad.js — the host shell that wires the vendored CodeMirror 6 engine
// (codemirror/codemirror.bundle.mjs) into a Notepad++-style, tabbed editor.
// All editing behaviour is upstream CodeMirror; this file is integration glue:
// it builds the extension set, manages tabs/documents, and binds toolbar + I/O.
import {
  EditorState, Compartment, EditorView, keymap, lineNumbers,
  highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor,
  defaultKeymap, history, historyKeymap, indentWithTab,
  syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching,
  foldGutter, foldKeymap,
  searchKeymap, highlightSelectionMatches, search, openSearchPanel,
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
  oneDark, LANGUAGES,
} from "./codemirror/codemirror.bundle.mjs";

// ── language registry ──────────────────────────────────────────────────────
const LANG_LABEL = {
  javascript: "JavaScript", jsx: "JSX", typescript: "TypeScript", tsx: "TSX",
  html: "HTML", css: "CSS", json: "JSON", python: "Python", cpp: "C / C++",
  java: "Java", markdown: "Markdown", xml: "XML", sql: "SQL", rust: "Rust",
  php: "PHP", go: "Go", yaml: "YAML",
};
const EXT_LANG = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", tsx: "tsx", html: "html", htm: "html", css: "css",
  json: "json", py: "python", c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp",
  hpp: "cpp", cxx: "cpp", java: "java", md: "markdown", markdown: "markdown",
  xml: "xml", svg: "xml", sql: "sql", rs: "rust", php: "php", go: "go",
  yml: "yaml", yaml: "yaml",
};
const langFromName = (name) => EXT_LANG[(name.split(".").pop() || "").toLowerCase()] || "";

// ── per-document compartments (reconfigured live, no editor rebuild) ─────────
const cLang = new Compartment();
const cWrap = new Compartment();

// The shared base extension set — equivalent to CodeMirror's basicSetup, built
// from the vendored primitives so it stays offline and self-contained.
function baseExtensions() {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
      ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
    ]),
    oneDark,
    EditorView.updateListener.of((u) => { if (u.docChanged || u.selectionSet) onEditorChange(u); }),
  ];
}

function langExt(id) {
  const make = LANGUAGES[id];
  return make ? make() : [];
}

// ── document model ──────────────────────────────────────────────────────────
let docs = [];          // [{ id, name, lang, state, saved }]
let activeId = null;
let nextId = 1;
let view = null;
const host = document.getElementById("editorHost");

function makeState(text, lang) {
  return EditorState.create({
    doc: text,
    extensions: [
      baseExtensions(),
      cLang.of(langExt(lang)),
      cWrap.of(wrapOn ? EditorView.lineWrapping : []),
    ],
  });
}

function newDoc(name, text = "", lang = "") {
  const id = nextId++;
  const d = { id, name: name || `untitled-${id}.txt`, lang: lang || langFromName(name || ""), saved: text === "", text };
  d.state = makeState(text, d.lang);
  docs.push(d);
  return d;
}

function activate(id) {
  // stash current editor state back into its doc
  if (view && activeId != null) {
    const cur = docs.find((d) => d.id === activeId);
    if (cur) cur.state = view.state;
  }
  const d = docs.find((x) => x.id === id);
  if (!d) return;
  activeId = id;
  if (view) view.destroy();
  view = new EditorView({ state: d.state, parent: host });
  view.focus();
  // sync language compartment toggles to this doc
  syncLangSelect(d.lang);
  document.getElementById("wrap").checked = wrapOn;
  renderTabs();
  updateStatus();
  persist();
}

function closeDoc(id) {
  const i = docs.findIndex((d) => d.id === id);
  if (i < 0) return;
  const d = docs[i];
  if (!d.saved && !confirm(`"${d.name}" has unsaved changes. Close anyway?`)) return;
  docs.splice(i, 1);
  if (docs.length === 0) { const nd = newDoc(); activate(nd.id); return; }
  if (activeId === id) activate(docs[Math.max(0, i - 1)].id);
  else { renderTabs(); persist(); }
}

// ── editor change → status + dirty flag ──────────────────────────────────────
function onEditorChange(u) {
  const d = docs.find((x) => x.id === activeId);
  if (d && u.docChanged) { d.saved = false; renderTabs(); }
  updateStatus();
  if (u.docChanged) schedulePersist();
}

function updateStatus() {
  if (!view) return;
  const s = view.state;
  const head = s.selection.main.head;
  const line = s.doc.lineAt(head);
  document.getElementById("ln").textContent = line.number;
  document.getElementById("col").textContent = head - line.from + 1;
  let sel = 0;
  for (const r of s.selection.ranges) sel += r.to - r.from;
  document.getElementById("sel").textContent = sel;
  document.getElementById("len").textContent = s.doc.length;
  document.getElementById("lines").textContent = s.doc.lines;
  const d = docs.find((x) => x.id === activeId);
  document.getElementById("langLabel").textContent = d && d.lang ? (LANG_LABEL[d.lang] || d.lang) : "Plain text";
}

// ── tabs ──────────────────────────────────────────────────────────────────
const tabsEl = document.getElementById("tabs");
function renderTabs() {
  tabsEl.textContent = "";
  for (const d of docs) {
    const t = document.createElement("div");
    t.className = "tab" + (d.id === activeId ? " on" : "");
    t.setAttribute("role", "tab");
    t.onclick = (e) => { if (!e.target.closest(".x")) activate(d.id); };
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = (d.saved ? "" : "● ") + d.name;
    if (!d.saved) name.classList.add("dirty");
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "×"; x.title = "Close (Ctrl+W)";
    x.onclick = () => closeDoc(d.id);
    t.append(name, x);
    tabsEl.append(t);
  }
  const add = document.createElement("div");
  add.className = "tab add"; add.textContent = "+"; add.title = "New tab (Ctrl+N)";
  add.onclick = () => { const d = newDoc(); activate(d.id); };
  tabsEl.append(add);
}

// ── language selector ────────────────────────────────────────────────────────
const langSel = document.getElementById("lang");
(function fillLangSelect() {
  const plain = document.createElement("option");
  plain.value = ""; plain.textContent = "Plain text";
  langSel.append(plain);
  for (const id of Object.keys(LANGUAGES)) {
    const o = document.createElement("option");
    o.value = id; o.textContent = LANG_LABEL[id] || id;
    langSel.append(o);
  }
})();
function syncLangSelect(lang) { langSel.value = lang || ""; }
langSel.onchange = () => {
  const d = docs.find((x) => x.id === activeId);
  if (!d) return;
  d.lang = langSel.value;
  view.dispatch({ effects: cLang.reconfigure(langExt(d.lang)) });
  updateStatus();
  persist();
};

// ── word wrap ────────────────────────────────────────────────────────────────
let wrapOn = false;
const wrapBox = document.getElementById("wrap");
wrapBox.onchange = () => {
  wrapOn = wrapBox.checked;
  if (view) view.dispatch({ effects: cWrap.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
  persist();
};

// ── file I/O (open via picker, save via download) ────────────────────────────
const fileIn = document.getElementById("fileIn");
document.getElementById("bOpen").onclick = () => fileIn.click();
fileIn.onchange = async () => {
  const files = [...fileIn.files];
  let last = null;
  for (const f of files) {
    const text = await f.text();
    last = newDoc(f.name, text, langFromName(f.name));
    last.saved = true;
  }
  if (last) activate(last.id);
  fileIn.value = "";
};

document.getElementById("bNew").onclick = () => { const d = newDoc(); activate(d.id); };

function saveActive() {
  const d = docs.find((x) => x.id === activeId);
  if (!d || !view) return;
  const text = view.state.doc.toString();
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = d.name; a.click();
  URL.revokeObjectURL(url);
  d.saved = true; renderTabs(); persist();
}
document.getElementById("bSave").onclick = saveActive;
document.getElementById("bFind").onclick = () => { if (view) { openSearchPanel(view); view.focus(); } };

// ── keyboard shortcuts at the document level ─────────────────────────────────
window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;        // host-adaptive: Ctrl on Windows/Linux, Cmd on Apple
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "s") { e.preventDefault(); saveActive(); }
  else if (k === "n") { e.preventDefault(); const d = newDoc(); activate(d.id); }
  else if (k === "o") { e.preventDefault(); fileIn.click(); }
  else if (k === "w") { e.preventDefault(); if (activeId != null) closeDoc(activeId); }
});

// ── persistence (localStorage; capability: storage) ──────────────────────────
const LS_KEY = "org.hologram.HoloNotepadPP/session";
let persistTimer = 0;
function schedulePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 400); }
function persist() {
  try {
    if (view && activeId != null) {
      const cur = docs.find((d) => d.id === activeId);
      if (cur) cur.text = view.state.doc.toString();
    }
    const snap = {
      activeId, wrapOn,
      docs: docs.map((d) => ({
        id: d.id, name: d.name, lang: d.lang, saved: d.saved,
        text: d.id === activeId && view ? view.state.doc.toString() : (d.state ? d.state.doc.toString() : d.text || ""),
      })),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(snap));
  } catch {}
}
function restore() {
  try {
    const snap = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (snap && Array.isArray(snap.docs) && snap.docs.length) {
      wrapOn = !!snap.wrapOn;
      for (const r of snap.docs) {
        const d = newDoc(r.name, r.text || "", r.lang || "");
        d.saved = r.saved !== false && (r.text || "") !== "";
      }
      const want = docs[Math.min(docs.length - 1, Math.max(0, snap.docs.findIndex((d) => d.id === snap.activeId)))];
      activate((want || docs[0]).id);
      return true;
    }
  } catch {}
  return false;
}

// ── boot ──────────────────────────────────────────────────────────────────
if (!restore()) {
  const welcome = newDoc("welcome.md",
`# Holo Notepad++

A fast, lightweight source-code editor — served from your own machine.

- New / Open / Save in the toolbar (Ctrl+N / Ctrl+O / Ctrl+S)
- Ctrl+F to find and replace
- Pick a language for syntax highlighting, or it auto-detects from the file name
- Open as many tabs as you like

Powered by CodeMirror 6, vendored verbatim. No server. No CDN.
`, "markdown");
  welcome.saved = true;
  activate(welcome.id);
}
