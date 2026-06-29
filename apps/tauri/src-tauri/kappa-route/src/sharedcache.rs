// sharedcache.rs — the PLANETARY layer of the open-web κ-cache: a SHARED, content-addressed substrate
// behind a swappable transport. Where WebCache (webcache.rs) is THIS machine's local store keyed by url→κ,
// SharedCache is keyed BY κ and backed by a transport every node can reach — so the web's FIRST load for
// YOU is served from a blob some PEER already minted, with the origin never touched and only a hash ever
// crossing the wire. Twin of holo-sharedcache.mjs (witnessed 7/7 on real web bytes).
//
// Trust: a read ALWAYS re-derives the κ from the bytes and refuses a mismatch (Law L5). This is what makes
// a shared/untrusted relay safe — a hostile peer that returns wrong bytes for a κ is rejected (fail-safe;
// the caller falls back to origin), never served. Privacy: the transport is addressed ONLY by κ, never a
// URL — a peer learns "someone wants the bytes with hash X", not "someone is visiting site Y".
//
// Transport (this first landing): a DIRECTORY is the shared substrate — each blob is a file named by its κ.
// A faithful, cross-process, persistent stand-in for a relay / DHT / shared mount, fully cargo-testable with
// no network. A real network relay is the SAME interface (get/put BY κ); swap the backend, keep the L5 guard.
//
// Wiring (handler.cc, the follow-up): on a LOCAL κ-cache miss, before the origin load, kr_shared_get(κ) →
// serve with X-Holo-Source: kappa-shared; and the tee filter that already content-addresses a cold body
// also kr_shared_put(κ, bytes) so the next node anywhere rides it. The κ for a request comes from the
// page's SRI (integrity="sha256-…") surfaced from the renderer, or a gossiped url→κ manifest.

use std::ffi::{c_char, CStr};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::{blake3_hex, sha256_hex};

