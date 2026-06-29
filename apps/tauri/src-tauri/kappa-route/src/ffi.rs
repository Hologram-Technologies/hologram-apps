// ffi.rs — the C ABI for the κ-route verifier.
//
// This is the seam the CEF host's C++ resource handler calls: open a sealed-image store, then resolve
// each request to verified bytes (or an HTTP status on refusal). The verification is the exact same
// dual-axis, fail-closed logic the Tauri host uses (crate::resolve) — one audited verifier, both
// engines. Declarations mirror kappa_route.h (cbindgen-compatible).

use std::ffi::{c_char, CStr};
use std::path::PathBuf;

use crate::{load_store, resolve, KStore};

/// Open a sealed-image store rooted at `root` (UTF-8, NUL-terminated). `expected_anchor` is the baked
/// trust root (sha256 of os-closure.json) or NULL/empty to skip the check; on mismatch the store is
/// poisoned and refuses everything. Returns an opaque handle to be freed with `kr_store_free`, or NULL
/// on bad input.
///
/// # Safety
/// `root` must be a valid NUL-terminated string; `expected_anchor` valid NUL-terminated or NULL.
#[no_mangle]
pub unsafe extern "C" fn kr_store_open(root: *const c_char, expected_anchor: *const c_char) -> *mut KStore {
    if root.is_null() {
        return std::ptr::null_mut();
    }
    let s = match CStr::from_ptr(root).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    let anchor = if expected_anchor.is_null() {
        None
    } else {
        CStr::from_ptr(expected_anchor).to_str().ok().map(|a| a.to_string())
    };
    Box::into_raw(Box::new(load_store(PathBuf::from(s), anchor)))
}

/// Free a store handle returned by `kr_store_open`.
///
/// # Safety
/// `st` must be a pointer returned by `kr_store_open` (or NULL), freed at most once.
#[no_mangle]
pub unsafe extern "C" fn kr_store_free(st: *mut KStore) {
    if !st.is_null() {
        drop(Box::from_raw(st));
    }
}

/// Resolve a request path (e.g. "/os/apps/browser/index.html") against the store and re-derive its
/// content address on BOTH axes (Law L5 / SEC-6). Returns the HTTP status: 200 on a verified hit,
/// else 403 (tamper/unpinned), 404 (absent), 400 (bad input).
///
/// On 200: `*out_ptr`/`*out_len` receive a heap buffer (free with `kr_free`) and `*out_mime` a static
/// NUL-terminated mime string (do NOT free). On any non-200 the out-params are set NULL/0.
///
/// # Safety
/// `st` must be a valid handle; `req_path` a NUL-terminated UTF-8 string; the out-pointers writable.
#[no_mangle]
pub unsafe extern "C" fn kr_resolve(
    st: *const KStore,
    req_path: *const c_char,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
    out_mime: *mut *const c_char,
) -> u16 {
    if !out_ptr.is_null() {
        *out_ptr = std::ptr::null_mut();
    }
    if !out_len.is_null() {
        *out_len = 0;
    }
    if !out_mime.is_null() {
        *out_mime = std::ptr::null();
    }
    if st.is_null() || req_path.is_null() {
        return 400;
    }
    let st = &*st;
    let path = match CStr::from_ptr(req_path).to_str() {
        Ok(p) => p,
        Err(_) => return 400,
    };
    match resolve(st, path) {
        Ok((bytes, mime)) => {
            let len = bytes.len();
            let ptr = Box::into_raw(bytes.into_boxed_slice()) as *mut u8;
            if !out_ptr.is_null() {
                *out_ptr = ptr;
            }
            if !out_len.is_null() {
                *out_len = len;
            }
            if !out_mime.is_null() {
                *out_mime = mime.as_ptr();
            }
            200
        }
        Err(code) => code,
    }
}

/// Compute the lowercase sha256 hex (64 chars + NUL = 65 bytes) of `len` bytes at `data` into `out`.
/// This is the SAME content-address hash the verifier uses (Law L5) — content-κ ad blocking refuses a
/// payload by THIS hash, so a denylisted ad object is caught wherever it is served (no new crypto).
///
/// # Safety
/// `out` must point to ≥ 65 writable bytes; `data` valid for `len` bytes (or `len == 0`).
#[no_mangle]
pub unsafe extern "C" fn kr_sha256_hex(data: *const u8, len: usize, out: *mut c_char) {
    if out.is_null() || (data.is_null() && len != 0) {
        return;
    }
    let slice = if len == 0 { &[][..] } else { std::slice::from_raw_parts(data, len) };
    let hex = crate::sha256_hex(slice); // 64 ASCII hex chars
    for (i, &b) in hex.as_bytes().iter().enumerate().take(64) {
        *out.add(i) = b as c_char;
    }
    *out.add(64) = 0;
}

