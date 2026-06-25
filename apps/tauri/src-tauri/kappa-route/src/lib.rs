// kappa-route — the κ-route verification core (holospaces Law L5 / SEC-1 / SEC-6).
//
// The native host serves a flat, self-sealed OS image (`dist/`, built by ../make-dist.mjs) over the
// `holo://` scheme. This crate is the verifier underneath that scheme, with NO webview dependency:
//   • load_store()  folds dist/os-closure.json into a dual-axis pin map (sha256 ⊕ blake3 σ-axis);
//   • resolve()     maps a request path to a file, RE-DERIVES both content addresses, and refuses a
//                   mismatch on either axis — and refuses any UNPINNED byte in the sealed image
//                   (fail-closed), except the two bootstrap files fetched by name.
// Keeping this engine-agnostic means the same audited code serves Tauri (WebView2) today and CEF
// (chromium.git) next, and its witness runs without a GUI.

use std::collections::HashMap;
use std::ffi::CStr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

pub mod ffi;
pub mod webcache;
pub mod sharedcache;  // planetary layer: shared, content-addressed substrate (kr_shared_*), L5-verified
pub mod meshsync;     // native networking P1: wire-compatible κ content-network peer (BareNetSync frames)
pub mod meshget;      // native networking P3b: lean std::net bridge to the mesh sidecar (kr_mesh_get)
pub mod did;          // P5 host wiring: did:holo κ-rooted peer identity (kr_did_*)
pub mod bao;          // verified streaming: per-chunk proof verification over the canonical blake3 κ
pub mod fabric;       // κ-fabric effective-goodput model (InfiniBand-class proof), exposed via kr_fabric_goodput
pub mod semantic;     // P5 host wiring: W3C Linked Data validate-before-serve (kr_ld_validate)

/// Expected content address(es) for one served path, lower-case hex. The CANONICAL axis is BLAKE3
/// (the substrate's kappo); sha256 is demoted to a re-derivable bridge alias kept for legacy
/// `.holo/sha256/<hex>` links and foreign-protocol interop. A pin always carries at least one axis.
pub struct Pin {
    /// the CANONICAL κ axis (did:holo:blake3:…) = the substrate's kappo(). The trust check the verifier
    /// prefers. Present on every freshly-sealed object; Option only for pre-cutover (sha-only) images.
    pub blake3: Option<String>,
    /// the sha256 BRIDGE alias (did:holo:sha256:…) — kept re-derivable for legacy links / IPFS / interop.
    pub sha256: Option<String>,
}

impl Pin {
    /// canonical cache key: the blake3 κ when present, else the sha256 bridge alias.
    fn key(&self) -> &str {
        self.blake3.as_deref().or(self.sha256.as_deref()).unwrap_or("")
    }
}

/// A sealed image: its root dir, the dual-axis closure folded from os-closure.json, and a by-κ cache
/// of VERIFIED bytes. Caching by the sha256 κ is holospaces-faithful (L3: "the store is the memory; a
/// resolution is a page fault") and safe: the cache only ever holds bytes that already re-derived to
/// their pinned κ, so a later on-disk tamper cannot affect a warm hit — and identical content under
/// different paths shares one entry (SEC-3 dedup). A cold (uncached) load still verifies or refuses.
pub struct KStore {
    pub root: PathBuf,
    pub closure: HashMap<String, Pin>,
    cache: Mutex<HashMap<String, Arc<Vec<u8>>>>,  // canonical κ (blake3, else sha256 alias) → verified bytes
    poisoned: bool,                               // closure anchor mismatch → refuse everything
    apps: HashMap<String, String>,                // holospace κ (sha256 hex) → app dir, e.g. "apps/amp"
    byhex: HashMap<String, String>,               // sha256 hex → dist path (the content-address index)
    byblake: HashMap<String, String>,             // blake3 hex → dist path (σ-axis content index)
}

/// Bootstrap files are fetched BY NAME and live OUTSIDE the closure by design (make-dist.mjs): the
/// manifest cannot pin itself, and the worker is re-baked (its anchor) after sealing so any pin would
/// be stale. These — and ONLY these — are exempt from the fail-closed unpinned check.
fn is_bootstrap(rel: &str) -> bool {
    rel == "os-closure.json" || rel == "holo-fhs-sw.js"
}

