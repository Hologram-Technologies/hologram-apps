#!/usr/bin/env node
// holo-tts-bridge-witness.mjs — proves P6: a TEXT-ONLY public-domain work (Gutenberg, no LibriVox audio) is
// narrated by κ-native TTS and becomes a high-confidence read-along you own — and because the synthesizer emits
// the timings, the sync is EXACT, not estimated. The narrated title flows through the same real-κ pipeline and
// shares/opens on a fresh device like any other.
//
//   1 textOnlyBefore  — before narration, the work can only be READ (no audio) — the gap P6 closes.
//   2 narratesToReadAlong — narrateTitle() yields a title with audio + syncmap → modes.readalong true.
//   3 ttsAudioRealKappa — the audio κ is the genuine blake3 of the synthesized bytes.
//   4 exactSync       — TTS timings are ground truth → sentence-mode syncmap with overallConf ≈ 1 (not degraded).
//   5 provenanceSynthetic — provenance marks a synthetic narration source (Holo TTS), license public-domain, derived.
//   6 composesWithShare — the narrated title shares + opens on a FRESH device (P5 chain), read-along intact.
//
// node holo-tts-bridge-witness.mjs   (from holo-apps/apps/library/)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { narrateTitle } from "./holo-tts-bridge.mjs";
import { kappaOf } from "../holo-import/holo-content-net.mjs";
import { sealTitle, modesOf, RIGHTS } from "./holo-title.mjs";
import { shareTitle, openShared } from "./holo-library.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checks = {}; const fail = [];
const ok = (n, c, d = "") => { checks[n] = !!c; if (!c) fail.push(n + (d ? ` — ${d}` : "")); return !!c; };
const te = new TextEncoder();

const refText = "The sea was calm that morning. A single gull crossed the pale sky. The boy watched it go.";
const textBytes = te.encode(refText);

// 1 — text-only work before narration can only be read
{
  const textKappa = kappaOf(textBytes);
  const readOnly = sealTitle({ work: { title: "The Pale Sky", authors: ["Public Domain"], lang: "en" }, text: textKappa, rights: { class: RIGHTS.PUBLIC_DOMAIN } });
  ok("textOnlyBefore", readOnly.modes.read && !readOnly.modes.listen && !readOnly.modes.readalong, JSON.stringify(readOnly.modes));
}

// a Kokoro-like TTS: synthesize bytes + emit ground-truth word timings (200ms/word here).
const tts = {
  async synthesize(text) {
    const toks = text.split(/\s+/).filter(Boolean);
    const words = toks.map((w, i) => ({ w, t0: i * 200, t1: i * 200 + 180 }));
    const audioBytes = new Uint8Array(toks.length * 64).map((_, i) => (i * 17 + 3) & 0xff);   // stand-in PCM
    return { audioBytes, words };
  },
};

const { title, syncmap, blobs } = await narrateTitle({
  work: { title: "The Pale Sky", authors: ["Public Domain"], lang: "en" },
  textBytes, tts,
  sources: [{ library: "Project Gutenberg", mediaType: "text" }],
});

// 2 — now a read-along
ok("narratesToReadAlong", !!title.audio && !!title.syncmap && title.modes.readalong, JSON.stringify(title.modes));

// 3 — audio κ is real
{
  const { audioBytes } = await tts.synthesize(refText);
  ok("ttsAudioRealKappa", title.audio === kappaOf(audioBytes) && blobs.has(title.audio), title.audio.slice(0, 18));
}

// 4 — exact sync (ground-truth timings → high confidence sentence mode)
ok("exactSync", syncmap.mode === "sentence" && syncmap.overallConf >= 0.99 && syncmap.spans.length === 3, JSON.stringify({ mode: syncmap.mode, conf: syncmap.overallConf }));

// 5 — provenance marks the synthetic narration honestly
{
  const narr = (title.provenance.sources || []).find((s) => s.mediaType === "narration");
  ok("provenanceSynthetic", narr && narr.synthetic === true && /TTS|Kokoro/i.test(narr.library) && title.provenance.license === "Public Domain" && title.provenance.derived === true, JSON.stringify(narr));
}

// 6 — composes with the P5 share chain on a fresh device
{
  const shared = shareTitle(title, blobs);
  const opened = openShared(shared.link);
  ok("composesWithShare", opened.title.kappa === title.kappa && opened.modes.readalong && opened.reader.spans.length === 3, JSON.stringify({ sameKappa: opened.title.kappa === title.kappa }));
}

const witnessed = Object.values(checks).every(Boolean);
const result = {
  "@type": "earl:TestResult",
  spec: "holo-tts-bridge — a text-only public-domain work (Gutenberg, no LibriVox recording) is narrated by κ-native TTS (Kokoro) and becomes a high-confidence read-along you own. Because the synthesizer emits the word timings, self-alignment is EXACT (sentence-mode, conf ≈ 1), not estimated. The narration flows through the same real-κ pipeline (audio pinned to genuine κ), provenance marks the synthetic source honestly (public-domain, derived), and the title shares + opens on a fresh device like any other holo-title. This closes the last gap: every public-domain text can become a read-along, no recording required.",
  authority: "rests on #holo-library (manufactureTitle) + the Kokoro TTS seam (holo-voice) — P6 of the Holo Library build",
  witnessed,
  covers: witnessed ? ["text-only-before", "narrates-to-read-along", "tts-audio-real-kappa", "exact-sync", "provenance-synthetic", "composes-with-share"] : [],
  checks, failed: fail,
};
writeFileSync(join(here, "holo-tts-bridge-witness.result.json"), JSON.stringify(result, null, 2) + "\n");
console.log("holo-tts-bridge witness — narrate any text, exact self-sync, owned + shareable\n");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "✓" : "✗"}  ${k}`);
console.log(`\n  ${witnessed ? "WITNESSED ✓  every public-domain text can become a read-along, no recording needed" : "NOT witnessed — " + fail.join("; ")}`);
process.exit(witnessed ? 0 : 1);
