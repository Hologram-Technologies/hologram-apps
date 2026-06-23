// holo-code-tools.mjs — the Holo Code tool catalog, the substrate-native answer to Claude Code's
// agent tools (FileRead/FileWrite/FileEdit/Glob/Grep/Bash/…). Every tool operates over the OS's
// content-addressed file graph (holo-files VFS) and the Holo SDK verbs (Forge build/run, share),
// and every result carries the did:holo κ of the bytes it touched — so a tool call is verifiable by
// re-derivation (Law L5), not taken on trust. No foreign runtime: we compose the engines the OS
// already ships. The agent's writable workspace is your OPFS Home (/home/user), exactly the plane
// Holo Files writes; the immutable substrate (this Hologram, every holospace, the OS runtime) is
// readable by the same VFS.

import * as VFS from "./_shared/holo-files.js";
import * as SKILLS from "../q/core/skills.js";   // self-evolving, UOR-sealed skills (shared with Holo Q)
// Holo SDK façade (QVAC-style flat imports). Resolved by content via the "@hologram/sdk" importmap.
let SDK = null;
async function sdk() {
  if (SDK) return SDK;
  try { SDK = await import("@hologram/sdk"); } catch { SDK = {}; }
  return SDK;
}

// ── OPFS Home helpers — the one writable plane (W3C OPFS), same primitive holo-files uses ────────
const HOME = "/home/user";
const homeParts = (p) => String(p).replace(/^\/?home\/user\/?/, "").replace(/^\//, "").split("/").filter(Boolean);
const norm = (p) => HOME + (homeParts(p).length ? "/" + homeParts(p).join("/") : "");
async function opfsRoot() { return navigator.storage.getDirectory(); }
async function ensureDir(parts) { let d = await opfsRoot(); for (const seg of parts) d = await d.getDirectoryHandle(seg, { create: true }); return d; }
function opfsNode(path) { const name = homeParts(path).pop() || ""; return { source: "opfs", kind: "file", path: norm(path), name, mime: VFS.mimeOf(name) }; }

const td = new TextDecoder(); const te = new TextEncoder();
const isText = (mime) => !mime || /^text\/|json|javascript|xml|svg|yaml|markdown|x-sh|application\/(ld\+json|wasm)?$/.test(mime) || true;

// the did:holo κ of a set of bytes — re-derived from content (Law L5). VFS.verify exposes the
// derived address even with no pinned κ, so we never duplicate the hash function.
async function kappaOf(node) { try { const v = await VFS.verify(node); return v.derived ? "did:holo:sha256:" + v.derived : ""; } catch { return ""; } }

// ── recursive Home walk — the basis for glob/grep (no shell, no ripgrep; the VFS is the index) ──
async function walkHome(start = HOME, out = []) {
  let kids;
  try { kids = await VFS.list({ source: "opfs", kind: "location", path: start }); } catch { return out; }
  for (const n of kids) {
    if (n.kind === "dir") await walkHome(n.path, out);
    else out.push(n);
  }
  return out;
}
// a tiny glob → RegExp (supports ** , * , ? and literal segments).
function globToRe(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") { if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; } else re += "[^/]*"; }
    else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$");
}

// ── unified diff (Claude Code's FileEdit shows old→new); a minimal line diff, no dependency ──────
export function lineDiff(oldText, newText) {
  const a = String(oldText).split("\n"), b = String(newText).split("\n");
  const out = []; let i = 0, j = 0;
  // LCS-lite: walk both, emit context/added/removed. Good enough for the viewer.
  const setB = new Map(); b.forEach((l, k) => { if (!setB.has(l)) setB.set(l, []); setB.get(l).push(k); });
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ t: " ", line: a[i] }); i++; j++; }
    else if (j < b.length && (i >= a.length || !a.slice(i).includes(b[j]))) { out.push({ t: "+", line: b[j] }); j++; }
    else { out.push({ t: "-", line: a[i] }); i++; }
  }
  return out;
}