/// Normalize a caller-supplied κ to a bare 64-char lowercase-hex content address, or None if it is not a
/// well-formed sha256 κ. This is BOTH a correctness check and the path-traversal guard: the κ becomes a
/// filename, so anything but 64 hex chars (e.g. "../", absolute paths) is refused before touching the FS.
fn normalize_kappa(k: &str) -> Option<String> {
    let hex = k.strip_prefix("did:holo:sha256:").unwrap_or(k);
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

/// Same guard for the BLAKE3 σ-axis (projection tiles). Strips the blake3 DID prefix; 64-hex only.
fn normalize_b3(k: &str) -> Option<String> {
    let hex = k.strip_prefix("did:holo:blake3:").unwrap_or(k);
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

/// A shared, content-addressed substrate. Cheap to open (just remembers the dir); each get/put is one FS op.
///
/// The BYTE transport is κ-only (private): get/put never touch a URL. Separately, an OPTIONAL url→κ
/// `manifest` sidecar (`_manifest.tsv`) lets a node that has NEVER fetched a url learn its κ — the gossip
/// path, so the planetary first-load works without renderer SRI. The manifest reveals url↔κ (a public fact:
/// anyone can fetch the url and compute the κ); a future SRI source makes it unnecessary and fully private.
pub struct SharedCache {
    dir: PathBuf,
    manifest: std::collections::HashMap<String, String>, // url → κ (bare hex); the gossiped κ-source
    pub hits: u64,
    pub misses: u64,
    pub published: u64,
    pub refused_tamper: u64,
    pub bytes_served: u64,
}

impl SharedCache {
    /// Open (creating if needed) the shared substrate rooted at `dir`. Two handles over the same dir are two
    /// nodes sharing the same relay. Loads any existing url→κ manifest (the gossip κ-source).
    pub fn open(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        let mut manifest = std::collections::HashMap::new();
        if let Ok(text) = fs::read_to_string(dir.join("_manifest.tsv")) {
            for line in text.lines() {
                if let Some((url, k)) = line.split_once('\t') {
                    if let Some(hex) = normalize_kappa(k) {
                        manifest.insert(url.to_string(), hex);
                    }
                }
            }
        }
        SharedCache { dir, manifest, hits: 0, misses: 0, published: 0, refused_tamper: 0, bytes_served: 0 }
    }

    fn blob_path(&self, hex: &str) -> PathBuf {
        self.dir.join(format!("{hex}.blob"))
    }

    /// BLAKE3 blobs live in a SEPARATE `b3/` namespace so a blake3-addressed blob is never read+verified on the
    /// sha256 path (which would re-derive sha256, see a mismatch, and falsely "tamper"-delete a valid tile).
    fn blob_path_b3(&self, hex: &str) -> PathBuf {
        self.dir.join("b3").join(format!("{hex}.blob"))
    }

    /// BLAKE3 σ-axis get — the projection cross-device path. Re-derives BLAKE3 and REFUSES a mismatch (L5),
    /// exactly like `get` does for sha256. The substrate is blake3-canonical; tiles never touch sha256.
    pub fn get_b3(&mut self, kappa: &str) -> Option<(Vec<u8>, String)> {
        let hex = match normalize_b3(kappa) {
            Some(h) => h,
            None => { self.misses += 1; return None; }
        };
        let raw = match fs::read(self.blob_path_b3(&hex)) {
            Ok(b) => b,
            Err(_) => { self.misses += 1; return None; }
        };
        let nl = raw.iter().position(|&b| b == b'\n');
        let (mime, body) = match nl {
            Some(i) => (String::from_utf8_lossy(&raw[..i]).into_owned(), raw[i + 1..].to_vec()),
            None => { let _ = fs::remove_file(self.blob_path_b3(&hex)); self.refused_tamper += 1; return None; }
        };
        if blake3_hex(&body) != hex {
            let _ = fs::remove_file(self.blob_path_b3(&hex));
            self.refused_tamper += 1;
            return None;
        }
        self.hits += 1;
        self.bytes_served += body.len() as u64;
        Some((body, mime))
    }

    /// BLAKE3 σ-axis put (deduped by blake3). The address is recomputed from the bytes — a caller cannot
    /// mislabel content. Idempotent. Returns the blake3 hex.
    pub fn put_b3(&mut self, bytes: &[u8], mime: &str) -> String {
        let hex = blake3_hex(bytes);
        let dest = self.blob_path_b3(&hex);
        if dest.exists() {
            return hex;
        }
        let _ = fs::create_dir_all(self.dir.join("b3"));
        let mut blob = Vec::with_capacity(mime.len() + 1 + bytes.len());
        blob.extend_from_slice(mime.as_bytes());
        blob.push(b'\n');
        blob.extend_from_slice(bytes);
        let tmp = self.dir.join("b3").join(format!("{hex}.blob.tmp"));
        if fs::write(&tmp, &blob).is_ok() && fs::rename(&tmp, &dest).is_ok() {
            self.published += 1;
        } else {
            let _ = fs::remove_file(&tmp);
        }
        hex
    }

    /// Record that `url`'s content is `kappa` (called on a cold miss, alongside put). Persists the manifest so
    /// another node can resolve url→κ without ever fetching the url. A url containing a tab/newline is skipped
    /// (the TSV format reserves them); real http(s) urls never do.
    pub fn note(&mut self, url: &str, kappa: &str) {
        let hex = match normalize_kappa(kappa) {
            Some(h) => h,
            None => return,
        };
        if url.contains('\t') || url.contains('\n') {
            return;
        }
        if self.manifest.get(url) == Some(&hex) {
            return; // already known — no rewrite
        }
        self.manifest.insert(url.to_string(), hex);
        // Persist atomically (temp + rename) so a concurrent reader never sees a half-written manifest.
        let mut body = String::with_capacity(self.manifest.len() * 80);
        for (u, k) in &self.manifest {
            body.push_str(u);
            body.push('\t');
            body.push_str(k);
            body.push('\n');
        }
        let tmp = self.dir.join("_manifest.tsv.tmp");
        if fs::write(&tmp, &body).is_ok() {
            let _ = fs::rename(&tmp, self.dir.join("_manifest.tsv"));
        }
    }

    /// The κ a peer recorded for `url`, if any (the gossip κ-source for the HIT seam). Bytes still move BY κ.
    pub fn kappa_for(&self, url: &str) -> Option<String> {
        self.manifest.get(url).cloned()
    }

    /// List the κ (bare 64-hex) this node holds — the `LocalIterator` a mesh peer answers `discover`
    /// with (the upstream `KappaStore::iterate`). Unordered on disk → sorted for a deterministic reply.
    pub fn iterate(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if let Some(hex) = name.strip_suffix(".blob") {
                    if normalize_kappa(hex).is_some() {
                        out.push(hex.to_string());
                    }
                }
            }
        }
        out.sort();
        out
    }

    /// Fetch bytes for a κ from the shared substrate. Re-derives the κ and REFUSES a mismatch (a hostile or
    /// corrupt blob is deleted and treated as a miss — never served). `None` ⇒ caller falls back to origin.
    /// On-disk format: `<mime>\n<body>` (mime never contains a newline). The κ addresses the BODY only.
    pub fn get(&mut self, kappa: &str) -> Option<(Vec<u8>, String)> {
        let hex = match normalize_kappa(kappa) {
            Some(h) => h,
            None => {
                self.misses += 1;
                return None;
            }
        };
        let raw = match fs::read(self.blob_path(&hex)) {
            Ok(b) => b,
            Err(_) => {
                self.misses += 1;
                return None;
            }
        };
        let nl = raw.iter().position(|&b| b == b'\n');
        let (mime, body) = match nl {
            Some(i) => (String::from_utf8_lossy(&raw[..i]).into_owned(), raw[i + 1..].to_vec()),
            None => {
                // malformed blob (no mime header) → refuse, don't trust
                let _ = fs::remove_file(self.blob_path(&hex));
                self.refused_tamper += 1;
                return None;
            }
        };
        if sha256_hex(&body) != hex {
            // a peer returned wrong bytes for this κ → fail-closed (L5). Drop the poison, count it, miss.
            let _ = fs::remove_file(self.blob_path(&hex));
            self.refused_tamper += 1;
            return None;
        }
        self.hits += 1;
        self.bytes_served += body.len() as u64;
        Some((body, mime))
    }

    /// Publish bytes to the shared substrate, deduped by κ. The κ is recomputed from the BYTES (a caller
    /// cannot mislabel content) and used as the address. Idempotent: re-publishing the same bytes is a no-op.
    /// Returns the κ (bare hex). Writes atomically (temp + rename) so a concurrent reader never sees a partial.
    pub fn put(&mut self, bytes: &[u8], mime: &str) -> String {
        let hex = sha256_hex(bytes);
        let dest = self.blob_path(&hex);
        if dest.exists() {
            return hex; // already minted by someone — dedup across the whole web
        }
        let mut blob = Vec::with_capacity(mime.len() + 1 + bytes.len());
        blob.extend_from_slice(mime.as_bytes());
        blob.push(b'\n');
        blob.extend_from_slice(bytes);
        let tmp = self.dir.join(format!("{hex}.blob.tmp"));
        if fs::write(&tmp, &blob).is_ok() && fs::rename(&tmp, &dest).is_ok() {
            self.published += 1;
        } else {
            let _ = fs::remove_file(&tmp);
        }
        hex
    }
}