/// BLAKE3 hex of `data` into `out` — the substrate's FAST σ-axis (did:holo:blake3:…), a SIMD tree hash ~5×
/// faster than sha256 (see webcache.rs). The projection producer addresses per-frame tiles on this axis.
///
/// # Safety
/// `out` must point to ≥ 65 writable bytes; `data` valid for `len` bytes (or `len == 0`).
#[no_mangle]
pub unsafe extern "C" fn kr_blake3_hex(data: *const u8, len: usize, out: *mut c_char) {
    if out.is_null() || (data.is_null() && len != 0) {
        return;
    }
    let slice = if len == 0 { &[][..] } else { std::slice::from_raw_parts(data, len) };
    let hex = crate::blake3_hex(slice); // 64 ASCII hex chars
    for (i, &b) in hex.as_bytes().iter().enumerate().take(64) {
        *out.add(i) = b as c_char;
    }
    *out.add(64) = 0;
}

/// Verify a CHUNK of a κ-object against its root κ via its Bao proof — native verified streaming, the
/// BLAKE3 dividend. Lets the host serve a VERIFIED RANGE of a large object streamed from a peer/origin
/// without holding the whole object (a tampered chunk is refused, Law L5; the rest stream on). Mirrors
/// os/usr/lib/holo/holo-bao.mjs and crate::bao::verify_chunk — same proof format, so a slice proven in the
/// browser verifies here and vice versa (cross-impl, kappa-route bao_slice_parity).
///
/// `root_hex`: NUL-terminated 64-char lowercase hex of the object's root κ. `chunk`/`chunk_len`: the chunk
/// bytes. `proof`/`proof_count`: `proof_count` siblings, each 33 bytes — 1 side byte (`'L'` or `'R'`) then
/// a 32-byte chaining value. Returns 1 iff the chunk verifies against the root, else 0.
///
/// # Safety
/// `root_hex` valid NUL-terminated; `chunk` valid for `chunk_len`; `proof` valid for `proof_count*33` bytes.
#[no_mangle]
pub unsafe extern "C" fn kr_bao_verify_chunk(
    root_hex: *const c_char,
    index: u64,
    chunk: *const u8,
    chunk_len: usize,
    proof: *const u8,
    proof_count: usize,
) -> u8 {
    if root_hex.is_null() || (chunk.is_null() && chunk_len != 0) || (proof.is_null() && proof_count != 0) {
        return 0;
    }
    let root = match CStr::from_ptr(root_hex).to_str() { Ok(s) => s, Err(_) => return 0 };
    let chunk_bytes = if chunk_len == 0 { &[][..] } else { std::slice::from_raw_parts(chunk, chunk_len) };
    let proof_bytes = if proof_count == 0 { &[][..] } else { std::slice::from_raw_parts(proof, proof_count.saturating_mul(33)) };
    let mut siblings = Vec::with_capacity(proof_count);
    for i in 0..proof_count {
        let off = i * 33;
        let left = proof_bytes[off] == b'L';
        let mut cv = [0u8; 32];
        cv.copy_from_slice(&proof_bytes[off + 1..off + 33]);
        siblings.push(crate::bao::Sibling { left, cv });
    }
    if crate::bao::verify_chunk(root, index, chunk_bytes, &siblings) { 1 } else { 0 }
}

/// Verify a contiguous SLICE (aligned power-of-two run of chunks starting at `start_chunk`) against `root_hex`
/// in ONE SIMD pass + the short `upper` proof (proof_count siblings × 33 bytes, same wire format as
/// kr_bao_verify_chunk). The host's fast streaming-verify path: ~10× the per-chunk rate (measured ~40 GB/s
/// parallel vs ~3 GB/s), so a κ-stream is wire-bound, not verify-bound. Returns 1 if it verifies, else 0.
/// # Safety: `root_hex` NUL-terminated; `slice` valid for `slice_len`; `proof` valid for `proof_count`*33.
#[no_mangle]
pub unsafe extern "C" fn kr_bao_verify_slice(
    root_hex: *const c_char,
    start_chunk: u64,
    slice: *const u8,
    slice_len: usize,
    proof: *const u8,
    proof_count: usize,
) -> u8 {
    if root_hex.is_null() || (slice.is_null() && slice_len != 0) || (proof.is_null() && proof_count != 0) {
        return 0;
    }
    let root = match CStr::from_ptr(root_hex).to_str() { Ok(s) => s, Err(_) => return 0 };
    let slice_bytes = if slice_len == 0 { &[][..] } else { std::slice::from_raw_parts(slice, slice_len) };
    let proof_bytes = if proof_count == 0 { &[][..] } else { std::slice::from_raw_parts(proof, proof_count.saturating_mul(33)) };
    let mut siblings = Vec::with_capacity(proof_count);
    for i in 0..proof_count {
        let off = i * 33;
        let left = proof_bytes[off] == b'L';
        let mut cv = [0u8; 32];
        cv.copy_from_slice(&proof_bytes[off + 1..off + 33]);
        siblings.push(crate::bao::Sibling { left, cv });
    }
    if crate::bao::verify_slice(root, start_chunk, slice_bytes, &siblings) { 1 } else { 0 }
}

