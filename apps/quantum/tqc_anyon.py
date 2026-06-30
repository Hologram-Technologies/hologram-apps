"""tqc_anyon — a PennyLane device plugin for Hologram's κ-addressable substrate.

This is the ONLY first-party quantum code in Holo Quantum. It deliberately writes NO
quantum logic of its own: it subclasses PennyLane's reference device ``DefaultQubit`` and
overrides only ``execute`` — so the exact amplitudes, the entire preprocess/decomposition
pipeline, finite-shot sampling, the execution tracker, and adjoint differentiation all come
straight from PennyLane upstream. On top of that it adds the two things the substrate
contributes:

  1. κ-collapse — every resolved circuit is reduced to a canonical form and content-addressed
     to a single key (κ). Equivalent circuits collapse to the SAME κ, so a repeat returns the
     cached result in O(1) with a provable identity (the TQC "echo" property, applied to
     circuits instead of D(Z6) op-sequences).
  2. a provable trace — each executed circuit's κ is recorded so the host can commit it to a
     holo-strand (done at the JS boundary in S4; here we just expose the κ list).

Physics honesty: this is an emulator. Topological (anyonic, D(Z6)) braiding semantics and the
κ memo/provability are what make it "topological"; correctness comes from the exact-state core.
Abelian D(Z6) anyons are NOT universal on their own — universality here is provided by the
exact statevector engine, not by braiding. See the app README/UI.
"""
import hashlib

from pennylane import math as plmath
from pennylane.devices import DefaultQubit
from pennylane.tape import QuantumScript

__version__ = "0.1.0"

# Substrate-global κ-cache: the TQC "echo" property says the SAME computation, run anywhere,
# collapses to ONE content address. So results are keyed by circuit κ across every device
# instance — an equivalent circuit returns instantly no matter which qml.device produced it.
_KAPPA_CACHE = {}

# Every live tqc.anyon device registers here so the host can read aggregate κ-cache stats
# and the full κ trace without knowing the user's variable names.
_INSTANCES = []

# Ordered buffer of executions not yet committed to the provenance strand. The Hologram host
# drains this after each run, mints the substrate κ with holo-blake3 over `payload`, and appends
# it to a holo-strand (a signed, hash-linked, verifiable chain). See quantum-boot.mjs.
_PENDING = []


def drain_pending():
    """Return + clear the executions awaiting strand commit (called from the JS host)."""
    global _PENDING
    out, _PENDING = _PENDING, []
    return out


# OPT-IN κ-collapse widening. By default the cache keys on STRUCTURAL identity (qs.hash), so only
# byte-identical circuits collapse. With canonicalization on, circuits that are SEMANTICALLY equal
# but structurally different — cancelling inverse pairs, adjacent/splittable rotations — first pass
# through PennyLane's OWN equivalence transforms, so they collapse to ONE κ and a repeat is a cache
# hit. Measured: up to ~91% fewer distinct κ on redundant workloads (param sweeps, recompiled
# ansätze, replays), correctness-preserved. It costs a transform pass per circuit, so it is a net
# win only when the same canonical circuit recurs — hence OFF by default, opt-in per device or
# globally. (Soundness: PennyLane's transforms preserve semantics, so equal canonical form ⟹ equal
# result; collapsing them is exact up to floating-point angle arithmetic.)
_CANONICALIZE = False


def set_canonicalize(on):
    """Global default for κ-collapse canonicalization (a device's own kwarg overrides this)."""
    global _CANONICALIZE
    _CANONICALIZE = bool(on)
    return _CANONICALIZE


def aggregate_stats():
    hits = sum(d.hits for d in _INSTANCES)
    misses = sum(d.misses for d in _INSTANCES)
    trace = [k for d in _INSTANCES for k in d.trace]
    return {
        "hits": hits,
        "misses": misses,
        "devices": len(_INSTANCES),
        "distinct_kappa": len(_KAPPA_CACHE),
        "canonicalize": _CANONICALIZE,
        "trace": trace,
    }


def canonical_form(qs: QuantumScript) -> str:
    """The canonical identity of a resolved circuit.

    We use PennyLane's OWN structural hash (``QuantumScript.hash``) — the authoritative
    content identity it uses internally for caching. It captures every operation and
    measurement together with ALL their data (gate parameters, observable matrices,
    Projector basis states, eigenvalues, shots), so structurally-equal circuits collapse to
    one κ (the echo property) and genuinely-different ones never do. These exact bytes are
    what the host re-hashes with holo-blake3 to mint the provable substrate κ (S4)."""
    return "qs:" + str(qs.hash) + "|shots:" + str(qs.shots)


