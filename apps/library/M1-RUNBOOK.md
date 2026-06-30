# Holo Library M1 — in-host runbook (First Real Read-Along)

Everything below runs in the **real Hologram CEF host** (GPU + κ-SW). The headless witnesses already prove every
step except the two engine swaps; this runbook is the wiring + the live checks. Do M1.3 (ASR) **first** — it is
the only real unknown.

## Prereqs
- App is registered + sealed: `org.hologram.HoloLibrary`, κ `did:holo:sha256:0a851ecf9433db6c…`, words `keep.estate.pink`.
- After ANY edit under `apps/library/`: `node holo-os/system/tools/relock-app.mjs library && node holo-os/system/tools/gen-apps-catalog.mjs` (host serves the **vendored** copy; gen throws if lock κ ≠ catalog κ).
- Launch: open the app by κ / three-word address in the host launcher, or navigate the κ-Open loader to its root κ.

## The drop-in wiring (what M1.1→M1.4 assemble)
All modules are app-local and witnessed; only `engine` + `store` are real-host objects.

```js
import { createWhisperEngine, decodePcm16k } from "./holo-asr-whisper.mjs";
import { createASR } from "./holo-asr.mjs";
import { createManufacture } from "./holo-manufacture.mjs";
import { createBookHub } from "./holo-book.mjs";
import { createLibriVox } from "./holo-book-librivox.mjs";
import { createGutenberg } from "./holo-book-gutenberg.mjs";
import { createOpenLibrary } from "./holo-book-openlibrary.mjs";
import { mountReader } from "./holo-read-ui.mjs";
// HOST OBJECTS (the two swaps): a κ store backed by holo-content-net, and transformers.js (vendored/κ-served).
import * as contentNet from "../holo-import/holo-content-net.mjs";        // or the host's κ store handle

// 1) discovery (already live-validated against the real APIs)
const hub = createBookHub();
[createLibriVox, createGutenberg, createOpenLibrary].forEach((f) => hub.register(f({ fetch })));
const works = await hub.findWorks("Frankenstein");
const work = works.find((w) => w.audio.length && w.text.length);        // manufacturable: audio + text

// 2) fetch the bytes (host network; route via the host fetch/import seam if CEF blocks cross-origin)
const gutenbergText = await (await fetch(work.text[0].textUrl)).text();
const lv = createLibriVox({ fetch });
const tracks = await lv.resolveTracks(work.audio[0]);                    // [{ url, sec, title }]
const sections = await Promise.all(tracks.map(async (t) => ({
  title: t.title, sec: t.sec,
  audioBytes: new Uint8Array(await (await fetch(t.url)).arrayBuffer()),  // the mp3 bytes (pinned by κ next)
})));

// 3) the two real engines
const engine = createWhisperEngine({ transformersUrl: /* host's transformers module */ "@huggingface/transformers", model: "onnx-community/whisper-base" });
// holo-asr expects toWords(audioBytes); decode mp3 → 16k PCM inside a thin engine wrapper:
const asr = createASR({ engine: { transcribe: async (mp3Bytes, opts) => engine.transcribe(await decodePcm16k(mp3Bytes.buffer), opts) } });
const store = makeKappaStore(contentNet);                               // put/get-by-κ over holo-content-net + SW

// 4) manufacture (lazy per-chapter align; chapter 1 ready in seconds)
const man = createManufacture({ asr, store });
const built = await man.build(work, { gutenbergText, sections, eagerChapters: 1 });
const { sealed: title, spans } = built.title();

// 5) own it + render read-along
await holoHome.add(title);                                              // holo-home: the title you carry
mountReader(document.getElementById("app"), { title, spans, audioSrc: built.pins[0].url /* holo-k:… via SW */ });
```

## Phase checks (CDP / DevTools / capture → write `*-live.result.json`)
- **M1.1 text** — render real chapters. CHECK (CDP): `document.querySelectorAll('.hl-span').length` > 0; search "Frankenstein" returns hits; no `_`/license leak. The 28-chapter parse is already proven on the real id-84 bytes.
- **M1.2 audio by κ** — `audioSrc` is a `holo-k:` URL the SW resolves. CHECK (Network): the media request hits the SW/κ path, **not** archive.org; flip one stored block → playback fails (resolveVerified throws). 
- **M1.3 align (LINCHPIN — do FIRST, in isolation)** — before any UI: run `asr.toWords(mp3Bytes)` on ONE real LibriVox chapter; assert monotonic `{w,t0,t1}`; feed `holo-align` with the matching chapter text; CHECK overallConf and that the highlighted sentence tracks the audio within ~1 sentence. If Whisper only gives segment ts, that's fine — `holo-align` interpolates + degrades. If this fails, the engine/model is wrong; fix here, not downstream.
- **M1.4 own + switch + share** — CHECK (Network): listen↔read flip fires **zero** new requests (the cursor is pure); title persists in holo-home across reload; `shareTitle` → a κ-link.
- **M1.5 share-running** — open the κ-link in a fresh profile via `share/frame/holospace.html` (origin reachable, then offline). CHECK: opens running full-bleed; `openShared`-style L5 re-derive verifies; read-along works. Single-take capture across two devices.

## Acceptance bar
Highlight tracks REAL narration (~1 sentence) · zero-fetch flip · audio served BY κ (tamper fails closed) · owned
in holo-home (survives reload, shareable) · link opens running on a 2nd device · only Tier-A auto-manufactured
(`holo-rights.assertIngestAllowed` still guards the pin path).

## Notes / gotchas
- **CORS in CEF**: if `gutendex`/`archive.org` fetch is blocked, route via the host fetch/import seam or a κ-proxy.
- **Model weights**: prefer the κ-served Whisper (holo-onnx-kserve) so weights stream by κ; else transformers' default loader. Output shape is identical either way.
- **Long books**: keep `eagerChapters: 1`; align the rest on `alignChapter(i)` as the reader advances. Never block on whole-book align.
- **Reseal** after each app-file edit (top of this file). The host serves the vendored lock, not your working tree.
- **`makeKappaStore`** must expose `{ has(κ), get(κ)→bytes, set(κ,bytes) }` over holo-content-net + the SW κ-route (Bao-verified). That + the Whisper engine are the only two real-host objects this milestone introduces.
```