/// Free a buffer returned by `kr_resolve`.
///
/// # Safety
/// `ptr`/`len` must be exactly what a single `kr_resolve` 200 returned, freed at most once.
#[no_mangle]
pub unsafe extern "C" fn kr_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len != 0 {
        drop(Box::from_raw(std::slice::from_raw_parts_mut(ptr, len) as *mut [u8]));
    }
}

// ── verified-streaming PRODUCER (kr_bao_encoder_*) — the host streams a large κ-object as blake3-verified
//    chunks: build the outboard ONCE (one SIMD pass), then serve any chunk + proof in O(1). A consumer
//    (renderer / peer / another tab) renders chunk 0 the instant it arrives; the object is never re-hashed
//    per request. Pair with kr_bao_verify_chunk on the consumer side (same proof wire format). ────────────

use crate::bao::BaoEncoder;

/// Build a streaming producer over `data`/`len` (copied in). Free with kr_bao_encoder_free. NULL on bad input.
/// # Safety: `data` valid for `len` bytes (or `len == 0`).
#[no_mangle]
pub unsafe extern "C" fn kr_bao_encoder_new(data: *const u8, len: usize) -> *mut BaoEncoder {
    if data.is_null() && len != 0 { return std::ptr::null_mut(); }
    let bytes = if len == 0 { Vec::new() } else { std::slice::from_raw_parts(data, len).to_vec() };
    Box::into_raw(Box::new(BaoEncoder::new(bytes)))
}

/// The object's root κ hex (64 chars + NUL) into `out` (>= 65 bytes) — the address every chunk proof verifies against.
/// # Safety: `enc` a valid handle; `out` >= 65 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn kr_bao_encoder_root(enc: *const BaoEncoder, out: *mut c_char) {
    if enc.is_null() || out.is_null() { return; }
    let hex = (*enc).root();
    for (i, &b) in hex.as_bytes().iter().enumerate().take(64) { *out.add(i) = b as c_char; }
    *out.add(64) = 0;
}

/// Number of 1024-byte chunks in the object.
/// # Safety: `enc` a valid handle.
#[no_mangle]
pub unsafe extern "C" fn kr_bao_encoder_chunk_count(enc: *const BaoEncoder) -> u64 {
    if enc.is_null() { return 0; }
    (*enc).chunk_count()
}

/// Serve chunk `index`: its bytes (out_chunk/out_chunk_len, free with kr_free) and its proof packed as
/// `out_proof_count` siblings × 33 bytes (1 side byte 'L'/'R' + 32-byte CV; out_proof free with kr_free over
/// out_proof_count*33). Returns 1 on success, 0 if `index` is out of range. O(1) — served from the prebuilt
/// outboard. The proof wire format is exactly what kr_bao_verify_chunk consumes (host-produces, peer-verifies).
/// # Safety: `enc` valid; all out-pointers writable.
#[no_mangle]
pub unsafe extern "C" fn kr_bao_encoder_chunk(
    enc: *const BaoEncoder,
    index: u64,
    out_chunk: *mut *mut u8,
    out_chunk_len: *mut usize,
    out_proof: *mut *mut u8,
    out_proof_count: *mut usize,
) -> u8 {
    if !out_chunk.is_null() { *out_chunk = std::ptr::null_mut(); }
    if !out_chunk_len.is_null() { *out_chunk_len = 0; }
    if !out_proof.is_null() { *out_proof = std::ptr::null_mut(); }
    if !out_proof_count.is_null() { *out_proof_count = 0; }
    if enc.is_null() { return 0; }
    let (bytes, proof) = match (*enc).chunk(index) { Some(c) => c, None => return 0 };
    let cb = bytes.to_vec();
    *out_chunk_len = cb.len();
    *out_chunk = Box::into_raw(cb.into_boxed_slice()) as *mut u8;
    let mut packed = Vec::with_capacity(proof.len() * 33);
    for s in proof { packed.push(if s.left { b'L' } else { b'R' }); packed.extend_from_slice(&s.cv); }
    *out_proof_count = proof.len();
    *out_proof = Box::into_raw(packed.into_boxed_slice()) as *mut u8;
    1
}

