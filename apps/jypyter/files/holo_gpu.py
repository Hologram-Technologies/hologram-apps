"""holo_gpu — content-addressed, sub-millisecond GPU/CPU compute from a Holo Jupyter cell.

Real WebGPU compute on your hardware (numpy float32 in -> WGSL on the GPU -> numpy back),
designed around the Hologram content-address doctrine so that the *amortized* cost of repeated
or chained work falls well below 1 ms:

  • address(arr) computes the operand's κ (BLAKE-of-content, here sha256) ONCE and carries it on a
    HoloArray, plus its Φ-Atlas-12288 coordinate. Subsequent ops key off that κ in O(1) — no re-hash.
  • run(kernel, holo_arr) memoizes results by κ = (kernel_κ, input_κ). A repeat is a dict lookup
    returning a read-only view → microseconds (Law L5: same content ⊕ same kernel ⇒ same result).
  • the GPUDevice, compiled pipelines (keyed by kernel_κ) and storage buffers (a size-keyed pool)
    are all reused — no per-call setup.
  • readback=False keeps the result ON the GPU and returns a handle you can feed straight into the
    next kernel; a chain of N kernels pays the ~ms mapAsync readback floor ONCE, not N times.

Honest limits: a single *cold* dispatch that reads data back can't go sub-ms (mapAsync is a CPU↔GPU
sync). The sub-ms regime is: O(1) cache hits, small CPU ops, and amortized on-GPU pipelines.
"""
import hashlib
from collections import OrderedDict

import numpy as np
import js
from pyodide.ffi import to_js

# ---- caches / pools: acquire-once, reuse-forever -----------------------------------------
_DEVICE = None
_PIPELINES = {}            # kernel_κ -> GPUComputePipeline
_KERNEL_K = {}            # id(wgsl str) -> kernel_κ  (skip re-hashing the same shader object)
_RESULTS = OrderedDict()   # (kernel_κ, input_κ) -> HoloArray (read-only)  [O(1) memo]
_POOL = {}                 # nbytes -> [free storage GPUBuffers]
_RESULT_MAX = 256
ATLAS_N = 12288            # Φ-Atlas-12288 (48 pages × 256 bytes)


def _gpu():
    try:
        gpu = js.navigator.gpu
    except AttributeError:
        return None
    return None if (gpu is None or gpu is getattr(js, "undefined", object())) else gpu


def _obj(d):
    return to_js(d, dict_converter=js.Object.fromEntries)


def available() -> bool:
    return _gpu() is not None


def atlas_coord(kappa_hex: str) -> dict:
    """Deterministic Φ-Atlas-12288 coordinate of a content address (mirrors the substrate scheme)."""
    n = int(kappa_hex[:16], 16)
    cell = n % ATLAS_N
    page, byte = cell >> 8, cell & 0xFF
    return {"space": "Φ-Atlas-12288", "cell": cell, "page": page, "byte": byte, "r96": byte % 96, "phi": cell}


class HoloArray:
    """A float32 array that carries its content address κ (computed once) and atlas coordinate.

    Pass these to run() for O(1) memoized re-dispatch. `.data` is the numpy array (read-only)."""
    __slots__ = ("data", "kappa", "coord")

    def __init__(self, data, kappa):
        self.data = data
        self.kappa = kappa
        self.coord = atlas_coord(kappa)

    def __array__(self, dtype=None):
        return self.data if dtype is None else self.data.astype(dtype)

    def __repr__(self):
        return f"HoloArray(n={self.data.size}, κ=did:holo:sha256:{self.kappa[:12]}…, atlas cell {self.coord['cell']})"


def address(arr) -> "HoloArray":
    """Content-address an array ONCE (O(n) hash now → O(1) lookups forever after)."""
    if isinstance(arr, HoloArray):
        return arr
    a = np.ascontiguousarray(np.asarray(arr, dtype=np.float32)).reshape(-1)
    a.setflags(write=False)
    return HoloArray(a, hashlib.sha256(a.tobytes()).hexdigest())


def _kernel_kappa(wgsl: str) -> str:
    k = _KERNEL_K.get(id(wgsl))
    if k is None:
        k = hashlib.sha256(wgsl.encode()).hexdigest()
        _KERNEL_K[id(wgsl)] = k
    return k


async def device():
    global _DEVICE
    if _DEVICE is not None:
        return _DEVICE
    gpu = _gpu()
    if gpu is None:
        raise RuntimeError("WebGPU not available (navigator.gpu missing). Use Chrome/Edge 113+.")
    adapter = await gpu.requestAdapter()
    if adapter is None:
        raise RuntimeError("No WebGPU adapter — no usable GPU.")
    _DEVICE = await adapter.requestDevice()
    return _DEVICE


async def warmup() -> bool:
    await device()
    return True


async def adapter_info() -> dict:
    gpu = _gpu()
    if gpu is None:
        return {"webgpu": False}
    adapter = await gpu.requestAdapter()
    info = {"webgpu": True}
    try:
        ai = adapter.info if hasattr(adapter, "info") else await adapter.requestAdapterInfo()
        info["adapter"] = {k: getattr(ai, k, "") for k in ("vendor", "architecture", "device", "description")}
    except Exception:
        info["adapter"] = "present"
    return info