// ── C ABI (kr_shared_*) — mirrors kr_cache_* in ffi.rs; the handle wraps a Mutex because CEF resource
//    callbacks run off the UI thread. Bytes free with kr_free; mime free with kr_cache_free_mime. ──────────
pub struct KShared(Mutex<SharedCache>);

/// Open the shared substrate at `dir` (UTF-8 path). Free with kr_shared_free. NULL on bad input.
/// # Safety: `dir` must be a valid NUL-terminated C string (or NULL).
#[no_mangle]
pub unsafe extern "C" fn kr_shared_open(dir: *const c_char) -> *mut KShared {
    if dir.is_null() {
        return std::ptr::null_mut();
    }
    let s = match CStr::from_ptr(dir).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    Box::into_raw(Box::new(KShared(Mutex::new(SharedCache::open(PathBuf::from(s))))))
}

/// # Safety: `c` must be a kr_shared_open pointer (or NULL), freed at most once.
#[no_mangle]
pub unsafe extern "C" fn kr_shared_free(c: *mut KShared) {
    if !c.is_null() {
        drop(Box::from_raw(c));
    }
}

/// Fetch bytes for a κ. Returns 1 on a verified hit (out-params filled: bytes free with kr_free, mime free
/// with kr_cache_free_mime), 0 on miss/refusal. `kappa` may be bare 64-hex or `did:holo:sha256:<hex>`.
/// # Safety: `c` valid; `kappa` a NUL-terminated C string; out pointers writable.
#[no_mangle]
pub unsafe extern "C" fn kr_shared_get(
    c: *const KShared,
    kappa: *const c_char,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
    out_mime: *mut *mut c_char,
) -> u8 {
    if c.is_null() || kappa.is_null() {
        return 0;
    }
    let k = match CStr::from_ptr(kappa).to_str() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let cache = &*c;
    let mut guard = match cache.0.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    match guard.get(k) {
        Some((bytes, mime)) => {
            *out_len = bytes.len();
            *out_ptr = Box::into_raw(bytes.into_boxed_slice()) as *mut u8;
            let cm = std::ffi::CString::new(mime).unwrap_or_default();
            *out_mime = cm.into_raw();
            1
        }
        None => 0,
    }
}