// ── the catalog ──────────────────────────────────────────────────────────────────────────────
// Each tool: { name, title, category, danger, summary, params, async run(input) }.
// run(input) → { ok, text, kappa?, viewer?, meta? }. `danger` drives the permission prompt.
export const TOOLS = {
  read_file: {
    name: "read_file", title: "Read", category: "File I/O", danger: false,
    summary: "Read a file from your workspace and address it (Law L5).",
    params: { path: "string" },
    async run({ path }) {
      const node = opfsNode(path);
      const r = await VFS.read(node);
      const text = isText(r.mime) ? td.decode(r.bytes) : `[binary · ${VFS.fmtBytes(r.size)} · ${r.mime}]`;
      const kappa = await kappaOf(node);
      return { ok: true, text, kappa, viewer: { kind: "file", path: norm(path), text, kappa }, meta: { bytes: r.size, mime: r.mime } };
    },
  },
  write_file: {
    name: "write_file", title: "Write", category: "File I/O", danger: true,
    summary: "Create or overwrite a file in your workspace.",
    params: { path: "string", content: "string" },
    async run({ path, content }) {
      const parts = homeParts(path); const name = parts.pop();
      const dir = await ensureDir(parts);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable(); await w.write(te.encode(String(content ?? ""))); await w.close();
      const node = opfsNode(path); const kappa = await kappaOf(node);
      return { ok: true, text: `wrote ${norm(path)} (${VFS.fmtBytes(String(content).length)})`, kappa, viewer: { kind: "file", path: norm(path), text: String(content), kappa } };
    },
  },
  edit_file: {
    name: "edit_file", title: "Edit", category: "File I/O", danger: true,
    summary: "Replace an exact string in a workspace file (old → new).",
    params: { path: "string", old: "string", new: "string" },
    async run({ path, old, new: nw }) {
      const node = opfsNode(path); const r = await VFS.read(node); const before = td.decode(r.bytes);
      if (old && !before.includes(old)) return { ok: false, text: `old string not found in ${norm(path)}` };
      const after = old ? before.replace(old, nw ?? "") : (nw ?? "");
      const parts = homeParts(path); const name = parts.pop(); const dir = await ensureDir(parts);
      const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(te.encode(after)); await w.close();
      const kappa = await kappaOf(opfsNode(path));
      const diff = lineDiff(before, after);
      const adds = diff.filter((d) => d.t === "+").length, dels = diff.filter((d) => d.t === "-").length;
      return { ok: true, text: `edited ${norm(path)} · +${adds} −${dels}`, kappa, viewer: { kind: "diff", path: norm(path), diff, kappa } };
    },
  },
  list_dir: {
    name: "list_dir", title: "List", category: "Search", danger: false,
    summary: "List the entries of a workspace directory.",
    params: { path: "string" },
    async run({ path }) {
      const kids = await VFS.list({ source: "opfs", kind: "location", path: norm(path || HOME) });
      const lines = kids.map((n) => `${n.kind === "dir" ? "▸" : " "} ${n.name}${n.kind === "dir" ? "/" : n.bytes != null ? "  " + VFS.fmtBytes(n.bytes) : ""}`);
      return { ok: true, text: lines.length ? lines.join("\n") : "(empty)", meta: { count: kids.length } };
    },
  },
  glob: {
    name: "glob", title: "Glob", category: "Search", danger: false,
    summary: "Find workspace files matching a glob pattern.",
    params: { pattern: "string" },
    async run({ pattern }) {
      const re = globToRe(pattern || "**/*"); const all = await walkHome();
      const hits = all.filter((n) => re.test(n.path.replace(HOME + "/", "")));
      return { ok: true, text: hits.length ? hits.map((n) => n.path).join("\n") : "(no matches)", meta: { count: hits.length } };
    },
  },
  grep: {
    name: "grep", title: "Grep", category: "Search", danger: false,
    summary: "Search file contents under your workspace (regex).",
    params: { pattern: "string", path: "string?" },
    async run({ pattern, path }) {
      let re; try { re = new RegExp(pattern, "i"); } catch { return { ok: false, text: "invalid regex" }; }
      const files = (await walkHome(norm(path || HOME))).filter((n) => isText(n.mime));
      const hits = [];
      for (const n of files) {
        try { const r = await VFS.read(n); const text = td.decode(r.bytes);
          text.split("\n").forEach((ln, i) => { if (re.test(ln)) hits.push(`${n.path.replace(HOME + "/", "")}:${i + 1}: ${ln.trim().slice(0, 160)}`); });
        } catch {}
        if (hits.length > 400) break;
      }
      return { ok: true, text: hits.length ? hits.join("\n") : "(no matches)", meta: { count: hits.length } };
    },
  },
  make_dir: {
    name: "make_dir", title: "Mkdir", category: "File I/O", danger: true,
    summary: "Create a directory in your workspace.",
    params: { path: "string" },
    async run({ path }) { await ensureDir(homeParts(path)); return { ok: true, text: `created ${norm(path)}/` }; },
  },
  remove: {
    name: "remove", title: "Remove", category: "File I/O", danger: true,
    summary: "Delete a file or directory from your workspace.",
    params: { path: "string" },
    async run({ path }) {
      const parts = homeParts(path); const name = parts.pop();
      const dir = await ensureDir(parts); await dir.removeEntry(name, { recursive: true });
      return { ok: true, text: `removed ${norm(path)}` };
    },
  },
  verify: {
    name: "verify", title: "Verify", category: "Substrate", danger: false,
    summary: "Re-derive a file's content address and confirm it (Law L5).",
    params: { path: "string" },
    async run({ path }) {
      const v = await VFS.verify(opfsNode(path));
      const kappa = v.derived ? "did:holo:sha256:" + v.derived : "";
      return { ok: true, text: `${norm(path)} → ${kappa}${v.expected ? (v.ok ? " · re-derives ✓" : " · MISMATCH ✗") : " · (workspace file, no pinned κ — derived from content)"}`, kappa };
    },
  },
  build: {
    name: "build", title: "Build", category: "Substrate", danger: true,
    summary: "Compile source to a content-addressed wasm κ via Holo Forge.",
    params: { source: "string", lang: "string?" },
    async run({ source, lang }) {
      const s = await sdk(); if (!s.build) return { ok: false, text: "Holo Forge not wired in this context" };
      try { const out = await s.build(source, lang ? { lang } : undefined); const k = out?.kappa || out?.id || ""; return { ok: true, text: `built → ${k}`, kappa: k }; }
      catch (e) { return { ok: false, text: "build failed: " + (e?.message || e) }; }
    },
  },
  run: {
    name: "run", title: "Run", category: "Substrate", danger: true,
    summary: "Run a κ (source self-compiles, artifact runs directly) via Holo Forge.",
    params: { ref: "string" },
    async run({ ref }) {
      const s = await sdk(); if (!s.run) return { ok: false, text: "Holo Forge not wired in this context" };
      try { const out = await s.run(ref); return { ok: true, text: typeof out === "string" ? out : JSON.stringify(out) }; }
      catch (e) { return { ok: false, text: "run failed: " + (e?.message || e) }; }
    },
  },
  share: {
    name: "share", title: "Share", category: "Substrate", danger: false,
    summary: "Turn a workspace file into a self-verifying holo://κ link.",
    params: { path: "string" },
    async run({ path }) {
      const kappa = await kappaOf(opfsNode(path)); const s = await sdk();
      const link = s.share ? s.share(kappa) : { holo: "holo://" + (kappa.split(":").pop() || "") };
      return { ok: true, text: `${norm(path)} → ${link.holo}`, kappa };
    },
  },
  spawn_agent: {
    name: "spawn_agent", title: "Agent", category: "Agents", danger: true,
    summary: "Delegate a sub-task to a sub-agent (composes Holo Orchestrate).",
    params: { goal: "string" },
    async run({ goal }) {
      // Live delegation = a node in a Holo Orchestrate execution DAG (ADR-0045) authorized by a Holo
      // Delegate UCAN (ADR-042). That stack is NOT wired in this build, so we decline honestly: ok:false
      // and NO delegated-success step is sealed. Reporting ok:true here would forge a receipt for work
      // that never ran (simulation) — forbidden. When Orchestrate is live, run it here and seal the DAG node.
      return { ok: false, text: `Sub-agent delegation isn't available in this build (needs Holo Orchestrate + Delegate). Goal not run: "${goal}".` };
    },
  },
  // ── SELF-EVOLVING SKILLS (agentskills.io-compatible, UOR-sealed; the Hermes closed loop) ──
  // The agent builds + improves its own procedural knowledge; each version is content-addressed and
  // chained — a verifiable provenance of how the skill evolved. Logic shared with Holo Q (core/skills.js).
  list_skills: {
    name: "list_skills", title: "Skills", category: "Skills", danger: false,
    summary: "List the learned skills (name + description) available to apply.",
    params: {},
    async run() { const s = await SKILLS.listSkills(); return { ok: true, text: s.length ? s.map((x) => `${x.name}: ${x.description}`).join("\n") : "(no skills yet)", meta: { count: s.length } }; },
  },
  read_skill: {
    name: "read_skill", title: "Use Skill", category: "Skills", danger: false,
    summary: "Load a skill's full instructions by name, to follow them for the current task.",
    params: { name: "string" },
    async run({ name }) { try { const sk = await SKILLS.readSkill(name); const body = `# ${sk.name}\n${sk.description}\n\n${sk.instructions}`; return { ok: true, text: body, viewer: { kind: "file", path: `skills/${name}/SKILL.md`, text: body } }; } catch { return { ok: false, text: "no such skill: " + name }; } },
  },
  save_skill: {
    name: "save_skill", title: "Learn Skill", category: "Skills", danger: false,
    summary: "Capture a reusable skill from what you just did, or improve an existing one (sealed + chained = verifiable provenance).",
    params: { name: "string", description: "string", instructions: "string" },
    async run({ name, description, instructions }) { try { const r = await SKILLS.saveSkill({ name, description, instructions }); return { ok: true, text: `skill "${name}" saved (v${r.version}${r.parent ? `, evolved from ${r.parent.slice(0, 22)}…` : ", first version"})`, kappa: r.kappa, meta: { version: r.version, parent: r.parent } }; } catch (e) { return { ok: false, text: "save error: " + (e.message || e) }; } },
  },
};