fn hex_tail(k: &str) -> String {
    k.rsplit(':').next().unwrap_or("").to_ascii_lowercase()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// the substrate σ-axis: standard BLAKE3, byte-identical to usr/lib/holo/holo-blake3.mjs.
fn blake3_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

// Returns a NUL-terminated &'static CStr so the SAME table serves both Rust (header value, via
// .to_str()) and the C ABI (mime pointer, via .as_ptr()) — one source of truth, no duplicate table.
pub fn content_type(path: &str) -> &'static CStr {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => c"text/html; charset=utf-8",
        "js" | "mjs" => c"text/javascript; charset=utf-8",
        "css" => c"text/css; charset=utf-8",
        "json" => c"application/json; charset=utf-8",
        "jsonld" => c"application/ld+json; charset=utf-8",
        "wasm" => c"application/wasm",
        "svg" => c"image/svg+xml",
        "png" => c"image/png",
        "jpg" | "jpeg" => c"image/jpeg",
        "webp" => c"image/webp",
        "ico" => c"image/x-icon",
        "woff2" => c"font/woff2",
        "woff" => c"font/woff",
        "ttf" => c"font/ttf",
        "webmanifest" => c"application/manifest+json",
        "txt" => c"text/plain; charset=utf-8",
        _ => c"application/octet-stream",
    }
}

/// Normalize a requested path to the OS's ONE flat URL key — the same space the dev server and the
/// Pages Service Worker speak (os/lib/holo-fhs-map.mjs). Two rules matter here; the rest of the FHS
/// map is already baked into the flat `dist/` by make-dist.mjs:
///   • drop the `os` root segment (Tauri exposes the URL host as a path prefix on some platforms);
///   • collapse an app-relative `apps/<id>/_shared|pkg/…` ref to the top-level engine path — exactly
///     fhsMap's `(?:apps/<id>/)?_shared/` rule — so it hits one engine copy AND its closure pin.
pub fn flat_key(req_path: &str) -> String {
    let mut rel = req_path.trim_start_matches('/').to_string();
    if let Some(rest) = rel.strip_prefix("os/") {
        rel = rest.to_string();
    } else if rel == "os" {
        rel = String::new();
    }
    if let Some(i) = rel.find("/_shared/") {
        if rel.starts_with("apps/") {
            rel = rel[i + 1..].to_string();
        }
    }
    if let Some(i) = rel.find("/pkg/") {
        if rel.starts_with("apps/") {
            rel = rel[i + 1..].to_string();
        }
    }
    rel
}

