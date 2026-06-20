"""holo_copilot — an in-notebook coding copilot for Holo Jupyter, 100% in your browser.

Backed by the QVAC contract at its REFERENCE tier (deterministic, offline — not an LLM yet) with a
real model-binding seam: call holo_copilot.bind_model(fn) (e.g. a bound Holo Q / WebLLM model, or an
MCP ask_model bridge) and generation upgrades in place. Every interaction is content-addressed (κ),
so copilot assistance is provenance-tracked like everything else on the substrate (Law L5).

What works offline TODAY (deterministic, genuinely useful — no model needed):
  • complete(prefix)  — completions from your LIVE namespace (IPython's completer / jedi)
  • explain(exc?)     — a plain-language explanation + fix hint for an exception
  • ask(query)        — QVAC-embedding RAG: retrieves the most relevant snippet from the kb
What upgrades when a model is bound:
  • generate(prompt)  — real code/text generation (reference tier just echoes an honest stub)

Usage:
    import holo_copilot as cop          # also registers the %copilot line magic
    cop.complete("np.ar")               # -> ['np.arange', 'np.array', ...]
    cop.explain()                       # -> explains the last exception
    cop.ask("how do I run a GPU kernel")
    %copilot ask how do I optimize a portfolio
"""
import hashlib
import json
import math
import re
import sys
import traceback

__all__ = ["complete", "explain", "ask", "generate", "bind_model", "kb_add", "receipts"]

_MODEL = None            # bound generative model: fn(prompt:str)->str  (None => reference tier)
_RECEIPTS = []           # κ-addressed provenance of every interaction
_KB = {                  # the retrieval knowledge base (extend with kb_add)
    "gpu": "Run a WGSL compute shader on the GPU with holo_gpu: y = await holo_gpu.run(wgsl, np_array). "
           "Content-address operands with holo_gpu.address(arr) so repeats are O(1); readback=False keeps "
           "results on the GPU to chain kernels and read once.",
    "quantum": "Build quantum circuits with cirq (install via piplite.install(['cirq-core'])). "
               "cirq.Simulator().simulate(circuit).final_state_vector gives the state vector; cirq.measure for shots.",
    "quant": "Quant finance: statsmodels for econometrics (OLS/ARIMA), cvxpy+clarabel for portfolio optimization, "
             "backtrader for backtesting, mplfinance for candlesticks. Install bundled ones via piplite.install.",
    "geometric": "Geometric algebra with kingdon: from kingdon import Algebra; alg = Algebra(3, 0, 1) builds PGA.",
    "substrate": "Everything is content-addressed (κ = did:holo:sha256). Notebooks, results and copilot calls "
                 "re-derive to verify (Law L5). Agents drive this env over MCP via holo_jupyter_run / holo_research_run.",
}


def _kappa(obj) -> str:
    return "did:holo:sha256:" + hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


def _seal(op, inp, out):
    rec = {"op": op, "input": inp, "output": out, "tier": "qvac-reference" if _MODEL is None else "qvac-bound"}
    rec["kappa"] = _kappa({k: rec[k] for k in ("op", "input", "output", "tier")})
    _RECEIPTS.append(rec)
    return rec["kappa"]


def receipts():
    """The κ-addressed provenance of every copilot interaction this session."""
    return list(_RECEIPTS)


def bind_model(fn):
    """Bind a real generative model: fn(prompt:str)->str. Upgrades generate()/ask() in place."""
    global _MODEL
    _MODEL = fn
    return True


def kb_add(topic: str, text: str):
    """Add a document to the retrieval knowledge base."""
    _KB[str(topic)] = str(text)


def _ipython():
    try:
        return get_ipython()  # noqa: F821  (provided by the IPython kernel)
    except Exception:
        return None


def complete(prefix: str, limit: int = 10):
    """Completions for `prefix` from the LIVE kernel namespace (attribute introspection — reliable
    in Pyodide; IPython's completer as a supplement)."""
    ip = _ipython()
    ns = ip.user_ns if ip is not None else globals()
    out = []
    if "." in prefix:                                   # dotted: introspect the base object
        base, _, tail = prefix.rpartition(".")
        try:
            obj = eval(base, dict(ns))
            out = sorted(base + "." + a for a in dir(obj) if a.startswith(tail) and not a.startswith("__"))[:limit]
        except Exception:
            out = []
    else:                                               # bare name: namespace + builtins + keywords
        import builtins, keyword
        names = set(ns) | set(vars(builtins)) | set(keyword.kwlist)
        out = sorted(n for n in names if n.startswith(prefix) and not n.startswith("_"))[:limit]
    if not out and ip is not None:                      # supplement with IPython's completer
        try:
            _, matches = ip.complete(prefix)
            out = list(dict.fromkeys(matches))[:limit]
        except Exception:
            pass
    _seal("complete", prefix, out)
    return out