def _pipeline(dev, wgsl, entry, kernel_k):
    key = (kernel_k, entry)
    p = _PIPELINES.get(key)
    if p is None:
        module = dev.createShaderModule(_obj({"code": wgsl}))
        p = dev.createComputePipeline(_obj({"layout": "auto", "compute": {"module": module, "entryPoint": entry}}))
        _PIPELINES[key] = p
    return p


def _acquire(dev, nbytes):
    free = _POOL.get(nbytes)
    if free:
        return free.pop()
    U = js.GPUBufferUsage
    return dev.createBuffer(_obj({"size": nbytes, "usage": U.STORAGE | U.COPY_SRC | U.COPY_DST}))


def _recycle(buf, nbytes):
    _POOL.setdefault(nbytes, []).append(buf)


class GPUHandle:
    """A result kept ON the GPU (no readback). Feed it into the next run() to chain; read() at the end."""
    __slots__ = ("buffer", "n", "nbytes", "kappa")

    def __init__(self, buffer, n, nbytes, kappa):
        self.buffer, self.n, self.nbytes, self.kappa = buffer, n, nbytes, kappa


async def run(wgsl, data, *, entry_point="main", workgroup_size=64, groups=0,
              readback=True, cache=True):
    """Run a WGSL compute shader over float32 data.

    data: numpy array, HoloArray (O(1) memo key), or GPUHandle (chained — no upload).
    readback=False → returns a GPUHandle (stays on GPU). readback=True → numpy/HoloArray result.
    """
    dev = await device()
    kernel_k = _kernel_kappa(wgsl)
    pipeline = _pipeline(dev, wgsl, entry_point, kernel_k)
    U = js.GPUBufferUsage

    chained = isinstance(data, GPUHandle)
    if chained:
        storage, n, nbytes, in_k = data.buffer, data.n, data.nbytes, data.kappa
        pooled = False
    else:
        ha = data if isinstance(data, HoloArray) else (address(data) if cache else None)
        in_k = ha.kappa if ha is not None else None
        if readback and cache and in_k is not None:
            hit = _RESULTS.get((kernel_k, in_k))
            if hit is not None:
                _RESULTS.move_to_end((kernel_k, in_k))
                return hit                                  # ← O(1) content-addressed hit (sub-ms)
        arr = ha.data if ha is not None else np.ascontiguousarray(np.asarray(data, dtype=np.float32)).reshape(-1)
        n, nbytes = int(arr.size), max(4, int(arr.nbytes))
        storage = _acquire(dev, nbytes)
        dev.queue.writeBuffer(storage, 0, to_js(arr))
        pooled = True

    bind = dev.createBindGroup(_obj({"layout": pipeline.getBindGroupLayout(0),
                                     "entries": [{"binding": 0, "resource": {"buffer": storage}}]}))
    g = groups if groups > 0 else (n + workgroup_size - 1) // max(1, workgroup_size)
    enc = dev.createCommandEncoder()
    cp = enc.beginComputePass()
    cp.setPipeline(pipeline)
    cp.setBindGroup(0, bind)
    cp.dispatchWorkgroups(max(1, int(g)))
    cp.end()

    if not readback:
        dev.queue.submit(to_js([enc.finish()]))
        out_k = hashlib.sha256((kernel_k + (in_k or "")).encode()).hexdigest()  # provenance address
        return GPUHandle(storage, n, nbytes, out_k)

    readbuf = dev.createBuffer(_obj({"size": nbytes, "usage": U.MAP_READ | U.COPY_DST}))
    enc.copyBufferToBuffer(storage, 0, readbuf, 0, nbytes)
    dev.queue.submit(to_js([enc.finish()]))
    await readbuf.mapAsync(js.GPUMapMode.READ)
    out = np.frombuffer(js.Uint8Array.new(readbuf.getMappedRange()).to_bytes(), dtype=np.float32)[:n].copy()
    readbuf.unmap()
    readbuf.destroy()
    if pooled:
        _recycle(storage, nbytes)

    out.setflags(write=False)
    res = address(out)
    if cache and in_k is not None:
        _RESULTS[(kernel_k, in_k)] = res
        if len(_RESULTS) > _RESULT_MAX:
            _RESULTS.popitem(last=False)
    return res


async def read(handle: "GPUHandle") -> "HoloArray":
    """Read a chained on-GPU result back to the CPU (pays the mapAsync floor once)."""
    dev = await device()
    U = js.GPUBufferUsage
    readbuf = dev.createBuffer(_obj({"size": handle.nbytes, "usage": U.MAP_READ | U.COPY_DST}))
    enc = dev.createCommandEncoder()
    enc.copyBufferToBuffer(handle.buffer, 0, readbuf, 0, handle.nbytes)
    dev.queue.submit(to_js([enc.finish()]))
    await readbuf.mapAsync(js.GPUMapMode.READ)
    out = np.frombuffer(js.Uint8Array.new(readbuf.getMappedRange()).to_bytes(), dtype=np.float32)[:handle.n].copy()
    readbuf.unmap()
    readbuf.destroy()
    out.setflags(write=False)
    return address(out)


def cache_stats() -> dict:
    return {"device_ready": _DEVICE is not None, "pipelines": len(_PIPELINES),
            "results": len(_RESULTS), "pooled_buffers": sum(len(v) for v in _POOL.values())}


def clear_cache():
    _RESULTS.clear()
