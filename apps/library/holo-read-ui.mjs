// holo-read-ui.mjs — the Holo Read surface. It is deliberately thin: ALL the correctness lives in the
// witnessed kernels (holo-read cursor, holo-align syncmap, holo-title manifest). This module only binds an
// <audio> element to the cursor and paints the three modes. The audio carries data-holo-sound="speech" so the
// universal router (holo-sound.mjs) applies the Vocal + loudness audiobook profile with zero per-app work.
//
//   mountReader(root, { title, spans, audioSrc })  → { setMode, destroy }
//
// title = a sealed holo-title (holo-title.mjs); spans = its flattened timeline (holo-read.flattenSyncmaps).

import { createReader } from "./holo-read.mjs";
import { modesOf } from "./holo-title.mjs";

const MODES = ["listen", "read", "readalong"];

export function mountReader(root, { title, spans, audioSrc } = {}) {
  const reader = createReader(spans || []);
  const avail = title?.modes || modesOf(title || {});
  let mode = avail.readalong ? "readalong" : avail.listen ? "listen" : "read";

  root.innerHTML = `
  <div class="hl-reader" data-mode="${mode}">
    <header class="hl-bar">
      <div class="hl-title"><span class="hl-ribbon" title="auto-manufactured read-along"></span>
        <strong>${esc(title?.work?.title || "Untitled")}</strong>
        <em>${esc((title?.work?.authors || []).join(", "))}</em></div>
      <div class="hl-modes">
        ${MODES.map((m) => `<button data-m="${m}" ${!avail[m] ? "disabled" : ""}>${label(m)}</button>`).join("")}
      </div>
      <input class="hl-search" type="search" placeholder="Search the text…" />
    </header>
    <audio class="hl-audio" data-holo-sound="speech" data-holo-normalize="-2" preload="metadata" ${audioSrc ? `src="${esc(audioSrc)}"` : ""} controls></audio>
    <div class="hl-results" hidden></div>
    <article class="hl-text" tabindex="0">
      ${reader.spans.map((s) => `<span class="hl-span" data-i="${s.spans?.i ?? ""}" data-id="${esc(s.spanId)}" data-ms="${s.startMs}">${esc(s.text)} </span>`).join("")}
    </article>
    <footer class="hl-prov">${esc(provenanceLine(title))}</footer>
  </div>`;

  const el = (q) => root.querySelector(q);
  const audio = el(".hl-audio"), textEl = el(".hl-text"), resultsEl = el(".hl-results");
  const spanEls = [...root.querySelectorAll(".hl-span")];
  let curIdx = -1;

  function paint(i) {
    if (i === curIdx) return;
    if (spanEls[curIdx]) spanEls[curIdx].classList.remove("on");
    curIdx = i;
    const node = spanEls[curIdx];
    if (node) { node.classList.add("on"); if (mode !== "listen") node.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }

  // listening advances the cursor; reading/read-along highlight the span at the cursor. One source of truth.
  audio.addEventListener("timeupdate", () => { if (!reader.spans.length) return; paint(reader.msToSpan(audio.currentTime * 1000)); });

  // tap a line → seek audio there (works in every mode; this is the cursor flip made tactile).
  textEl.addEventListener("click", (e) => {
    const span = e.target.closest(".hl-span"); if (!span) return;
    const ms = reader.seekToSpan(span.dataset.id);
    audio.currentTime = ms / 1000;
    if (audio.paused && mode !== "read") audio.play().catch(() => {});
  });

  // search → seekable hits
  el(".hl-search").addEventListener("input", (e) => {
    const q = e.target.value;
    const hits = q.trim() ? reader.search(q) : [];
    resultsEl.hidden = !hits.length;
    resultsEl.innerHTML = hits.slice(0, 40).map((h) => `<button class="hl-hit" data-ms="${h.startMs}">…${esc(h.snippet)}…</button>`).join("");
  });
  resultsEl.addEventListener("click", (e) => { const b = e.target.closest(".hl-hit"); if (!b) return; audio.currentTime = +b.dataset.ms / 1000; resultsEl.hidden = true; });

  // mode switch — pure cursor flip; preserves position, no re-fetch (proven in holo-read-witness).
  function setMode(m) {
    if (!avail[m]) return;
    const flip = reader.switchModality({ ms: audio.currentTime * 1000 }, m);
    mode = m; root.querySelector(".hl-reader").dataset.mode = m;
    root.querySelectorAll(".hl-modes button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    if (flip.i >= 0) paint(flip.i);
  }
  root.querySelectorAll(".hl-modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.m)));
  setMode(mode);

  return { setMode, reader, destroy() { root.innerHTML = ""; } };
}

const label = (m) => ({ listen: "Listen", read: "Read", readalong: "Read-along" }[m] || m);
function provenanceLine(t) {
  const src = (t?.provenance?.sources || []).map((s) => `${s.library} (${s.mediaType})`).join("  ·  ");
  const lic = t?.provenance?.license ? `  ·  ${t.provenance.license}` : "";
  const k = t?.kappa ? `  ·  ${t.kappa.slice(0, 18)}…` : "";
  return src ? `Auto-manufactured from ${src}${lic}${k}` : "";
}
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

export default { mountReader };
if (typeof window !== "undefined") window.HoloReadUI = { mountReader };