/// Load a store from a sealed image root: parse `<root>/os-closure.json` into the dual-axis pin map.
///
/// `expected_anchor` is the trust root: the CANONICAL κ of os-closure.json itself — blake3(manifest), the
/// substrate's kappo, the same CLOSURE_KAPPA the service worker and HotStore bake. If supplied and the
/// on-disk manifest does NOT re-derive to it, the store is POISONED — every resolve is refused (G1/SEC-1
/// fail-closed) — so a swapped/tampered manifest cannot redefine what the OS is, even if its internal pins
/// are self-consistent. Pass None to skip the check (manifest trusted by path).
///
/// CANONICAL-κ cutover (P4): the anchor is matched on the canonical blake3 axis FIRST, accepting the legacy
/// sha256 bridge value as a fallback. This makes the trust-root flip atomic-safe — a stale sha-baked anchor
/// still validates its own manifest, while a tampered manifest matches NEITHER axis → fail closed.
pub fn load_store(root: PathBuf, expected_anchor: Option<String>) -> KStore {
    let mut closure = HashMap::new();
    let raw = std::fs::read(root.join("os-closure.json")).ok();

    let mut poisoned = false;
    if let Some(anchor) = expected_anchor.filter(|a| !a.is_empty()) {
        let anchor = anchor.to_ascii_lowercase();
        let ok = raw.as_ref().map_or(false, |b| blake3_hex(b) == anchor || sha256_hex(b) == anchor);
        poisoned = !ok; // manifest missing or != baked anchor on either axis → refuse everything
    }

    let mut byhex = HashMap::new();
    let mut byblake = HashMap::new();
    if let Some(bytes) = &raw {
        if let Ok(doc) = serde_json::from_slice::<serde_json::Value>(bytes) {
            if let Some(map) = doc.get("closure").and_then(|c| c.as_object()) {
                for (path, v) in map {
                    // CANONICAL κ = blake3: the top-level `blake3` field (primary) or a W3C alsoKnownAs alias.
                    let blake3 = v.get("blake3").and_then(|x| x.as_str()).map(hex_tail).or_else(|| {
                        v.get("alsoKnownAs").and_then(|a| a.as_array()).and_then(|arr| {
                            arr.iter().filter_map(|x| x.as_str()).find(|s| s.contains("blake3")).map(hex_tail)
                        })
                    });
                    // sha256 = the bridge alias (kappa/did/@id), or a bare-string legacy entry.
                    let sha256 = v.get("kappa").and_then(|x| x.as_str()).map(hex_tail)
                        .or_else(|| v.as_str().map(hex_tail));
                    if blake3.is_none() && sha256.is_none() { continue; }         // a pin must carry ≥1 axis
                    if let Some(b) = &blake3 { byblake.insert(b.clone(), path.clone()); }   // canonical content index
                    if let Some(s) = &sha256 { byhex.insert(s.clone(), path.clone()); }     // bridge-alias index
                    closure.insert(path.clone(), Pin { blake3, sha256 });
                }
            }
        }
    }

    // Merge each app's OWN seal (apps/<dir>/holospace.lock.json) into the pin set. Apps are independently
    // sealed κ-bundles; the OS closure pins only the shell. Without this, holo://<appκ>/ → apps/<dir>/
    // index.html is unpinned → L5 refuses it ("can't be reached"). Each lock entry is keyed by the SAME
    // flat path resolve_rel produces, with `kappa` (sha256) + a blake3 in `alsoKnownAs` — so every app byte
    // still re-derives to its pinned κ on both axes (Law L5 preserved). OS-closure pins win (or_insert).
    if let Ok(entries) = std::fs::read_dir(root.join("apps")) {
        for ent in entries.flatten() {
            let lock = ent.path().join("holospace.lock.json");
            let Ok(bytes) = std::fs::read(&lock) else { continue };
            let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) else { continue };
            let Some(map) = doc.get("closure").and_then(|c| c.as_object()) else { continue };
            for (path, v) in map {
                // app locks carry the canonical blake3 in `alsoKnownAs` (and, post-cutover, top-level `blake3`).
                let blake3 = v.get("blake3").and_then(|x| x.as_str()).map(hex_tail).or_else(|| {
                    v.get("alsoKnownAs").and_then(|a| a.as_array()).and_then(|arr| {
                        arr.iter().filter_map(|x| x.as_str()).find(|s| s.contains("blake3")).map(hex_tail)
                    })
                });
                let sha256 = v.get("kappa").and_then(|x| x.as_str()).map(hex_tail);
                if blake3.is_none() && sha256.is_none() { continue; }
                if let Some(s) = &sha256 { byhex.entry(s.clone()).or_insert_with(|| path.clone()); }
                if let Some(b) = &blake3 { byblake.entry(b.clone()).or_insert_with(|| path.clone()); }
                closure.entry(path.clone()).or_insert(Pin { blake3, sha256 });
            }
        }
    }

    // Build the holospace map: each app's κ (sha256 hex of its @id) → its dir in the image. This lets
    // holo://<κ>/ resolve to that app served as its OWN origin (per-holospace isolation, SEC-5).
    let mut apps = HashMap::new();
    if let Ok(txt) = std::fs::read_to_string(root.join("apps/index.jsonld")) {
        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(list) = doc.get("dcat:dataset").and_then(|d| d.as_array()) {
                for e in list {
                    let id = e.get("@id").and_then(|x| x.as_str());
                    let landing = e
                        .get("dcat:landingPage")
                        .or_else(|| e.get("schema:url"))
                        .and_then(|x| x.as_str());
                    if let (Some(id), Some(landing)) = (id, landing) {
                        let hex = hex_tail(id);
                        // dir = the landing's parent (apps/<id>/index.html → apps/<id>)
                        let dir = landing.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
                        if hex.len() == 64 && !dir.is_empty() {
                            apps.insert(hex, dir);
                        }
                    }
                }
            }
        }
    }

    KStore { root, closure, cache: Mutex::new(HashMap::new()), poisoned, apps, byhex, byblake }
}

