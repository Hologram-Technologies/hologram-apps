// webcache.rs — the OPEN-WEB κ-cache. Projects content-addressing in front of the network for ALL
// third-party web the native browser renders (NOT the sealed holo:// image — that is KStore, read-only).
//
// Twin of holo-webcache.mjs. Populated by what the browser fetches: bytes addressed by their κ (the
// SAME sha256 the verifier uses — Law L5), deduped so identical bytes are stored once and served to
// EVERY later request on any site/page, O(1), from memory — no DNS, no TLS, no network. A read
// re-derives the κ and refuses a mismatch (fail-closed): the cache cannot lie, because κ = the content
// address. Cold-novel bytes still pay the network — that floor is physics; everything else is substrate-speed.
//
// Wiring (handler.cc): GetResourceHandler serves a HIT from here; GetResourceResponseFilter tees a MISS
// body in (compute κ, put). The C ABI for that lives in ffi.rs (kr_cache_*).

use std::collections::HashMap;

use crate::sha256_hex;

/// Constant-time-ish re-derivation check on the fast L5 axis: do `bytes` still hash (BLAKE3) to the
/// digest captured at insert? A tamper changes the bytes ⇒ mismatch ⇒ the caller refuses (fail-closed).
#[inline]
fn verify_b3(bytes: &[u8], expected: &[u8; 32]) -> bool {
    blake3::hash(bytes).as_bytes() == expected
}

/// Total physical RAM in bytes — so the resident working set scales to the device (Law: take full
/// advantage of the hardware, abstract the complexity). Windows via `GlobalMemoryStatusEx`; elsewhere a
/// safe 8 GiB assumption. Never panics; a probe failure falls back to the default.
fn detect_total_ram() -> u64 {
    const FALLBACK: u64 = 8 * 1024 * 1024 * 1024;
    #[cfg(windows)]
    {
        #[repr(C)]
        struct MemoryStatusEx {
            length: u32,
            memory_load: u32,
            total_phys: u64,
            avail_phys: u64,
            total_pagefile: u64,
            avail_pagefile: u64,
            total_virtual: u64,
            avail_virtual: u64,
            avail_extended_virtual: u64,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalMemoryStatusEx(buf: *mut MemoryStatusEx) -> i32;
        }
        let mut m: MemoryStatusEx = unsafe { core::mem::zeroed() };
        m.length = core::mem::size_of::<MemoryStatusEx>() as u32;
        let ok = unsafe { GlobalMemoryStatusEx(&mut m) };
        if ok != 0 && m.total_phys > 0 {
            return m.total_phys;
        }
        FALLBACK
    }
    #[cfg(not(windows))]
    {
        FALLBACK
    }
}

/// Device-adaptive resident cap (distinct κ): budget ~1/16 of physical RAM for the open-web working set,
/// assume a ~64 KiB average web object, clamp to [1024, 262144]. A weak 4 GiB laptop holds ~4k κ; a 64 GiB
/// workstation ~64k — the cache uses what the machine has, automatically, with no setting. Honest: this is
/// an entry-count heuristic over a variable object size (each entry self-bounds at the host's 16 MiB cap),
/// not a hard byte budget — a byte-budgeted eviction is the documented next step.
pub fn auto_cap() -> usize {
    let ram = detect_total_ram();
    let budget = ram / 16;
    let cap = (budget / (64 * 1024)) as usize;
    cap.clamp(1024, 262_144)
}

pub struct CacheEntry {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub immutable: bool,
    // L5 integrity digest, computed once at insert over the SAME bytes the sha256 dedup key (κ) was
    // derived from. The per-read verify re-derives THIS (BLAKE3) instead of sha256: a SIMD tree hash,
    // ~5x faster on real web bodies (measured: 4MB sha256 2.4ms > 1ms budget, blake3 0.5ms < budget),
    // so every serve stays sub-millisecond on any device. Same cryptographic strength, and blake3 is
    // already a first-class κ axis in the sealed closure — NOT a weaker check, just a faster-to-derive
    // one. A tamper still fails closed: mutated bytes cannot match this preimage (collision-resistant),
    // and since b3 and κ came from the same insert-time bytes, "blake3 matches" ⇒ "bytes match κ" too.
    pub b3: [u8; 32],
}