export function toolList() { return Object.values(TOOLS); }

// the catalog as Qwen2.5 function-calling schemas — what the Holo Q model is armed with so it can
// drive the substrate tools itself (the desktop-Claude agentic loop). Param shape "string?" = optional.
export function toolDefs() {
  return Object.values(TOOLS).map((t) => {
    const properties = {}, required = [];
    for (const [k, v] of Object.entries(t.params || {})) {
      const optional = /\?$/.test(String(v));
      properties[k] = { type: String(v).replace(/\?$/, "") || "string" };
      if (!optional) required.push(k);
    }
    return { name: t.name, description: t.summary, inputSchema: { type: "object", properties, required } };
  });
}
export async function runTool(name, input) {
  const t = TOOLS[name];
  if (!t) return { ok: false, text: `unknown tool: ${name}` };
  try { return await t.run(input || {}); } catch (e) { return { ok: false, text: `${name} error: ${e?.message || e}` }; }
}

// ── first-run workspace seed — so the agent has real code to read/grep/edit out of the box.
// Idempotent: only seeds an empty Home (never clobbers your files).
export async function seedWorkspace() {
  try {
    const root = await opfsRoot();
    let count = 0; for await (const _ of root.keys()) { count++; break; }
    if (count) return false;
    const put = async (path, body) => { const parts = homeParts(path); const name = parts.pop(); const dir = await ensureDir(parts); const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(te.encode(body)); await w.close(); };
    await put("README.md", "# hello-holo\n\nA tiny sample project in your Holo Code workspace.\nEverything here lives in your private OPFS Home — no server, content-addressed.\n\nTry: `read src/greet.js`, `grep holo`, or ask the agent to edit a file.\n");
    await put("src/greet.js", "export function greet(name) {\n  // a sample function for the agent to read, grep, and edit\n  return `hello, ${name} — from holo code`;\n}\n");
    await put("src/main.js", "import { greet } from './greet.js';\nconsole.log(greet('world'));\n");
    return true;
  } catch { return false; }
}

export default { TOOLS, toolList, runTool, seedWorkspace, lineDiff };
