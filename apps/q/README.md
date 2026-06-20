# Holo Q — verifiable, serverless, browser-native LLM inference

Compile any GGUF model into a **content-addressed κ-object** and run it **serverless in the browser** (WebGPU).
The model is delivered as static, deduplicated, per-block-verified files — no server, no trust in the host,
no hour-class re-quant at load.

## Run a model in three steps

```bash
npm run compile2bit qwen2.5-7b      # → ./models/qwen2.5-7b-q4   (a κ-object; ~10 min, downloads the GGUF)
npm run serve                       # → http://localhost:8231
# open the app → model menu → "Load 2-bit κ-object…" → paste:  /models/qwen2.5-7b-q4
```

That's it — the 7B loads directly (no re-quant), resident in ~4.5 GB of GPU, and generates coherent text.

### Compile

```
npm run compile2bit <model> [mode] [out-dir]
  model : smollm2-135m · qwen2.5-0.5b · qwen2.5-1.5b · qwen2.5-3b · qwen2.5-7b
          llama-3.2-1b · llama-3.2-3b   …or a full Q8_0 GGUF URL
  mode  : q4   (default — near-lossless, coherent, ~2× smaller than Q8)
          ldlq | incoherent   (native 2-bit, ~3–4× smaller — research; needs the full QuIP# method
                               for coherence, see docs/adr/0054)
  out   : default ./models/<model>-<mode>
```

## The κ-object

A compiled model is a directory of **static files**:

```
models/qwen2.5-7b-q4/
  manifest.json     # dims + per-tensor index { name → { kappa, fmt, N, K } } under one Merkle root
  b/<κ>.gz          # each weight block, gzip'd, named by its sha256 (the κ)
```

On load, the browser fetches `manifest.json`, then each block by its κ, **re-derives the sha256 and checks
it** (Law L5) before use. A wrong byte from any mirror is rejected — so untrusted hosts are safe.

## Host it persistently

Because a κ-object is just content-addressed static files, **any static host with CORS works** — no special
server. Upload the `models/<name>/` directory and point the loader at its URL:

- **Hugging Face** — `huggingface-cli upload <user>/<repo> models/qwen2.5-7b-q4 .` → load
  `https://huggingface.co/<user>/<repo>/resolve/main`
- **S3 / Cloudflare R2** — `aws s3 sync models/qwen2.5-7b-q4 s3://<bucket>/qwen2.5-7b-q4 --acl public-read`
  (enable CORS) → load the bucket URL
- **Cloudflare Pages / Netlify / GitHub Pages** — drop the dir in `public/` and deploy
- **IPFS** — `ipfs add -r models/qwen2.5-7b-q4` → load `https://ipfs.io/ipfs/<cid>` (κ-objects are
  content-addressed by nature — a perfect fit)
- **`npm run serve`** — the bundled local/self-host static server (CORS + Range)

The only host requirements are **CORS** (`access-control-allow-origin`) and serving the files verbatim. The
tokenizer is fetched from the model's source GGUF header (a small Range request) — keep `manifest.json`'s
`source` URL reachable, or host the header alongside.

## How it works

`compile2bit.mjs` re-quantizes a Q8 GGUF tensor-by-tensor (reusing the engine's exact ingestion) into the
format the WebGPU kernels read, content-addresses every block, and writes the manifest. `holo-load2bit.mjs`
streams + verifies the blocks and hands the engine pre-quantized weights — Q4 rides the engine's native
4-bit kernel; the 2-bit modes use the native-2-bit path (`qvac-2bit.mjs`) with a runtime Hadamard. Design +
rationale: `Hologram OS2/system/docs/adr/0054-holo-q-e8.md`.