/// Map a `holo://<host>/<rest>` request to a dist-relative path, host-aware:
///   • host "os" (or empty)  → the OS flat space (shell, home, top-level `_shared`/`pkg` engines);
///   • host = a holospace κ   → that app's dir; `_shared`/`pkg` collapse to the one verified engine
///     copy (served same-origin under the κ, so each holospace is isolated yet shares byte-identical
///     κ-pinned engines);
///   • unknown host           → None (404 — no such holospace).
fn resolve_rel(st: &KStore, req_path: &str) -> Option<String> {
    let p = req_path.trim_start_matches('/');
    let (host, rest) = match p.find('/') {
        Some(i) => (&p[..i], &p[i + 1..]),
        None => (p, ""),
    };

    // Content-address route (Law L1, any origin): holo://<host>/.holo/sha256|blake3/<hex> → the object
    // whose κ is <hex>, resolved via the by-κ index. This is the canonical κ-fetch (κ-DAG media chunks,
    // "open any object by its κ") — byte-identical to the web SW's /.holo/<axis>/<hex> route.
    for (prefix, index) in [(".holo/sha256/", &st.byhex), (".holo/blake3/", &st.byblake)] {
        if let Some(tail) = rest.strip_prefix(prefix) {
            let hex = tail.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
            return index.get(&hex).cloned(); // Some(path) → serve+verify; None → 404 (no such κ)
        }
    }

    if host.is_empty() || host == "os" {
        // OS flat space. (When there's no host segment at all, treat the whole thing as a flat path.)
        let mut rel = if host == "os" { rest.to_string() } else { p.to_string() };
        // collapse an app-relative `apps/<id>/_shared|pkg/…` to the top-level engine (fhsMap rule)
        if let Some(i) = rel.find("/_shared/") {
            if rel.starts_with("apps/") { rel = rel[i + 1..].to_string(); }
        }
        if let Some(i) = rel.find("/pkg/") {
            if rel.starts_with("apps/") { rel = rel[i + 1..].to_string(); }
        }
        if rel.is_empty() { rel = "home.html".to_string(); }
        else if rel.ends_with('/') { rel.push_str("index.html"); }
        Some(rel)
    } else if let Some(dir) = st.apps.get(host) {
        // per-app origin
        let rel = if rest.starts_with("_shared/") || rest.starts_with("pkg/") {
            rest.to_string()                                   // shared engine, top-level pin
        } else if rest.is_empty() {
            format!("{}/index.html", dir)
        } else if rest.ends_with('/') {
            format!("{}/{}index.html", dir, rest)
        } else {
            format!("{}/{}", dir, rest)
        };
        Some(rel)
    } else {
        None
    }
}