/// A bounded, content-addressed write-cache. `cap` bounds the number of distinct κ held (the resident
/// working set, not history — the low-memory guarantee). Eviction is naive (drop an arbitrary entry at
/// cap); a real deployment would LRU. Correctness does not depend on the policy.
#[derive(Default)]
pub struct WebCache {
    url_to_kappa: HashMap<String, String>, // GET url → κ (sha256 hex): which content this url last served
    store: HashMap<String, CacheEntry>,    // κ → deduped bytes (one entry per unique byte-sequence)
    byb3: HashMap<String, String>,         // blake3 hex (σ-axis) → κ: fetch by the fast axis (projection tiles)
    cap: usize,
    pub requests: u64,
    pub net_fetches: u64,
    pub hits: u64,
    pub refused_tamper: u64,
    pub bytes_over_wire: u64,
    pub bytes_served: u64,
}

impl WebCache {
    pub fn new(cap: usize) -> Self {
        WebCache { cap: cap.max(1), ..Default::default() }
    }

    /// Enumerate what's been browsed, WITHOUT bodies: (url, κ, mime, len) per held GET url. This is the seam
    /// the Living Window reads — it lists the cached objects so the composer can resolve them by url/κ; the
    /// bytes stay fetchable via the normal serve-hit path, never copied into the listing.
    pub fn entries(&self) -> Vec<(String, String, String, usize)> {
        let mut out = Vec::new();
        for (url, kappa) in &self.url_to_kappa {
            if let Some(e) = self.store.get(kappa) {
                out.push((url.clone(), kappa.clone(), e.mime.clone(), e.bytes.len()));
            }
        }
        out.sort();                                  // deterministic order (stable manifest)
        out
    }

    /// Fetch a held object BY its κ (bare hex, or `did:holo:sha256:<hex>` — the substrate form). Re-derives
    /// before serving (L5); a tamper is dropped and treated as a miss. This is the read the Living Window
    /// uses to pull a captured doc/asset's bytes by the κ the manifest gave it.
    pub fn get_by_kappa(&self, kappa: &str) -> Option<(Vec<u8>, String)> {
        let hex = kappa.rsplit(':').next().unwrap_or(kappa).to_ascii_lowercase();
        let e = self.store.get(&hex)?;
        if !verify_b3(&e.bytes, &e.b3) { return None; }   // L5: never serve a tampered entry (fast axis)
        Some((e.bytes.clone(), e.mime.clone()))
    }

    /// Fetch a held object BY its BLAKE3 σ-axis hex (the fast axis the projection producer addresses tiles on).
    /// Re-derives BLAKE3 before serving (L5); a tamper is a miss. The lens fetches holo://os/cache/blake3/<hex>.
    pub fn get_by_b3(&self, b3hex: &str) -> Option<(Vec<u8>, String)> {
        let hex = b3hex.rsplit(':').next().unwrap_or(b3hex).to_ascii_lowercase();
        let k = self.byb3.get(&hex)?;
        let e = self.store.get(k)?;
        if !verify_b3(&e.bytes, &e.b3) { return None; }   // L5: re-derive the σ-axis, never serve tampered
        Some((e.bytes.clone(), e.mime.clone()))
    }

    /// The content address — byte-identical to kr_sha256_hex and the substrate κ.
    pub fn kappa_of(bytes: &[u8]) -> String {
        sha256_hex(bytes)
    }