/// Publish bytes to the shared substrate (deduped by κ). `kappa` is advisory — the address is recomputed
/// from the bytes, so a caller cannot mislabel content.
/// # Safety: `c` valid; `data` points to `len` bytes; `mime` a NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn kr_shared_put(
    c: *const KShared,
    _kappa: *const c_char,
    data: *const u8,
    len: usize,
    mime: *const c_char,
) {
    if c.is_null() || data.is_null() {
        return;
    }
    let bytes = std::slice::from_raw_parts(data, len);
    let mime_s = if mime.is_null() {
        "application/octet-stream".to_string()
    } else {
        CStr::from_ptr(mime).to_str().unwrap_or("application/octet-stream").to_string()
    };
    if let Ok(mut guard) = (*c).0.lock() {
        guard.put(bytes, &mime_s);
    }
}

/// BLAKE3 σ-axis get — the projection cross-device transport (the substrate is blake3-canonical). Returns 1 on
/// a verified hit, 0 on miss/refusal. `kappa` may be bare 64-hex or `did:holo:blake3:<hex>`.
/// # Safety: as kr_shared_get.
#[no_mangle]
pub unsafe extern "C" fn kr_shared_get_b3(
    c: *const KShared,
    kappa: *const c_char,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
    out_mime: *mut *mut c_char,
) -> u8 {
    if c.is_null() || kappa.is_null() {
        return 0;
    }
    let k = match CStr::from_ptr(kappa).to_str() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let mut guard = match (*c).0.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    match guard.get_b3(k) {
        Some((bytes, mime)) => {
            *out_len = bytes.len();
            *out_ptr = Box::into_raw(bytes.into_boxed_slice()) as *mut u8;
            let cm = std::ffi::CString::new(mime).unwrap_or_default();
            *out_mime = cm.into_raw();
            1
        }
        None => 0,
    }
}

/// BLAKE3 σ-axis put (deduped by blake3; the address is recomputed from the bytes).
/// # Safety: as kr_shared_put.
#[no_mangle]
pub unsafe extern "C" fn kr_shared_put_b3(c: *const KShared, data: *const u8, len: usize, mime: *const c_char) {
    if c.is_null() || data.is_null() {
        return;
    }
    let bytes = std::slice::from_raw_parts(data, len);
    let mime_s = if mime.is_null() {
        "application/octet-stream".to_string()
    } else {
        CStr::from_ptr(mime).to_str().unwrap_or("application/octet-stream").to_string()
    };
    if let Ok(mut guard) = (*c).0.lock() {
        guard.put_b3(bytes, &mime_s);
    }
}