/// Resolve a `holo://os/<path>` request → verified bytes + mime, or an HTTP error code.
/// Law L5 / SEC-6 — re-derive the content address on BOTH axes and verify. The native image is fully
/// self-sealed (make-dist.mjs), so every served byte MUST be pinned: an unpinned byte is a post-seal
/// tamper and is refused (SEC-1 fail-closed) — except the two bootstrap files fetched by name.
pub fn resolve(st: &KStore, req_path: &str) -> Result<(Vec<u8>, &'static CStr), u16> {
    if st.poisoned {
        return Err(403); // trust root (closure anchor) mismatch → refuse the whole image
    }
    let rel = match resolve_rel(st, req_path) {
        Some(r) => r,
        None => return Err(404), // unknown holospace host
    };
    let full = st.root.join(&rel);
    match st.closure.get(&rel) {
        Some(pin) => {
            // Warm: serve immutable verified bytes by the canonical κ (no disk, no re-hash). L3 page-fault cache.
            let key = pin.key().to_string();
            if let Ok(cache) = st.cache.lock() {
                if let Some(bytes) = cache.get(&key) {
                    return Ok(((**bytes).clone(), content_type(&rel)));
                }
            }
            // Cold: read + re-derive every present axis (Law L5 / SEC-6); refuse a mismatch.
            if !full.starts_with(&st.root) || !full.is_file() {
                return Err(404);
            }
            let bytes = std::fs::read(&full).map_err(|_| 404u16)?;
            // CANONICAL κ axis FIRST: blake3 (the substrate's kappo) is the trust check.
            if let Some(b3) = &pin.blake3 {
                if &blake3_hex(&bytes) != b3 {
                    return Err(403); // canonical κ (blake3) mismatch → refuse
                }
            }
            // sha256 BRIDGE alias also re-derives when present (legacy/interop) — refuse a mismatch.
            if let Some(sha) = &pin.sha256 {
                if &sha256_hex(&bytes) != sha {
                    return Err(403); // bridge-alias (sha256) mismatch → refuse
                }
            }
            if let Ok(mut cache) = st.cache.lock() {
                cache.insert(key, Arc::new(bytes.clone()));  // only verified bytes cached
            }
            Ok((bytes, content_type(&rel)))
        }
        None => {
            // Unpinned in a sealed image = post-seal tamper → refuse, except the bootstrap files
            // (fetched by name, outside the closure by design). Bootstrap bytes are never cached.
            if !is_bootstrap(&rel) {
                return Err(403);
            }
            if !full.starts_with(&st.root) || !full.is_file() {
                return Err(404);
            }
            let bytes = std::fs::read(&full).map_err(|_| 404u16)?;
            Ok((bytes, content_type(&rel)))
        }
    }
}

/// Warm the verified-bytes cache for the BOOT-relevant (small) pinned files IN PARALLEL across cores, so a
/// page's first load sees WARM serves (network-free, no re-hash) instead of slow SEQUENTIAL cold ones. The
/// cold serve path reads+verifies each file one at a time (disk open + blake3 + AV scan ≈ 16 MB/s on a real
/// dist → ~8s for the boot set); warming the same set with rayon is ~18× faster and runs OFF the boot-
/// critical path (a background thread at HotStore open), so by the time the page requests its modules they
/// are already verified+resident. Big vendored blobs (≥ `max_bytes`) are skipped — they are not on the
/// first-paint path and heal/serve on demand. Idempotent (a warmed κ is a cache hit). Returns (warmed, ms).
pub fn warm_boot_set(st: &KStore, max_bytes: u64) -> (usize, u128) {
    use rayon::prelude::*;
    use std::time::Instant;
    let t = Instant::now();
    // collect the small served files (the boot-critical set); a cheap metadata stat skips the heavy blobs.
    let small: Vec<String> = st
        .closure
        .keys()
        .filter(|rel| {
            let full = st.root.join(rel.as_str());
            std::fs::metadata(&full).map(|m| m.is_file() && m.len() < max_bytes).unwrap_or(false)
        })
        .cloned()
        .collect();
    // resolve each in parallel — re-derives + caches the verified bytes (the same path serving uses).
    let warmed: usize = small
        .par_iter()
        .map(|rel| if resolve(st, &format!("/os/{rel}")).is_ok() { 1 } else { 0 })
        .sum();
    (warmed, t.elapsed().as_millis())
}

