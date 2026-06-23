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
}