/// Record url→κ in the shared manifest (the gossip κ-source) so another node can resolve this url's content
/// address without fetching it. Called on a cold miss alongside kr_shared_put.
/// # Safety: `c` valid; `url`/`kappa` NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn kr_shared_note(c: *const KShared, url: *const c_char, kappa: *const c_char) {
    if c.is_null() || url.is_null() || kappa.is_null() {
        return;
    }
    let (u, k) = match (CStr::from_ptr(url).to_str(), CStr::from_ptr(kappa).to_str()) {
        (Ok(u), Ok(k)) => (u, k),
        _ => return,
    };
    if let Ok(mut guard) = (*c).0.lock() {
        guard.note(u, k);
    }
}

/// The κ a peer recorded for `url`, or NULL if unknown. Heap C string (bare 64-hex); free with
/// kr_cache_free_mime. This is the κ the HIT seam asks the shared substrate for.
/// # Safety: `c` valid; `url` a NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn kr_shared_kappa_for(c: *const KShared, url: *const c_char) -> *mut c_char {
    if c.is_null() || url.is_null() {
        return std::ptr::null_mut();
    }
    let u = match CStr::from_ptr(url).to_str() {
        Ok(u) => u,
        Err(_) => return std::ptr::null_mut(),
    };
    let found = (*c).0.lock().ok().and_then(|g| g.kappa_for(u));
    match found {
        Some(hex) => std::ffi::CString::new(hex).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut()),
        None => std::ptr::null_mut(),
    }
}

