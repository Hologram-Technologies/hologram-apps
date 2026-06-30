# Holo Quantum

Unmodified [PennyLane](https://github.com/PennyLaneAI/pennylane) running natively in
Hologram's κ-addressable substrate as a topological quantum computing emulator. Paste any
PennyLane script and run it verbatim on the `tqc.anyon` device.

## What it is

- **PennyLane is unmodified.** It installs from the official wheel into the in-substrate
  Pyodide (CPython→WebAssembly). Every PennyLane feature — QNodes, templates, measurements,
  gradients, transforms, `qml.draw` — comes from upstream as-is. Version pinned at runtime:
  PennyLane 0.45.1.
- **One first-party file:** [`tqc_anyon.py`](tqc_anyon.py), a PennyLane device plugin. It
  writes no quantum logic of its own — it subclasses PennyLane's reference `DefaultQubit` and
  overrides only `execute`. The exact amplitudes, decomposition pipeline, finite-shot
  sampling, execution tracker, and adjoint gradients are all upstream PennyLane.
- **`qml.device("tqc.anyon", ...)` resolves by name** via the standard `pennylane.plugins`
  entry point, so existing scripts run unchanged.

## What the substrate adds

1. **κ-collapse (the TQC "echo" property).** Every executed circuit is content-addressed with
   `holo-blake3` over its canonical form (PennyLane's own structural circuit hash). Structurally
   equal circuits mint the **same κ** and the result is served from a substrate-global cache —
   instant on repeat.
2. **A provable trace.** Each circuit's κ is appended to a `holo-strand`: a signed, hash-linked,
   append-only chain that re-verifies on read (Law L5). The session is a reproducible record.

## How it's real, honestly

Correctness comes from the exact statevector core (PennyLane's reference engine), which is why
results match `default.qubit` bit-for-bit and the device passes PennyLane's **own** device
conformance suite:

```
pennylane/devices/tests  vs  --device=tqc.anyon --shots=None
  385 passed, 0 failed, 32 skipped, 9 xfailed   (exit 0)
```

The topological layer (D(Z₆) anyonic braiding semantics + κ-collapse) provides provable
identity and instant repeats — **not** the computation itself. Abelian D(Z₆) braiding is not
universal for quantum computation on its own; universality here is the exact-state core. We
state this plainly rather than imply braiding alone is doing the work. A genuinely universal
topological model would need non-abelian anyons (e.g. Fibonacci) and is out of scope here.

## Verified status (2026-06-28)

- S1 — unmodified PennyLane boots + runs in-substrate ✓
- S2 — `tqc.anyon` resolves by name; matches `default.qubit` ✓
- S3 — all measurements, finite shots, sampling ✓
- S4 — κ-collapse + `holo-strand` provability (chain verifies; equivalent circuits → one κ) ✓
- S5 — gradients (parameter-shift + adjoint), VQE converges to exact ground state ✓
- S6 — full `pennylane/devices/tests` green (analytic); app boots end-to-end ✓

Remaining to ship into the sealed OS image: register `holo://os/quantum` (native host
rebuild), reseal, boot-smoke, ADR-0112 conformance witness.

## Files

| File | Role |
|---|---|
| `index.html` | the REPL surface (editor, output, κ-cache + strand inspector) |
| `quantum-boot.mjs` | `QuantumKernel`: boots Pyodide, installs PennyLane, registers `tqc.anyon`, mints κ + commits the strand |
| `tqc_anyon.py` | the device plugin (the only first-party quantum code) |
| `holospace.json` | app manifest |
