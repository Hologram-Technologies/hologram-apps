# Holo Code

**The terminal agent, sovereign.** A substrate-native reproduction of Anthropic's Claude Code — the
same faithful agentic experience, but the brain runs on your machine, the tools work over the
content-addressed substrate, every tool call is judged by the OS conscience, and every session seals
to a re-derivable receipt (Law L5). Serverless, private, infinitely composable.

## What it is
- A faithful **terminal-agent REPL**: streaming replies, tool-call blocks, slash commands, plan mode,
  permission prompts, a status line, and a content-addressed file/diff viewer.
- **Brain-agnostic** by design (`holo-code-providers.mjs`):
  - `local` — a deterministic, no-LLM agent that turns your request into **real** substrate tool calls
    (read · write · edit · glob · grep · verify · share · build · run). Fully interactive today, zero
    model download. It never pretends to be a language model.
  - `holo-q` — the verifiable on-device LLM (Holo Q / QVAC WebGPU, ADR-0052), wired as a lazy adapter
    and activated by **Connect Holo Q**. This is the integration seam — surfaced, not faked.
- **Permission = the conscience gate** (`holo-code-agent.mjs` → `holo-conscience.js`, ADR-033): every
  tool call is judged by the OS Constitution before it runs; a red-line verdict — or a tampered/unsealed
  constitution — refuses it no matter the permission mode (default · plan · auto · acceptEdits · bypass).
- **Tools over the substrate** (`holo-code-tools.mjs`): the file plane is your writable OPFS Home
  (`/home/user`); each result carries the `did:holo` κ of the bytes it touched, re-derivable on demand.
- **Sessions are objects**: each turn records its steps (tool · target · κ · verdict) and seals to a
  PROV-O work receipt — a session you can prove, composing the Holo Orchestrate receipt shape (ADR-0045).

## Files
| File | Role |
|---|---|
| `index.html` | the shell — wired to the OS core modules (Holo UI · UX · Object · Conscience · SDK); token-only, hex-free |
| `holo-code-repl.js` | the REPL surface — transcript, tool blocks, permission modal, slash commands, viewer, status line |
| `holo-code-agent.mjs` | the turn loop — provider → permission gate → tool → receipt |
| `holo-code-tools.mjs` | the substrate-native tool catalog over the `holo-files` VFS + Holo SDK verbs |
| `holo-code-providers.mjs` | the inference brain interface + `local` and `holo-q` providers |
| `holospace.json` / `holospace.lock.json` | the manifest + the sealed, self-verifying closure (κ) |

## The Holo Q seam
`holo-code-providers.mjs` → `holoQProvider.connect()` lazy-imports the QVAC engine from the sibling
`apps/q` (`createQvacGPU(...).generate(...)`). v1 ships the adapter dormant: bind a model manifest +
κ-disk `fetchTensor` there and verifiable on-device generation goes live (greedy decode is
deterministic, so an answer re-derives byte-for-byte — an inference receipt, Law L5).

## Standards
Conforms to the holospaces specification (https://github.com/Hologram-Technologies/holospaces): Law L1
(identity = content address), Law L5 (verify by re-derivation), the Holo UI readability/token floor,
the Holo UX doctrine (native-adaptive, reduced-motion, plain voice), and the constitutional conscience
gate (ADR-033). Built on Holo Product (ADR-0065). Boots serverlessly in the OS holospace frame by κ.
