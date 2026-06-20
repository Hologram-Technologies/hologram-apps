# QVAC SDK

Tether's local AI SDK ([docs.qvac.tether.io](https://docs.qvac.tether.io/)), **encoded native to Hologram OS** (ADR-0067). The contract, not the package: a builder writes QVAC code and it runs on the substrate — private, serverless, lean — and every answer is a re-derivable receipt (Law L5).

## What it is

QVAC is one unified JS/TS interface over 13 AI capabilities (text generation, embeddings, RAG, translation, classification, multimodal, image, video, transcription, text-to-speech, voice assistant, VLA, OCR, fine-tuning). This app is its home in the OS: a playground over the whole contract.

- **Always-run chat** — streams from a deterministic reference brain with no model download. Bind Holo Q (QVAC WebGPU, ADR-0052) for a real on-device LLM; the same calls, a provider swap.
- **Live capability grid** — read from the contract, each with its verbatim QVAC symbols and a live/needs-model badge.
- **Run it** — `embed()`, `classify()`, RAG search, and the OpenAI-compatible `/v1/chat/completions` answered by a Service Worker with **no server**.
- **Provable** — every call is conscience-gated (ADR-033) and seals a PROV-O inference receipt that re-derives to its content address; a tampered output is refused.

## How it runs

The app is a single holospace that boots in the Hologram OS frame from one κ. It uses the OS runtime modules (resolved from `_shared` at serve time, Law L1):

```
holo-theme.js · holo-icons.js · holo-conscience.js · holo-object.js · holo-sdk.js · holo-qvac.js
```

The SDK is reached with one import:

```js
import { qvac } from "./_shared/holo-sdk.js";
const Q = await qvac();
const run = Q.completion({ history: [{ role: "user", content: "hello" }], stream: true });
for await (const tok of run.tokenStream) process.stdout.write(tok);
const { receipt } = await run.final;   // re-derivable (Law L5)
```

Encoded, not vendored. Honest where weights are absent — the call reports the missing model rather than faking output. Apache-2.0 upstream; MIT here.