/// Free a kr_bao_encoder_new handle.
/// # Safety: `enc` a kr_bao_encoder_new pointer (or NULL), freed at most once.
#[no_mangle]
pub unsafe extern "C" fn kr_bao_encoder_free(enc: *mut BaoEncoder) {
    if !enc.is_null() { drop(Box::from_raw(enc)); }
}

/// Warm the verified-bytes cache for the boot-relevant (< `max_bytes`) files IN PARALLEL, so the page's
/// first load sees warm (network-free, no re-hash) serves instead of slow sequential cold ones. Meant to be
/// called on a BACKGROUND thread right after kr_store_open (off the boot-critical path). Returns the count
/// warmed. `max_bytes == 0` uses a 64 KiB default (the first-paint module/html/css/json set).
/// # Safety: `st` must be a valid kr_store_open handle held for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn kr_store_warm(st: *const KStore, max_bytes: u64) -> usize {
    if st.is_null() { return 0; }
    let cap = if max_bytes == 0 { 65536 } else { max_bytes };
    crate::warm_boot_set(&*st, cap).0
}

/// Run the κ-fabric effective-goodput proof for an `object_mb`-MiB object and return it as a heap JSON C
/// string (free with kr_cache_free_mime) — the InfiniBand-class numbers measured LIVE on bare metal (native
/// SIMD BLAKE3 + data-parallel verify). The native CEF host calls this from a holo:// page (cefQuery) to
/// surface the proof in-browser, the hot path running in Rust, not JS. NULL on allocation failure.
#[no_mangle]
pub extern "C" fn kr_fabric_goodput(object_mb: usize) -> *mut c_char {
    let mb = object_mb.clamp(1, 4096);
    let json = crate::fabric::measure(mb).to_string();
    std::ffi::CString::new(json).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

// ── open-web κ-cache ABI (kr_cache_*) ───────────────────────────────────────────────────────────────
// The CEF host calls these from its resource path (handler.cc): GET a hit to serve without network,
// PUT a teed miss body to populate the cache. Distinct from kr_resolve (sealed, read-only). Thread-safe:
// the handle wraps a Mutex<WebCache> because CEF resource callbacks run off the UI thread.
use std::sync::Mutex;

use crate::webcache::WebCache;

pub struct KCache(Mutex<WebCache>);

/// Open an open-web κ-cache bounded to `cap` distinct κ (the resident working set). Free with kr_cache_free.
#[no_mangle]
pub extern "C" fn kr_cache_new(cap: usize) -> *mut KCache {
    Box::into_raw(Box::new(KCache(Mutex::new(WebCache::new(cap)))))
}

/// Open an open-web κ-cache whose resident cap is **auto-sized to this device's RAM** (no setting): a weak
/// laptop holds a small working set, a workstation a large one, automatically. Free with kr_cache_free.
/// This is the "take full advantage of any hardware, just works" entry point the host uses by default.
#[no_mangle]
pub extern "C" fn kr_cache_new_auto() -> *mut KCache {
    let cap = crate::webcache::auto_cap();
    eprintln!("[kappa-route] κ-cache auto-sized to device: {cap} distinct κ resident");
    Box::into_raw(Box::new(KCache(Mutex::new(WebCache::new(cap)))))
}

/// # Safety: `c` must be a kr_cache_new pointer (or NULL), freed at most once.
#[no_mangle]
pub unsafe extern "C" fn kr_cache_free(c: *mut KCache) {
    if !c.is_null() {
        drop(Box::from_raw(c));
    }
}

/// Serve a GET url from the cache if held (re-derives κ first — L5; tamper ⇒ miss). Returns 1 on a hit
/// (out-params filled: byte buffer free with kr_free, mime buffer free with kr_cache_free_mime), else 0.
///
/// # Safety: `c` valid; `url` NUL-terminated UTF-8; out-pointers writable.
#[no_mangle]
pub unsafe extern "C" fn kr_cache_get(
    c: *const KCache,
    url: *const c_char,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
    out_mime: *mut *mut c_char,
) -> u8 {
    if !out_ptr.is_null() { *out_ptr = std::ptr::null_mut(); }
    if !out_len.is_null() { *out_len = 0; }
    if !out_mime.is_null() { *out_mime = std::ptr::null_mut(); }
    if c.is_null() || url.is_null() { return 0; }
    let url = match CStr::from_ptr(url).to_str() { Ok(u) => u, Err(_) => return 0 };
    let mut cache = match (*c).0.lock() { Ok(g) => g, Err(_) => return 0 };
    match cache.get(url) {
        Some((bytes, mime)) => {
            let len = bytes.len();
            *out_ptr = Box::into_raw(bytes.into_boxed_slice()) as *mut u8;
            *out_len = len;
            let cm = std::ffi::CString::new(mime).unwrap_or_default();
            *out_mime = cm.into_raw();
            1
        }
        None => 0,
    }
}

/// Fetch a held object BY its κ (bare hex or `did:holo:sha256:<hex>`). The read the Living Window uses to
/// pull a captured doc/asset's bytes by the κ from the manifest. Returns 1 on a verified hit (byte buffer
/// free with kr_free; mime buffer free with kr_cache_free_mime), else 0. Re-derives before serving (L5).
///
/// # Safety: `c` valid; `kappa` NUL-terminated UTF-8; out-pointers writable.
#[no_mangle]
pub unsafe extern "C" fn kr_cache_get_kappa(
    c: *const KCache,
    kappa: *const c_char,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
    out_mime: *mut *mut c_char,
) -> u8 {
    if !out_ptr.is_null() { *out_ptr = std::ptr::null_mut(); }
    if !out_len.is_null() { *out_len = 0; }
    if !out_mime.is_null() { *out_mime = std::ptr::null_mut(); }
    if c.is_null() || kappa.is_null() { return 0; }
    let kappa = match CStr::from_ptr(kappa).to_str() { Ok(k) => k, Err(_) => return 0 };
    let cache = match (*c).0.lock() { Ok(g) => g, Err(_) => return 0 };
    match cache.get_by_kappa(kappa) {
        Some((bytes, mime)) => {
            let len = bytes.len();
            *out_ptr = Box::into_raw(bytes.into_boxed_slice()) as *mut u8;
            *out_len = len;
            *out_mime = std::ffi::CString::new(mime).unwrap_or_default().into_raw();
            1
        }
        None => 0,
    }
}

/// Fetch a held object BY its BLAKE3 σ-axis hex (the fast axis the projection producer addresses tiles on).
/// Mirrors kr_cache_get_kappa; serves holo://os/cache/blake3/<hex>. Returns 1 on hit, 0 on miss/tamper.
///
/// # Safety: `c` valid; `b3hex` NUL-terminated UTF-8; out-pointers writable.
#[no_mangle]
pub unsafe extern "C" fn kr_cache_get_b3(
    c: *const KCache,
    b3hex: *const c_char,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
    out_mime: *mut *mut c_char,
) -> u8 {
    if !out_ptr.is_null() { *out_ptr = std::ptr::null_mut(); }
    if !out_len.is_null() { *out_len = 0; }
    if !out_mime.is_null() { *out_mime = std::ptr::null_mut(); }
    if c.is_null() || b3hex.is_null() { return 0; }
    let b3hex = match CStr::from_ptr(b3hex).to_str() { Ok(k) => k, Err(_) => return 0 };
    let cache = match (*c).0.lock() { Ok(g) => g, Err(_) => return 0 };
    match cache.get_by_b3(b3hex) {
        Some((bytes, mime)) => {
            let len = bytes.len();
            *out_ptr = Box::into_raw(bytes.into_boxed_slice()) as *mut u8;
            *out_len = len;
            *out_mime = std::ffi::CString::new(mime).unwrap_or_default().into_raw();
            1
        }
        None => 0,
    }
}

/// Install a fetched (cold-miss) body, deduped by κ. `immutable` (0/1) marks serve-forever assets.
///
/// # Safety: `c` valid; `url`/`mime` NUL-terminated UTF-8; `data` valid for `len` bytes (or len==0).
#[no_mangle]
pub unsafe extern "C" fn kr_cache_put(
    c: *const KCache,
    url: *const c_char,
    data: *const u8,
    len: usize,
    mime: *const c_char,
    immutable: u8,
) {
    if c.is_null() || url.is_null() { return; }
    let url = match CStr::from_ptr(url).to_str() { Ok(u) => u, Err(_) => return };
    let mime = if mime.is_null() { "application/octet-stream" }
        else { CStr::from_ptr(mime).to_str().unwrap_or("application/octet-stream") };
    let bytes = if len == 0 { Vec::new() } else { std::slice::from_raw_parts(data, len).to_vec() };
    if let Ok(mut cache) = (*c).0.lock() {
        cache.put(url, bytes, mime, immutable != 0);
    }
}

/// Free a mime string returned by kr_cache_get.
/// # Safety: `m` must be exactly a kr_cache_get out_mime pointer, freed at most once.
#[no_mangle]
pub unsafe extern "C" fn kr_cache_free_mime(m: *mut c_char) {
    if !m.is_null() {
        drop(std::ffi::CString::from_raw(m));
    }
}

/// Enumerate the cache as a JSON array string `[{"url","kappa","mime","len"}]` — the manifest the Living
/// Window reads to compose from what you browsed. NO bodies are included (only metadata; bytes stay
/// fetchable via the serve-hit path). Heap C string; free with `kr_cache_free_mime`. NULL on bad input.
///
/// # Safety: `c` must be a valid kr_cache_new handle (or NULL).
#[no_mangle]
pub unsafe extern "C" fn kr_cache_entries(c: *const KCache) -> *mut c_char {
    if c.is_null() {
        return std::ptr::null_mut();
    }
    let cache = match (*c).0.lock() {
        Ok(g) => g,
        Err(_) => return std::ptr::null_mut(),
    };
    let arr: Vec<serde_json::Value> = cache
        .entries()
        .into_iter()
        // present the κ in the substrate form `did:holo:sha256:<hex>` (the cache stores the bare hex), so the
        // manifest shares ONE κ address space with the Living Window composer (kobject.kappaOf).
        .map(|(url, kappa, mime, len)| serde_json::json!({ "url": url, "kappa": format!("did:holo:sha256:{}", kappa), "mime": mime, "len": len }))
        .collect();
    let json = serde_json::Value::Array(arr).to_string();
    std::ffi::CString::new(json).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

// ── witness: the C ABI round-trips a verified hit and reports refusals ─────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::fs;

    fn seal_one(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("kr-ffi-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let good = b"export const ok = 1;\n";
        fs::write(root.join("a.js"), good).unwrap();
        fs::write(root.join("b.js"), b"unpinned\n").unwrap();
        let closure = serde_json::json!({
            "closure": { "a.js": {
                "kappa": format!("did:holo:sha256:{}", crate::sha256_hex(good)),
                "blake3": format!("did:holo:blake3:{}", crate::blake3_hex(good)),
            }}
        });
        fs::write(root.join("os-closure.json"), serde_json::to_vec(&closure).unwrap()).unwrap();
        root
    }

    // S5 — the verified-slice C ABI the CEF host calls: pack a real holo-bao proof into the 33-byte/sibling
    // wire format and confirm kr_bao_verify_chunk admits the true chunk and refuses a tampered one. Uses the
    // JS-emitted vectors (cross-impl), skips cleanly if absent.
    #[test]
    fn ffi_bao_verify_chunk_round_trip() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../holo-os/system/tools/holo-bao-parity-vectors.json");
        let Ok(raw) = fs::read(&path) else { eprintln!("no bao vectors — run holo-bao-parity-witness.mjs"); return; };
        let doc: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        // pick a multi-chunk object + a deep chunk (non-empty proof)
        let obj = doc["objects"].as_array().unwrap().iter().find(|o| o["chunks"].as_array().unwrap().len() > 4).unwrap();
        let root = obj["root"].as_str().unwrap();
        let ch = &obj["chunks"].as_array().unwrap()[3];
        let index = ch["index"].as_u64().unwrap();
        let bytes: Vec<u8> = (0..ch["bytes"].as_str().unwrap().len() / 2)
            .map(|i| u8::from_str_radix(&ch["bytes"].as_str().unwrap()[i * 2..i * 2 + 2], 16).unwrap()).collect();
        // pack proof: per sibling, 1 side byte + 32 cv bytes
        let mut proof = Vec::new();
        let sibs = ch["proof"].as_array().unwrap();
        for s in sibs {
            proof.push(if s["side"].as_str().unwrap() == "L" { b'L' } else { b'R' });
            let cv = s["cv"].as_str().unwrap();
            for i in 0..32 { proof.push(u8::from_str_radix(&cv[i * 2..i * 2 + 2], 16).unwrap()); }
        }
        let c_root = CString::new(root).unwrap();
        let ok = unsafe { kr_bao_verify_chunk(c_root.as_ptr(), index, bytes.as_ptr(), bytes.len(), proof.as_ptr(), sibs.len()) };
        assert_eq!(ok, 1, "FFI must verify the true chunk");
        let mut bad = bytes.clone(); bad[0] ^= 0xff;
        let no = unsafe { kr_bao_verify_chunk(c_root.as_ptr(), index, bad.as_ptr(), bad.len(), proof.as_ptr(), sibs.len()) };
        assert_eq!(no, 0, "FFI must refuse a tampered chunk");
    }

    // The full native verified-streaming loop: the PRODUCER (kr_bao_encoder_*) serves a large object's
    // chunks + proofs, and the CONSUMER (kr_bao_verify_chunk) verifies each against the producer's root —
    // O(1) per chunk, whole object never re-hashed, a tampered chunk refused. The host's low-latency path.
    #[test]
    fn ffi_bao_encoder_stream_round_trip() {
        let n = 300_000usize; // ~293 chunks
        let obj: Vec<u8> = (0..n).map(|i| ((i * 131 + 7) % 251) as u8).collect();
        unsafe {
            let enc = kr_bao_encoder_new(obj.as_ptr(), obj.len());
            assert!(!enc.is_null());
            let mut root = [0i8; 65];
            kr_bao_encoder_root(enc, root.as_mut_ptr());
            let root_str = CStr::from_ptr(root.as_ptr()).to_str().unwrap().to_string();
            let c_root = CString::new(root_str.clone()).unwrap();
            let count = kr_bao_encoder_chunk_count(enc);
            assert!(count > 64, "multi-chunk object");

            let mut verified = 0u64;
            for i in 0..count {
                let (mut cp, mut cl, mut pp, mut pc) = (std::ptr::null_mut(), 0usize, std::ptr::null_mut(), 0usize);
                assert_eq!(kr_bao_encoder_chunk(enc, i, &mut cp, &mut cl, &mut pp, &mut pc), 1);
                // consumer verifies the producer's chunk against the producer's root
                let ok = kr_bao_verify_chunk(c_root.as_ptr(), i, cp, cl, pp, pc);
                assert_eq!(ok, 1, "produced chunk {i} must verify");
                if i == 7 {
                    // tamper the served chunk → refused
                    let mut bad = std::slice::from_raw_parts(cp, cl).to_vec();
                    bad[0] ^= 0xff;
                    assert_eq!(kr_bao_verify_chunk(c_root.as_ptr(), i, bad.as_ptr(), bad.len(), pp, pc), 0, "tampered produced chunk refused");
                }
                kr_free(cp, cl);
                kr_free(pp, pc * 33);
                verified += 1;
            }
            assert_eq!(verified, count);
            // out of range → 0
            let (mut cp, mut cl, mut pp, mut pc) = (std::ptr::null_mut(), 0usize, std::ptr::null_mut(), 0usize);
            assert_eq!(kr_bao_encoder_chunk(enc, count, &mut cp, &mut cl, &mut pp, &mut pc), 0);
            kr_bao_encoder_free(enc);
        }
    }

    // The CEF host calls kr_fabric_goodput to surface the IB-class proof live; assert it returns well-formed
    // JSON with the bare-metal ceilings + the redundancy sweep + the honest notes.
    #[test]
    fn ffi_fabric_goodput_json() {
        let p = kr_fabric_goodput(8);
        assert!(!p.is_null());
        let s = unsafe { CStr::from_ptr(p) }.to_str().unwrap().to_string();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["object_mb"], 8);
        assert!(v["verify_ok"].as_bool().unwrap(), "the proof's own stream must verify");
        assert!(v["ceilings_gbs"]["bao_verify_allcores"].as_f64().unwrap() > v["ceilings_gbs"]["bao_verify_1core"].as_f64().unwrap(), "parallel verify faster than single-core");
        assert!(v["sweep"].as_array().unwrap().len() == 2 && v["notes"].as_array().unwrap().len() >= 3);
        unsafe { kr_cache_free_mime(p) };
    }

    #[test]
    fn ffi_round_trip_and_refusal() {
        let root = seal_one("rt");
        let c_root = CString::new(root.to_str().unwrap()).unwrap();
        let st = unsafe { kr_store_open(c_root.as_ptr(), std::ptr::null()) };
        assert!(!st.is_null(), "store must open");

        // verified hit → 200, bytes + mime returned
        let req = CString::new("/os/a.js").unwrap();
        let (mut ptr, mut len, mut mime) = (std::ptr::null_mut(), 0usize, std::ptr::null());
        let code = unsafe { kr_resolve(st, req.as_ptr(), &mut ptr, &mut len, &mut mime) };
        assert_eq!(code, 200);
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        assert_eq!(bytes, b"export const ok = 1;\n");
        let mime_s = unsafe { CStr::from_ptr(mime) }.to_str().unwrap();
        assert_eq!(mime_s, "text/javascript; charset=utf-8");
        unsafe { kr_free(ptr, len) };

        // unpinned → 403, out-params cleared
        let req = CString::new("/os/b.js").unwrap();
        let (mut ptr, mut len, mut mime) = (std::ptr::null_mut(), 0usize, std::ptr::null());
        let code = unsafe { kr_resolve(st, req.as_ptr(), &mut ptr, &mut len, &mut mime) };
        assert_eq!(code, 403);
        assert!(ptr.is_null() && len == 0 && mime.is_null());

        unsafe { kr_store_free(st) };
    }

    #[test]
    fn cache_abi_hit_miss_dedup() {
        let c = kr_cache_new(64);
        let url1 = CString::new("https://cdn/lib.js").unwrap();
        let url2 = CString::new("https://other/lib.js").unwrap(); // different url, SAME bytes ⇒ dedup
        let body = b"console.log(1);";
        let mime = CString::new("text/javascript").unwrap();

        // cold miss on url1
        let (mut p, mut l, mut m) = (std::ptr::null_mut(), 0usize, std::ptr::null_mut());
        assert_eq!(unsafe { kr_cache_get(c, url1.as_ptr(), &mut p, &mut l, &mut m) }, 0, "cold = miss");
        unsafe { kr_cache_put(c, url1.as_ptr(), body.as_ptr(), body.len(), mime.as_ptr(), 1) };

        // hit on url1 → exact bytes back, served without network
        let (mut p, mut l, mut m) = (std::ptr::null_mut(), 0usize, std::ptr::null_mut());
        assert_eq!(unsafe { kr_cache_get(c, url1.as_ptr(), &mut p, &mut l, &mut m) }, 1, "warm = hit");
        assert_eq!(unsafe { std::slice::from_raw_parts(p, l) }, body);
        assert_eq!(unsafe { CStr::from_ptr(m) }.to_str().unwrap(), "text/javascript");
        unsafe { kr_free(p, l) };
        unsafe { kr_cache_free_mime(m) };

        // url2 carries identical bytes → dedup to one κ (put it, then both serve from the same entry)
        unsafe { kr_cache_put(c, url2.as_ptr(), body.as_ptr(), body.len(), mime.as_ptr(), 1) };
        let (mut p, mut l, mut m) = (std::ptr::null_mut(), 0usize, std::ptr::null_mut());
        assert_eq!(unsafe { kr_cache_get(c, url2.as_ptr(), &mut p, &mut l, &mut m) }, 1);
        unsafe { kr_free(p, l) };
        unsafe { kr_cache_free_mime(m) };
        assert_eq!(unsafe { (*c).0.lock().unwrap().unique_kappa() }, 1, "identical bytes dedup to ONE κ");

        unsafe { kr_cache_free(c) };
    }

    #[test]
    fn cache_entries_lists_metadata_without_bodies() {
        let c = kr_cache_new(64);
        let url = CString::new("https://x/app.js").unwrap();
        let body = b"console.log(1);";                         // 15 bytes
        let mime = CString::new("text/javascript").unwrap();
        unsafe { kr_cache_put(c, url.as_ptr(), body.as_ptr(), body.len(), mime.as_ptr(), 1) };

        let j = unsafe { kr_cache_entries(c) };
        let s = unsafe { CStr::from_ptr(j) }.to_str().unwrap().to_string();
        // the manifest carries url + κ + mime + len …
        assert!(s.contains("https://x/app.js"), "lists the url");
        assert!(s.contains("did:holo:sha256:"), "lists the content κ");
        assert!(s.contains("text/javascript") && s.contains("15"), "lists mime + len");
        // … but NO bodies
        assert!(!s.contains("console.log"), "the listing must NOT contain bodies");
        // valid JSON array of one object
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(v.is_array() && v.as_array().unwrap().len() == 1);

        unsafe { kr_cache_free_mime(j) };
        unsafe { kr_cache_free(c) };
    }

    #[test]
    fn cache_get_by_kappa_round_trips() {
        let c = kr_cache_new(64);
        let url = CString::new("https://x/page.html").unwrap();
        let body = b"<!doctype html><title>Hi</title>";
        let mime = CString::new("text/html").unwrap();
        unsafe { kr_cache_put(c, url.as_ptr(), body.as_ptr(), body.len(), mime.as_ptr(), 0) };

        // get the κ from the manifest, then fetch the bytes BY that κ (the substrate did:holo form)
        let manifest = unsafe { CStr::from_ptr(kr_cache_entries(c)).to_str().unwrap().to_string() };
        let v: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        let kappa = v[0]["kappa"].as_str().unwrap().to_string();
        assert!(kappa.starts_with("did:holo:sha256:"));

        let kc = CString::new(kappa).unwrap();
        let (mut p, mut l, mut m) = (std::ptr::null_mut(), 0usize, std::ptr::null_mut());
        assert_eq!(unsafe { kr_cache_get_kappa(c, kc.as_ptr(), &mut p, &mut l, &mut m) }, 1, "hit by κ");
        assert_eq!(unsafe { std::slice::from_raw_parts(p, l) }, body, "bytes match the captured doc");
        assert_eq!(unsafe { CStr::from_ptr(m) }.to_str().unwrap(), "text/html");
        unsafe { kr_free(p, l) };
        unsafe { kr_cache_free_mime(m) };

        // an unknown κ misses
        let bad = CString::new("did:holo:sha256:".to_string() + &"0".repeat(64)).unwrap();
        let (mut p, mut l, mut m) = (std::ptr::null_mut(), 0usize, std::ptr::null_mut());
        assert_eq!(unsafe { kr_cache_get_kappa(c, bad.as_ptr(), &mut p, &mut l, &mut m) }, 0, "unknown κ misses");

        unsafe { kr_cache_free(c) };
    }
}