_HINTS = {
    "NameError": "A name is used before it's defined — define it first, check spelling, or import the module.",
    "ModuleNotFoundError": "The package isn't loaded. If it's bundled, run: import piplite; await piplite.install(['<pkg>']).",
    "ImportError": "Import failed — the symbol/module may be missing or the package isn't installed in this kernel.",
    "TypeError": "An operation got the wrong type — check argument types and counts (and await on coroutines).",
    "ValueError": "A value is out of range or the wrong shape — check inputs (e.g. array shapes, conversions).",
    "IndexError": "An index is out of range — check the length before indexing.",
    "KeyError": "A dict/Series key is missing — check the key exists (use .get or `in`).",
    "AttributeError": "That attribute/method doesn't exist on this object — check the type and spelling.",
    "ZeroDivisionError": "Division by zero — guard the denominator.",
    "SyntaxError": "Python couldn't parse the code — check brackets, colons and indentation.",
    "RuntimeError": "Runtime failure — read the message; for async, ensure you awaited.",
}


def explain(exc: BaseException = None):
    """Explain an exception (defaults to the last one) in plain language, with a fix hint."""
    if exc is None:
        exc = getattr(sys, "last_value", None)
        ip = _ipython()
        if exc is None and ip is not None:
            exc = getattr(ip, "_last_traceback_value", None)
    if exc is None:
        return {"summary": "No recent exception found. Pass one: explain(err)."}
    etype = type(exc).__name__
    msg = str(exc)
    tb = "".join(traceback.format_exception_only(type(exc), exc)).strip()
    expl = {"error": etype, "message": msg, "hint": _HINTS.get(etype, "Read the message and the last traceback frame."),
            "traceback": tb}
    expl["kappa"] = _seal("explain", {"error": etype, "message": msg}, expl["hint"])
    return expl


# ---- QVAC reference embeddings (deterministic, hashed bag-of-tokens) — same idea as the QVAC floor ----
def _embed(text: str, dim: int = 256):
    v = [0.0] * dim
    for tok in re.findall(r"[a-z0-9_]+", str(text).lower()):
        h = int(hashlib.sha1(tok.encode()).hexdigest(), 16)
        v[h % dim] += 1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _cos(a, b):
    return sum(x * y for x, y in zip(a, b))


def ask(query: str, k: int = 1):
    """Retrieve the most relevant knowledge-base snippet for `query` (QVAC-embedding RAG).

    Reference tier RETRIEVES (it does not generate); bind a model to also synthesize an answer.
    """
    qv = _embed(query)
    ranked = sorted(((round(_cos(qv, _embed(t)), 4), topic, t) for topic, t in _KB.items()), reverse=True)
    hits = [{"topic": topic, "score": s, "text": t} for s, topic, t in ranked[:k]]
    answer = None
    if _MODEL is not None:
        ctx = "\n".join(h["text"] for h in hits)
        try:
            answer = _MODEL(f"Use this context to answer.\nContext:\n{ctx}\n\nQuestion: {query}")
        except Exception as e:
            answer = f"(bound model error: {e})"
    out = {"query": query, "retrieved": hits,
           "answer": answer or "(reference tier: retrieval only — bind_model(fn) to generate an answer)"}
    out["kappa"] = _seal("ask", query, out["retrieved"])
    return out


def generate(prompt: str, max_tokens: int = 256):
    """Generate text/code. Reference tier returns an honest stub; a bound model produces real output."""
    if _MODEL is not None:
        text = _MODEL(prompt)
        return {"text": text, "tier": "qvac-bound", "kappa": _seal("generate", prompt, text)}
    stub = ("// holo_copilot reference tier: no generative model bound on this device.\n"
            "// Bind one with holo_copilot.bind_model(fn) (Holo Q / WebLLM / MCP ask_model).\n"
            f"// prompt was: {prompt[:160]}")
    return {"text": stub, "tier": "qvac-reference", "kappa": _seal("generate", prompt, stub)}


# register the %copilot line magic so it's usable from any cell
def _register_magic():
    ip = _ipython()
    if ip is None:
        return
    def _copilot_magic(line):
        parts = line.strip().split(" ", 1)
        sub = parts[0] if parts else ""
        arg = parts[1] if len(parts) > 1 else ""
        if sub == "complete":
            return complete(arg)
        if sub == "explain":
            return explain()
        if sub == "ask":
            return ask(arg)
        if sub == "generate":
            return generate(arg)
        return ("usage: %copilot complete <prefix> | explain | ask <query> | generate <prompt>")
    try:
        ip.register_magic_function(_copilot_magic, magic_kind="line", magic_name="copilot")
    except Exception:
        pass


_register_magic()