// ── witness: the planetary shared-κ thesis holds at the Rust/transport layer ─────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("holo-sharedcache-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn planetary_shared_kappa_thesis() {
        let dir = tmpdir("thesis");
        let jq = b"/* jquery 3.7.1 */ (function(){ /* ... */ })();".repeat(50);
        let k = sha256_hex(&jq);

        // Node A (first visitor) mints the κ into the shared substrate after its cold origin fetch.
        let mut a = SharedCache::open(dir.clone());
        a.put(&jq, "application/javascript");
        assert_eq!(a.published, 1, "A published one blob");

        // G1 — planetary first-load: Node B is a SEPARATE handle (a different machine) over the same relay.
        // It has NEVER fetched jQuery; given the κ (from the page's SRI), it serves from the substrate.
        let mut b = SharedCache::open(dir.clone());
        let got = b.get(&k).expect("B serves jQuery from the shared substrate");
        assert_eq!(got.0, jq, "B got the correct, verified bytes");
        assert_eq!(got.1, "application/javascript", "mime preserved");
        assert_eq!(b.hits, 1, "B served from a peer's κ — zero origin");

        // G2 — dedup: re-publishing identical bytes (e.g. from a 2nd CDN URL) is a no-op; one blob on disk.
        a.put(&jq, "application/javascript");
        assert_eq!(a.published, 1, "identical bytes dedup to ONE blob across the web");
        let blobs: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".blob")).collect();
        assert_eq!(blobs.len(), 1, "exactly one blob for jQuery despite two publishes");

        // G3 — privacy: every on-disk name is a 64-hex κ + .blob — NO url/hostname is stored anywhere.
        for e in &blobs {
            let name = e.file_name().to_string_lossy().replace(".blob", "");
            assert!(normalize_kappa(&name).is_some(), "blob named by κ only, not a url: {name}");
        }

        // G4 — poisoned mirror: corrupt the blob body on disk; a κ-get must REFUSE it (L5), not serve poison.
        let blob_path = dir.join(format!("{k}.blob"));
        fs::write(&blob_path, b"application/javascript\n/* EVIL PAYLOAD */").unwrap();
        let mut c = SharedCache::open(dir.clone());
        let poisoned = c.get(&k);
        assert!(poisoned.is_none(), "a tampered blob is REFUSED, never served");
        assert_eq!(c.refused_tamper, 1, "tamper counted (L5 fail-closed)");
        assert!(!blob_path.exists(), "the poison blob was dropped");

        // G5 — cold-novel honesty: a κ no peer has is a miss (caller goes to origin — no false instant).
        let novel = sha256_hex(b"a one-off inline asset nobody else has");
        let mut d = SharedCache::open(dir.clone());
        assert!(d.get(&novel).is_none(), "unknown κ → miss → origin-bound");
        assert_eq!(d.misses, 1);

        // Path-traversal guard: a malformed/hostile κ never escapes the dir.
        let mut e = SharedCache::open(dir.clone());
        assert!(e.get("../../etc/passwd").is_none(), "traversal refused");
        assert!(e.get("not-a-kappa").is_none(), "non-κ refused");

        let _ = fs::remove_dir_all(&dir);
        eprintln!("GREEN planetary shared-κ: B served {} verified bytes from a peer's κ, 0 origin; dedup+L5+privacy hold", jq.len());
    }

    #[test]
    fn gossip_manifest_kappa_source() {
        // The planetary first-load needs node B to know a url's κ WITHOUT fetching it. Node A records url→κ
        // on its cold miss; B (a separate handle / machine over the same relay) resolves it and serves by κ.
        let dir = tmpdir("gossip");
        let css = b"body{margin:0}".repeat(40);
        let url = "https://cdn.example/site.css";

        let mut a = SharedCache::open(dir.clone());
        let k = a.put(&css, "text/css");           // A mints the blob …
        a.note(url, &k);                            // … and gossips url→κ

        // B is a FRESH node: it has never fetched this url, but the shared manifest gives it the κ.
        let mut b = SharedCache::open(dir.clone());
        let learned = b.kappa_for(url).expect("B learns the url's κ from the gossiped manifest");
        assert_eq!(learned, k, "B resolves url→κ without fetching the url");
        let (bytes, mime) = b.get(&learned).expect("B serves the bytes by κ");
        assert_eq!(bytes, css);
        assert_eq!(mime, "text/css");
        assert_eq!(b.hits, 1, "B served from the substrate — zero origin");

        // A url the manifest doesn't know → no κ → caller goes to origin (honest).
        assert!(b.kappa_for("https://cdn.example/unknown.js").is_none(), "unknown url → no gossiped κ");

        // The manifest persisted to disk (a 3rd node would load it on open).
        let manifest = fs::read_to_string(dir.join("_manifest.tsv")).unwrap();
        assert!(manifest.contains(url) && manifest.contains(&k), "url→κ persisted for the next node");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ffi_round_trip() {
        use std::ffi::CString;
        let dir = tmpdir("ffi");
        let cdir = CString::new(dir.to_str().unwrap()).unwrap();
        let body = b"console.log('shared by kappa');".repeat(10);
        let k = sha256_hex(&body);
        let ck = CString::new(k.clone()).unwrap();
        let mime = CString::new("application/javascript").unwrap();

        unsafe {
            let pubh = kr_shared_open(cdir.as_ptr());
            assert!(!pubh.is_null());
            kr_shared_put(pubh, ck.as_ptr(), body.as_ptr(), body.len(), mime.as_ptr());

            // a DIFFERENT handle (another node) gets it by κ
            let geth = kr_shared_open(cdir.as_ptr());
            let mut p: *mut u8 = std::ptr::null_mut();
            let mut l: usize = 0;
            let mut m: *mut c_char = std::ptr::null_mut();
            let hit = kr_shared_get(geth, ck.as_ptr(), &mut p, &mut l, &mut m);
            assert_eq!(hit, 1, "ffi: by-κ hit across handles");
            let served = std::slice::from_raw_parts(p, l).to_vec();
            assert_eq!(served, body, "ffi: bytes round-trip verified");
            assert_eq!(CStr::from_ptr(m).to_str().unwrap(), "application/javascript");

            // free out-params with the documented allocators
            crate::ffi::kr_free(p, l);
            crate::ffi::kr_cache_free_mime(m);

            // unknown κ → 0
            let bogus = CString::new(sha256_hex(b"nobody has this")).unwrap();
            assert_eq!(kr_shared_get(geth, bogus.as_ptr(), &mut p, &mut l, &mut m), 0, "ffi: unknown κ miss");

            kr_shared_free(pubh);
            kr_shared_free(geth);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