// ── witness: the verification core refuses tamper on EITHER axis and refuses unpinned bytes ────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // P0 cross-impl parity: the JS kappo (holo-blake3.mjs) emits holo-blake3-parity-vectors.json; this
    // test re-derives every vector with the SAME `blake3` crate the native verifier and CEF host use
    // (blake3_hex). Equality here closes JS == Rust == CEF DIRECTLY — the bedrock the κ-promotion stands
    // on. Skips cleanly if the vectors file is absent (run the JS witness first to regenerate it).
    #[test]
    fn parity_vectors_match_js() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../holo-os/system/tools/holo-blake3-parity-vectors.json");
        let Ok(bytes) = fs::read(&path) else {
            eprintln!("parity vectors not found at {} — run `node tools/holo-blake3-parity-witness.mjs`", path.display());
            return;
        };
        let doc: serde_json::Value = serde_json::from_slice(&bytes).expect("parity vectors must parse");
        let vectors = doc.get("vectors").and_then(|v| v.as_array()).expect("vectors array");
        assert!(!vectors.is_empty(), "parity vectors must be non-empty");
        for v in vectors {
            let len = v.get("len").and_then(|x| x.as_u64()).expect("len") as usize;
            let want = v.get("blake3").and_then(|x| x.as_str()).expect("blake3 hex");
            let input: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();   // SAME pattern as the JS mk(L)
            assert_eq!(blake3_hex(&input), want, "Rust blake3 != JS kappo at len {len} — cross-impl divergence");
        }
    }

    // a tiny sealed image in its own temp dir: a.js (pinned, both axes), b.js (unpinned),
    // holo-fhs-sw.js (bootstrap), os-closure.json (manifest, unpinned by design).
    fn seal_image(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("kappa-route-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let good = b"console.log('pinned');\n";
        fs::write(root.join("a.js"), good).unwrap();
        fs::write(root.join("b.js"), b"unpinned\n").unwrap();
        fs::write(root.join("holo-fhs-sw.js"), b"// worker\n").unwrap();
        let closure = serde_json::json!({
            "closure": { "a.js": {
                "kappa": format!("did:holo:sha256:{}", sha256_hex(good)),
                "blake3": format!("did:holo:blake3:{}", blake3_hex(good)),
            }}
        });
        fs::write(root.join("os-closure.json"), serde_json::to_vec(&closure).unwrap()).unwrap();
        root
    }

    // P3: the CANONICAL axis is blake3. An image sealed with ONLY a blake3 κ (no sha alias) verifies by it.
    #[test]
    fn canonical_blake3_only_pin_verifies() {
        let root = std::env::temp_dir().join(format!("kr-b3only-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let good = b"canonical only\n";
        fs::write(root.join("a.js"), good).unwrap();
        let closure = serde_json::json!({ "closure": { "a.js": {
            "blake3": format!("did:holo:blake3:{}", blake3_hex(good)),   // canonical κ, NO sha256 alias
        }}});
        fs::write(root.join("os-closure.json"), serde_json::to_vec(&closure).unwrap()).unwrap();
        let st = load_store(root.clone(), None);
        assert_eq!(resolve(&st, "/os/a.js").unwrap().0, good);           // verifies by the canonical axis alone
        // and a tamper on a blake3-only pin is refused on the canonical axis
        fs::write(root.join("a.js"), b"tampered\n").unwrap();
        let st2 = load_store(root, None);
        assert_eq!(resolve(&st2, "/os/a.js"), Err(403));
    }

    // P3: a legacy pre-cutover pin carrying ONLY the sha256 bridge alias still resolves (additive cutover).
    #[test]
    fn legacy_sha_only_pin_still_resolves() {
        let root = std::env::temp_dir().join(format!("kr-shaonly-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let good = b"legacy alias\n";
        fs::write(root.join("a.js"), good).unwrap();
        let closure = serde_json::json!({ "closure": { "a.js": {
            "kappa": format!("did:holo:sha256:{}", sha256_hex(good)),    // sha bridge alias only (pre-cutover)
        }}});
        fs::write(root.join("os-closure.json"), serde_json::to_vec(&closure).unwrap()).unwrap();
        let st = load_store(root, None);
        assert_eq!(resolve(&st, "/os/a.js").unwrap().0, good);
    }

    #[test]
    fn pinned_ok_both_axes() {
        let st = load_store(seal_image("ok"), None);
        let (bytes, _mime) = resolve(&st, "/os/a.js").expect("pinned file must resolve");
        assert_eq!(bytes, b"console.log('pinned');\n");
    }

    #[test]
    fn sha256_tamper_refused() {
        let root = seal_image("sha");
        fs::write(root.join("a.js"), b"tampered\n").unwrap(); // bytes no longer match the pin
        let st = load_store(root, None);
        assert_eq!(resolve(&st, "/os/a.js"), Err(403));
    }

    #[test]
    fn blake3_axis_enforced() {
        // a CORRECT sha256 pin but a WRONG blake3 σ-axis must still be refused.
        let root = std::env::temp_dir().join(format!("kappa-route-test-b3-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let good = b"sigma-axis\n";
        fs::write(root.join("a.js"), good).unwrap();
        let closure = serde_json::json!({
            "closure": { "a.js": {
                "kappa": format!("did:holo:sha256:{}", sha256_hex(good)),
                "blake3": "did:holo:blake3:0000000000000000000000000000000000000000000000000000000000000000",
            }}
        });
        fs::write(root.join("os-closure.json"), serde_json::to_vec(&closure).unwrap()).unwrap();
        let st = load_store(root, None);
        assert_eq!(resolve(&st, "/os/a.js"), Err(403));
    }

    #[test]
    fn unpinned_refused() {
        let st = load_store(seal_image("unpinned"), None);
        assert_eq!(resolve(&st, "/os/b.js"), Err(403)); // present on disk, absent from closure → refuse
    }

    #[test]
    fn bootstrap_exempt() {
        let st = load_store(seal_image("boot"), None);
        assert!(resolve(&st, "/os/holo-fhs-sw.js").is_ok());
        assert!(resolve(&st, "/os/os-closure.json").is_ok());
    }

    #[test]
    fn per_kappa_origin_resolves_app() {
        // holo://<κ>/ → that app's index, served under the κ's own origin (isolation), κ-verified.
        let root = std::env::temp_dir().join(format!("kr-app-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("apps/amp")).unwrap();
        let body = b"<!doctype html><title>Amp</title>\n";
        fs::write(root.join("apps/amp/index.html"), body).unwrap();
        let kappa = "bb5fde48d9dc00c97ba68c42088538d660c2a0509d60210a934eb4a4ab1d0c36";
        fs::write(root.join("apps/index.jsonld"), serde_json::to_vec(&serde_json::json!({
            "dcat:dataset": [{ "@id": format!("did:holo:sha256:{}", kappa),
                               "dcat:landingPage": "apps/amp/index.html", "schema:name": "Holo Amp" }]
        })).unwrap()).unwrap();
        let closure = serde_json::json!({ "closure": { "apps/amp/index.html": {
            "kappa": format!("did:holo:sha256:{}", sha256_hex(body)),
            "blake3": format!("did:holo:blake3:{}", blake3_hex(body)),
        }}});
        fs::write(root.join("os-closure.json"), serde_json::to_vec(&closure).unwrap()).unwrap();
        let st = load_store(root, None);
        // holo://<κ>/  → apps/amp/index.html
        let (bytes, _m) = resolve(&st, &format!("/{}/", kappa)).expect("app root must resolve by κ");
        assert_eq!(bytes, body);
        // an unknown κ host → 404
        assert_eq!(resolve(&st, "/deadbeef/"), Err(404));
    }

    #[test]
    fn content_address_route_fetches_by_kappa() {
        // holo://<host>/.holo/sha256/<hex> → the object with that κ (canonical κ-fetch, any origin).
        let st = load_store(seal_image("cax"), None);
        let good = b"console.log('pinned');\n";
        let sha = sha256_hex(good);
        let (bytes, _m) = resolve(&st, &format!("/os/.holo/sha256/{}", sha)).expect("fetch by κ");
        assert_eq!(bytes, good);
        // host-agnostic: same κ-fetch from any origin host
        assert!(resolve(&st, &format!("/somehost/.holo/sha256/{}", sha)).is_ok());
        // unknown κ → 404
        assert_eq!(resolve(&st, &format!("/os/.holo/sha256/{}", "0".repeat(64))), Err(404));
    }

    #[test]
    fn warm_cache_serves_verified_bytes_after_disk_tamper() {
        // L3: once a κ is verified and cached, its bytes are the content. A later on-disk tamper
        // cannot affect a warm hit (the tampered bytes are simply never read again).
        let root = seal_image("warm");
        let st = load_store(root.clone(), None);
        let cold = resolve(&st, "/os/a.js").expect("cold verify").0;  // verifies + caches by κ
        std::fs::write(root.join("a.js"), b"tampered-after-cache\n").unwrap();
        let warm = resolve(&st, "/os/a.js").expect("warm hit").0;     // served from κ-cache, not disk
        assert_eq!(cold, warm);
        assert_eq!(warm, b"console.log('pinned');\n");
    }

    #[test]
    fn closure_anchor_match_serves() {
        // the baked trust root matches the on-disk manifest → the image is admitted (legacy sha axis).
        let root = seal_image("anchor-ok");
        let anchor = sha256_hex(&std::fs::read(root.join("os-closure.json")).unwrap());
        let st = load_store(root, Some(anchor));
        assert!(resolve(&st, "/os/a.js").is_ok());
    }

    #[test]
    fn warm_boot_set_warms_small_files_in_parallel() {
        // a sealed image with several small files + one big one; warming caches the small set (the boot
        // path) and skips the big blob. After warming, the cache holds the small files (warm serves).
        let root = std::env::temp_dir().join(format!("kr-warm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let mut closure = serde_json::Map::new();
        for i in 0..12 {
            let body = format!("export const m{i} = {i};\n").repeat(3);
            let name = format!("m{i}.mjs");
            fs::write(root.join(&name), &body).unwrap();
            closure.insert(name, serde_json::json!({ "blake3": format!("did:holo:blake3:{}", blake3_hex(body.as_bytes())) }));
        }
        let big = vec![7u8; 200_000];                          // > 64 KiB → must be SKIPPED by warming
        fs::write(root.join("big.bin"), &big).unwrap();
        closure.insert("big.bin".into(), serde_json::json!({ "blake3": format!("did:holo:blake3:{}", blake3_hex(&big)) }));
        fs::write(root.join("os-closure.json"), serde_json::to_vec(&serde_json::json!({ "closure": closure })).unwrap()).unwrap();

        let st = load_store(root.clone(), None);
        let (warmed, _ms) = warm_boot_set(&st, 65536);
        assert_eq!(warmed, 12, "the 12 small files warm; the 200KB blob is skipped");
        // the small files now serve (warm); the big one still serves on demand (just wasn't pre-warmed)
        assert!(resolve(&st, "/os/m0.mjs").is_ok());
        assert!(resolve(&st, "/os/big.bin").is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn closure_anchor_blake3_is_canonical() {
        // P4 — the CANONICAL trust root is blake3(os-closure.json). A blake3-baked anchor admits the image;
        // tampering the manifest matches NEITHER axis → the whole store poisons (fail-closed, never half-flip).
        let root = seal_image("anchor-b3");
        let manifest = std::fs::read(root.join("os-closure.json")).unwrap();
        let blake_anchor = blake3_hex(&manifest);
        let st = load_store(root.clone(), Some(blake_anchor.clone()));
        assert!(resolve(&st, "/os/a.js").is_ok(), "blake3 anchor must admit its own manifest");
        // a tampered manifest under the SAME (now-wrong) blake3 anchor → poisoned
        let mut tampered = manifest.clone();
        tampered.extend_from_slice(b"\n/* tamper */");
        std::fs::write(root.join("os-closure.json"), &tampered).unwrap();
        let st2 = load_store(root, Some(blake_anchor));
        assert_eq!(resolve(&st2, "/os/a.js"), Err(403), "tampered manifest matches neither axis → fail closed");
    }

    #[test]
    fn closure_anchor_mismatch_refuses_everything() {
        // a swapped/tampered manifest (anchor != baked) poisons the store: refuse the WHOLE image,
        // even files whose own pins are self-consistent, and even the manifest itself (G1/SEC-1).
        let root = seal_image("anchor-bad");
        let wrong = "0".repeat(64);
        let st = load_store(root, Some(wrong));
        assert_eq!(resolve(&st, "/os/a.js"), Err(403));
        assert_eq!(resolve(&st, "/os-closure.json"), Err(403));
        assert_eq!(resolve(&st, "/holo-fhs-sw.js"), Err(403));
    }
}
