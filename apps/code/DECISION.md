# Decision — Holo Code

> The decision record for this holospace, on the Holo Product foundation (ADR-0065). An ADR is the
> **Define** phase, the value statement is **Discover**, the conformance gate is **Verify** — a
> product is a recorded decision, designed to both doctrines, and proven before it ships.

## Discover — the value
A coding agent you can trust because nothing is taken on trust. Claude Code is a terminal agent that
asks a remote server to think and trusts what comes back. Holo Code is its sovereign twin: the same
faithful agent experience, but the brain runs on your machine, the tools work over the
content-addressed substrate, and every step is verifiable by re-derivation.

For developers who want an agentic partner without surrendering their code, their privacy, or the
ability to prove what happened.

## Define — the decision
- **Why:** an AI coding session should be *provable*, not just remembered — and private by construction.
- **How:** built on Holo Product — it inherits Holo UI (the look) ⊕ Holo UX (the experience),
  auto-wired to the OS core modules; no UX/UI basics are re-decided here (Law L2). The brain is a
  pluggable provider (local deterministic today; Holo Q / QVAC verifiable LLM as the seam, ADR-0052).
- **What:** a faithful terminal-agent REPL — streaming replies, tool-call blocks, slash commands, plan
  mode, permission prompts — whose tools operate over the `holo-files` VFS, whose permission gate is
  the fail-closed conscience (ADR-033), and whose every session seals to a re-derivable PROV-O receipt.

## Design — the faculties (inherited, balanced)
- **UI:** colours · typography · layout → the `--holo-*` tokens (the shell is token-only, hex-free).
- **UX:** the terminal-agent interaction model, native-adaptive keys, reduced-motion inherited from the
  one OS guard, plain voice in the manifest.

## Build · Verify · Deliver
- **Build:** a content-addressed κ-object — re-derivable, serverless (Law L5).
- **Verify:** conforms to the gate's app rows (`#app-ui-*` · `#app-ux-*` · `audit-apps`) — done is proven.
- **Deliver & Iterate:** shared as `holo://κ`; the Holo Q brain and the live agent stack (Orchestrate ·
  Delegate · Settle) compose in without breaking the gate.