    /// Serve from κ if held. Re-derives the κ first (L5); a tampered entry is dropped and treated as a
    /// miss (never served). `None` ⇒ caller performs the network fetch, then `put()`s the bytes.
    pub fn get(&mut self, url: &str) -> Option<(Vec<u8>, String)> {
        self.requests += 1;
        let k = self.url_to_kappa.get(url)?.clone();
        let tampered = match self.store.get(&k) {
            Some(e) if verify_b3(&e.bytes, &e.b3) => false, // L5 re-derive on the fast (BLAKE3) axis
            Some(_) => true,
            None => return None,
        };
        if tampered {
            self.store.remove(&k);
            self.refused_tamper += 1;
            return None;
        }
        let e = self.store.get(&k).unwrap();
        self.hits += 1;
        self.bytes_served += e.bytes.len() as u64;
        Some((e.bytes.clone(), e.mime.clone()))
    }

    /// Install fetched bytes (a cold miss), deduping by κ. Returns the κ.
    pub fn put(&mut self, url: &str, bytes: Vec<u8>, mime: &str, immutable: bool) -> String {
        let k = sha256_hex(&bytes);
        self.net_fetches += 1;
        self.bytes_over_wire += bytes.len() as u64;
        self.bytes_served += bytes.len() as u64;
        if !self.store.contains_key(&k) {
            if self.store.len() >= self.cap {
                if let Some(victim) = self.store.keys().next().cloned() {
                    self.store.remove(&victim);
                }
            }
            let b3 = *blake3::hash(&bytes).as_bytes();   // L5 integrity digest, derived from the same bytes as κ
            let b3hex: String = b3.iter().map(|b| format!("{:02x}", b)).collect();
            self.byb3.insert(b3hex, k.clone());          // index by the σ-axis so tiles fetch by blake3
            self.store.insert(k.clone(), CacheEntry { bytes, mime: mime.to_string(), immutable, b3 });
        }
        self.url_to_kappa.insert(url.to_string(), k.clone());
        k
    }

    pub fn unique_kappa(&self) -> usize {
        self.store.len()
    }
    pub fn wire_saved(&self) -> u64 {
        self.bytes_served.saturating_sub(self.bytes_over_wire)
    }
}

// ── witness: the open-web κ-cache thesis holds — dedup, O(1) repeat, wire saved, L5 fail-closed ──────
#[cfg(test)]
mod tests {
    use super::*;

    // A tiny realistic session: shared assets recur across pages/sites; page A is revisited (back/fwd).
    // The network fetchFn returns fixed bytes per url; the cache must collapse identical bytes to one κ.
    fn body(tag: &str, n: usize) -> Vec<u8> {
        tag.bytes().cycle().take(n).collect()
    }