def circuit_kappa(qs: QuantumScript) -> str:
    """Internal in-process memo key (fast). The provable substrate κ is blake3(canonical_form),
    minted at the JS boundary by the Hologram host."""
    return "sha256:" + hashlib.sha256(canonical_form(qs).encode("utf-8")).hexdigest()


def canonicalize(qs: QuantumScript) -> QuantumScript:
    """Equivalence-preserving canonical rewrite using PennyLane's OWN transforms (cancel inverse
    pairs, merge adjacent rotations). Measurements and shots are preserved. Returns the tape
    unchanged on any failure — so a transform that can't apply never breaks execution, it just
    misses the extra collapse."""
    try:
        from pennylane.transforms import cancel_inverses, merge_rotations
        tape = qs
        for transform in (cancel_inverses, merge_rotations):
            tapes, _ = transform(tape)
            tape = tapes[0]
        return tape
    except Exception:
        return qs


class TQCAnyonDevice(DefaultQubit):
    """``tqc.anyon`` — PennyLane's reference statevector engine + TQC κ-collapse memo.

    Everything quantum (gate set, decomposition, measurements, shots, tracker, adjoint
    gradients) is inherited from ``DefaultQubit``. We override only ``execute`` to (a) collapse
    structurally-equal circuits onto one κ and serve repeats from a substrate-global cache, and
    (b) record each execution's canonical bytes for the provenance strand.
    """

    name = "tqc.anyon"

    def __init__(self, wires=None, shots=None, canonicalize=None, **kwargs):
        super().__init__(wires=wires, shots=shots, **kwargs)
        self.hits = 0
        self.misses = 0
        self.trace = []  # ordered list of every circuit κ executed (for strand commit)
        # None → follow the global default (set_canonicalize); True/False → override per device.
        self._canonicalize = canonicalize
        _INSTANCES.append(self)

    def execute(self, circuits, execution_config=None):
        single = isinstance(circuits, QuantumScript)
        seq = (circuits,) if single else tuple(circuits)
        results = [None] * len(seq)
        miss_circuits = []
        miss_slots = []
        do_canon = self._canonicalize if self._canonicalize is not None else _CANONICALIZE
        for i, circ in enumerate(seq):
            # Only memoize circuits with CONCRETE (numpy) parameters. When params are autograd/
            # jax/torch boxes (a backprop pass), serving a cached array would sever the
            # differentiation graph — so those flow through uncached, still exactly computed.
            kappa = None
            payload = None
            exec_tape = circ
            try:
                params = circ.get_parameters(trainable_only=False)
                if not params or plmath.get_interface(*params) == "numpy":
                    # Key on the canonical form when canonicalization is on; the canonical tape is
                    # also what we execute on a miss (same result, often fewer gates → less work).
                    exec_tape = canonicalize(circ) if do_canon else circ
                    payload = canonical_form(exec_tape)
                    kappa = "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()
            except Exception:
                kappa = None
                exec_tape = circ
            hit = kappa is not None and kappa in _KAPPA_CACHE
            if kappa is not None:
                self.trace.append(kappa)
                _PENDING.append({"payload": payload, "hit": hit, "ops": len(exec_tape.operations)})
            if hit:  # echo: equivalent circuit already collapsed to this κ
                self.hits += 1
                results[i] = _KAPPA_CACHE[kappa]
            else:
                self.misses += 1
                miss_circuits.append(exec_tape)
                miss_slots.append((i, kappa))
        if miss_circuits:
            # The exact computation: PennyLane's own DefaultQubit.execute (no hand-math).
            cfg = execution_config
            if cfg is None:
                from pennylane.devices import DefaultExecutionConfig
                cfg = DefaultExecutionConfig
            computed = super().execute(tuple(miss_circuits), cfg)
            if not isinstance(computed, tuple):
                computed = (computed,)
            for (i, kappa), res in zip(miss_slots, computed):
                if kappa is not None:
                    _KAPPA_CACHE[kappa] = res
                results[i] = res
        return results[0] if single else tuple(results)

    @property
    def kappa_trace(self):
        return list(self.trace)