    #[test]
    fn open_web_kappa_cache_thesis() {
        // url → its real (here, fixed) bytes. jquery/bootstrap/font shared across sites.
        let net: HashMap<&str, Vec<u8>> = HashMap::from([
            ("https://cdn/jquery.js", body("jq", 8000)),
            ("https://cdn/bootstrap.css", body("bs", 20000)),
            ("https://fonts/inter.css", body("ft", 300)),
            ("https://siteA/", body("a", 500)),
            ("https://cdn/react.js", body("re", 10000)),
        ]);
        let mut pulls: HashMap<String, u32> = HashMap::new();
        let mut c = WebCache::new(1024);

        let mut serve = |c: &mut WebCache, url: &str| {
            if let Some((b, _m)) = c.get(url) {
                return b; // κ-hit, zero network
            }
            *pulls.entry(url.to_string()).or_insert(0) += 1; // cold miss → the only network paid
            let b = net.get(url).unwrap().clone();
            c.put(url, b.clone(), "application/octet-stream", true);
            b
        };

        // siteA/home, siteA/about (same assets), siteB/app (shares bootstrap+font), revisit siteA/home.
        let session: Vec<&str> = vec![
            "https://siteA/", "https://cdn/jquery.js", "https://cdn/bootstrap.css", "https://fonts/inter.css",
            "https://siteA/", "https://cdn/jquery.js", "https://cdn/bootstrap.css", "https://fonts/inter.css",
            "https://cdn/react.js", "https://cdn/bootstrap.css", "https://fonts/inter.css",
            "https://siteA/", "https://cdn/jquery.js", "https://cdn/bootstrap.css", "https://fonts/inter.css",
        ];
        let logical = session.len() as u64;
        for url in &session {
            serve(&mut c, url);
        }

        // G1 — cross-context dedup: unique κ strictly fewer than logical requests.
        assert!(c.unique_kappa() < logical as usize, "dedup: {} κ < {} requests", c.unique_kappa(), logical);
        assert_eq!(c.unique_kappa(), 5, "exactly 5 distinct byte-sequences across the session");
        // G2 — O(1) repeat serve from κ, zero network.
        assert!(c.hits > 0, "repeat serves from κ");
        assert_eq!(c.hits, logical - c.net_fetches, "every non-cold request was a κ-hit");
        // G3 — every url pulled from network at most once.
        assert!(pulls.values().all(|&n| n == 1), "no byte refetched");
        assert!(c.wire_saved() > 0, "bytes over wire saved: {}", c.wire_saved());
        // G5 — cold-novel honesty: network fetches == unique κ.
        assert_eq!(c.net_fetches as usize, c.unique_kappa(), "novel bytes are network-bound");

        // G4 — L5 fail-closed: corrupt a stored entry, attempt to serve, must refuse (miss, not lie).
        let k = WebCache::kappa_of(net.get("https://cdn/jquery.js").unwrap());
        if let Some(e) = c.store.get_mut(&k) {
            e.bytes.push(b'!'); // tamper
        }
        let before = c.refused_tamper;
        let got = c.get("https://cdn/jquery.js"); // maps to the tampered κ
        assert!(got.is_none(), "tampered entry must NOT serve");
        assert_eq!(c.refused_tamper, before + 1, "tamper is counted and refused (L5)");

        eprintln!(
            "GREEN open-web κ-cache: {} requests, {} net, {} hits, {} κ, {}B wire-saved",
            c.requests, c.net_fetches, c.hits, c.unique_kappa(), c.wire_saved()
        );
    }

    // The fast L5 axis (BLAKE3) is a real cryptographic integrity check, not a weakening: it catches a
    // tamper on BOTH read paths (get / get_by_kappa), and a clean entry still serves byte-exact.
    #[test]
    fn blake3_l5_is_fail_closed_on_both_read_paths() {
        let mut c = WebCache::new(64);
        let url = "https://x/app.js";
        let good = body("ok", 4096);
        c.put(url, good.clone(), "text/javascript", true);
        let kappa = WebCache::kappa_of(&good); // the sha256 dedup identity, unchanged

        // clean entry serves byte-exact on both paths
        assert_eq!(c.get(url).unwrap().0, good, "url path serves the verified bytes");
        assert_eq!(
            c.get_by_kappa(&format!("did:holo:sha256:{kappa}")).unwrap().0,
            good,
            "κ path serves the verified bytes"
        );
        // the entry carries a non-trivial BLAKE3 integrity digest, and it equals blake3(bytes)
        let e = c.store.get(&kappa).unwrap();
        assert_eq!(e.b3, *blake3::hash(&good).as_bytes(), "b3 is derived from the bytes");

        // tamper the resident bytes → BLAKE3 mismatch → BOTH paths refuse (miss, never lie)
        c.store.get_mut(&kappa).unwrap().bytes.push(b'!');
        assert!(c.get(url).is_none(), "url path refuses the tampered entry (L5)");
        assert!(
            c.get_by_kappa(&format!("did:holo:sha256:{kappa}")).is_none(),
            "κ path refuses the tampered entry (L5)"
        );
    }

    // The resident cap scales to THIS device's RAM and stays in a sane range (no setting, no OOM).
    #[test]
    fn auto_cap_scales_to_device_ram() {
        let cap = auto_cap();
        assert!((1024..=262_144).contains(&cap), "auto cap in range: {cap}");
        eprintln!("auto_cap on this device = {cap} distinct κ (RAM-scaled resident working set)");
    }
}
