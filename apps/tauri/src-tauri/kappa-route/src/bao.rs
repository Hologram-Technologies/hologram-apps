// bao.rs — native verified-streaming: verify a single chunk of a κ-object against its SINGLE root κ
// (blake3) in O(log n) using its Merkle proof, WITHOUT holding the whole object. This is the native
// half of os/usr/lib/holo/holo-bao.mjs — same proof format ({side, chaining-value} siblings, bottom-up),
// so a slice produced/verified in the browser verifies here and vice versa (cross-impl, no new crypto:
// it reuses the `blake3` crate's hazmat tree primitives the rest of the verifier already hashes with).
//
// This is what lets the CEF host serve a VERIFIED RANGE of a large κ-object streamed from a peer/origin
// without re-deriving the whole object — the BLAKE3 dividend, natively. A bad chunk is refused (Law L5);
// the rest stream on.

use blake3::hazmat::{merge_subtrees_non_root, merge_subtrees_root, ChainingValue, HasherExt, Mode};
use blake3::Hasher;

const CHUNK_LEN: u64 = 1024;

/// One proof sibling: which side it sits on, and its 32-byte chaining value.
pub struct Sibling {
    pub left: bool, // true = this sibling is the LEFT child (matches holo-bao side "L")
    pub cv: ChainingValue,
}

/// Verify `chunk` is the chunk at `index` of the object whose root κ is `root_hex`, folding `proof`
/// (siblings bottom-up) to the root. Returns true iff it re-derives to `root_hex` (Law L5). A tampered
/// chunk, a wrong proof, or a wrong index fails — holding no bytes but this one chunk and its proof.
pub fn verify_chunk(root_hex: &str, index: u64, chunk: &[u8], proof: &[Sibling]) -> bool {
    let want = root_hex.to_ascii_lowercase();
    if proof.is_empty() {
        // a single chunk IS the whole object → its root is the ordinary root hash.
        return blake3::hash(chunk).to_hex().as_str() == want;
    }
    // the chunk's NON-root chaining value, with its position bound via the input offset (no reordering).
    let mut h = Hasher::new();
    h.set_input_offset(index * CHUNK_LEN);
    h.update(chunk);
    let mut cv: ChainingValue = h.finalize_non_root();
    for (i, s) in proof.iter().enumerate() {
        let (l, r) = if s.left { (&s.cv, &cv) } else { (&cv, &s.cv) };
        if i == proof.len() - 1 {
            // ROOT applied ONLY at the true top (a subtree CV can never pass as the root).
            return merge_subtrees_root(l, r, Mode::Hash).to_hex().as_str() == want;
        }
        cv = merge_subtrees_non_root(l, r, Mode::Hash);
    }
    false
}

// ── PRODUCER side: build proofs host-native, so the CEF host streams VERIFIED chunks of a large κ-object
//    (a 4K frame, a model layer, a media segment) at SIMD-BLAKE3 throughput — a consumer renders chunk 0
//    the instant it lands, the whole object never materialized on the wire. Mirrors holo-bao.mjs proofFor/
//    outboard exactly (same left-balanced split, same sibling order), so a proof built here verifies in the
//    browser/SW and vice versa (cross-impl: bao_outboard_parity). ────────────────────────────────────────

const CHUNK_USIZE: usize = CHUNK_LEN as usize;

/// Chaining value of the subtree covering `bytes[start..start+len)` whose first chunk index is `counter`
/// (non-root). Leaves bind their position via the input offset; parents merge children. SIMD under the hood.
fn subtree_cv(bytes: &[u8], start: usize, len: usize, counter: u64) -> ChainingValue {
    // FAST PATH (the streaming-verify win): an aligned, COMPLETE power-of-two subtree — a power-of-two
    // number of FULL chunks, left-aligned (counter a multiple of that count) — has its CV computed in ONE
    // SIMD pass (BLAKE3 hash_many over the contiguous span) instead of recursing to per-chunk Hasher calls.
    // This is the defining shape of the left-balanced tree's internal subtrees, so every internal node hits
    // it; only the right edge (incomplete chunks) recurses. Validated byte-identical to the recursive form
    // by the JS parity vectors (bao_slice_parity / bao_outboard_parity).
    let chunks = len / CHUNK_USIZE;
    if len > 0 && len % CHUNK_USIZE == 0 && chunks.is_power_of_two() && counter % (chunks as u64) == 0 {
        let mut h = Hasher::new();
        h.set_input_offset(counter * CHUNK_LEN);
        h.update(&bytes[start..start + len]);
        return h.finalize_non_root();
    }
    if len <= CHUNK_USIZE {
        let mut h = Hasher::new();
        h.set_input_offset(counter * CHUNK_LEN);
        h.update(&bytes[start..start + len]);
        return h.finalize_non_root();
    }
    let mut left = CHUNK_USIZE;
    while left * 2 < len { left *= 2; } // largest power-of-two chunk span < len (the left-balanced split)
    let left_chunks = (left as u64) / CHUNK_LEN;
    let l = subtree_cv(bytes, start, left, counter);
    let r = subtree_cv(bytes, start + left, len - left, counter + left_chunks);
    merge_subtrees_non_root(&l, &r, Mode::Hash)
}

fn build_proof(bytes: &[u8], start: usize, len: usize, counter: u64, target: u64, out: &mut Vec<Sibling>) {
    if len <= CHUNK_USIZE { return; }
    let mut left = CHUNK_USIZE;
    while left * 2 < len { left *= 2; }
    let left_chunks = (left as u64) / CHUNK_LEN;
    if target < counter + left_chunks {
        build_proof(bytes, start, left, counter, target, out);                 // target LEFT → sibling is the RIGHT subtree
        out.push(Sibling { left: false, cv: subtree_cv(bytes, start + left, len - left, counter + left_chunks) });
    } else {
        let lcv = subtree_cv(bytes, start, left, counter);                     // target RIGHT → sibling is the LEFT subtree
        build_proof(bytes, start + left, len - left, counter + left_chunks, target, out);
        out.push(Sibling { left: true, cv: lcv });
    }
}

/// Number of 1024-byte chunks in an object of `len` bytes (≥1).
pub fn chunk_count(len: usize) -> u64 { ((len as u64 + CHUNK_LEN - 1) / CHUNK_LEN).max(1) }

/// The Merkle proof for chunk `index` of `bytes` (sibling list, bottom-up) — pair it with the chunk's bytes
/// and a consumer verifies it against the root κ in O(log n). Empty for a single-chunk object.
pub fn proof_for(bytes: &[u8], index: u64) -> Vec<Sibling> {
    let mut out = Vec::new();
    build_proof(bytes, 0, bytes.len(), 0, index, &mut out);
    out
}

/// the non-root chaining value of chunk `index` (position bound via the input offset).
fn chunk_cv(bytes: &[u8], index: u64) -> ChainingValue {
    let start = index as usize * CHUNK_USIZE;
    let end = (start + CHUNK_USIZE).min(bytes.len());
    let mut h = Hasher::new();
    h.set_input_offset(index * CHUNK_LEN);
    h.update(&bytes[start..end]);
    h.finalize_non_root()
}

/// Assemble every chunk's proof in ONE traversal of the left-balanced tree: each chunk CV is computed once
/// (O(n) hashing) and each internal node once (O(n)), so the whole outboard is O(n log n), NOT O(n²). As the
/// recursion unwinds, the sibling subtree's CV is appended to every chunk it covers — bottom-up, byte-
/// identical to holo-bao's per-chunk proofFor (verified by bao_outboard_parity).
fn build_all(cvs: &[ChainingValue], lo: usize, hi: usize, proofs: &mut [Vec<Sibling>]) -> ChainingValue {
    if hi - lo == 1 { return cvs[lo]; }
    let count = hi - lo;
    let mut left = 1usize;
    while left * 2 < count { left *= 2; }                 // largest power-of-two < count chunks on the left
    let mid = lo + left;
    let lcv = build_all(cvs, lo, mid, proofs);            // deeper siblings pushed first (bottom-up) …
    let rcv = build_all(cvs, mid, hi, proofs);
    for p in proofs.iter_mut().take(mid).skip(lo) { p.push(Sibling { left: false, cv: rcv }); } // … then this level
    for p in proofs.iter_mut().take(hi).skip(mid) { p.push(Sibling { left: true, cv: lcv }); }
    merge_subtrees_non_root(&lcv, &rcv, Mode::Hash)
}

/// The outboard: the proof tree for every chunk, cacheable by the object's root κ, so the host serves a
/// verified slice without rebuilding the tree per request. (root_hex, proofs[index]). O(n log n) — built in
/// one pass: each chunk hashed once (SIMD), each internal node merged once.
pub fn outboard(bytes: &[u8]) -> (String, Vec<Vec<Sibling>>) {
    let n = chunk_count(bytes.len()) as usize;
    let mut proofs: Vec<Vec<Sibling>> = (0..n).map(|_| Vec::new()).collect();
    if n > 1 {
        let cvs: Vec<ChainingValue> = (0..n as u64).map(|i| chunk_cv(bytes, i)).collect();
        build_all(&cvs, 0, n, &mut proofs);
    }
    (blake3::hash(bytes).to_hex().to_string(), proofs)
}

/// A verified-streaming PRODUCER for one κ-object: builds the outboard ONCE (a single SIMD-BLAKE3 pass over
/// the tree), then serves any chunk + its proof in O(1) — the host's low-latency / high-throughput seam for
/// streaming a large κ-object (a consumer renders chunk 0 the instant it arrives; the whole object is never
/// re-hashed per request). Hold one per hot object, keyed by its root κ.
pub struct BaoEncoder {
    bytes: Vec<u8>,
    root: String,
    proofs: Vec<Vec<Sibling>>,
}

impl BaoEncoder {
    pub fn new(bytes: Vec<u8>) -> Self {
        let (root, proofs) = outboard(&bytes);
        BaoEncoder { bytes, root, proofs }
    }
    pub fn root(&self) -> &str { &self.root }
    pub fn chunk_count(&self) -> u64 { self.proofs.len() as u64 }
    pub fn len(&self) -> usize { self.bytes.len() }
    pub fn is_empty(&self) -> bool { self.bytes.is_empty() }
    /// chunk `index`'s bytes + its proof (borrowed from the prebuilt outboard), or None if out of range.
    pub fn chunk(&self, index: u64) -> Option<(&[u8], &[Sibling])> {
        let i = index as usize;
        if i >= self.proofs.len() { return None; }
        let start = i * CHUNK_USIZE;
        let end = (start + CHUNK_USIZE).min(self.bytes.len());
        Some((&self.bytes[start..end], &self.proofs[i]))
    }
}

/// Verify a BATCH of chunks against `root` IN PARALLEL across cores (rayon) — the bare-metal streaming-verify
/// path. Per-chunk verify is independent (each folds its own proof), so it parallelizes near-linearly toward
/// the multi-core BLAKE3 ceiling, lifting cold-stream throughput from the ~0.3 GB/s single-core rate to tens
/// of GB/s so a κ-stream is WIRE-bound, never verify-bound (the InfiniBand-class requirement). Returns the
/// index of the FIRST chunk that fails (Some(i)) or None if all verify. Fail-closed: one bad chunk is caught.
pub fn verify_chunks_par(root: &str, chunks: &[(u64, &[u8], &[Sibling])]) -> Option<u64> {
    use rayon::prelude::*;
    chunks
        .par_iter()
        .find_map_any(|&(index, bytes, proof)| if verify_chunk(root, index, bytes, proof) { None } else { Some(index) })
}

// ── SLICE verify (the throughput fix): verify a contiguous run of chunks as ONE subtree. The slice's bytes
//    are hashed in a SINGLE SIMD pass (BLAKE3 hash_many over the whole span) to its subtree CV, then a SHORT
//    upper proof folds that CV to the root — instead of hashing 1024 bytes at a time and folding O(log n)
//    siblings PER chunk. This is the difference between ~0.4 GB/s (per-chunk) and the raw BLAKE3 ceiling. A
//    slice is an aligned power-of-two run of chunks (the natural subtree decomposition); the rightmost run
//    may be a smaller aligned subtree. Same root, same security: a tampered byte anywhere in the slice fails.

/// The UPPER proof for an aligned subtree slice [start_chunk, start_chunk+nchunks): the siblings that fold the
/// slice's subtree root to the global root — the leftmost chunk's proof with its `log2(nchunks)` within-slice
/// siblings dropped. (`nchunks` must be a power of two; `start_chunk` a multiple of it.)
pub fn slice_proof(bytes: &[u8], start_chunk: u64, nchunks: u64) -> Vec<Sibling> {
    let skip = nchunks.trailing_zeros() as usize;            // log2(nchunks) within-subtree siblings
    proof_for(bytes, start_chunk).into_iter().skip(skip).collect()
}

/// Verify a contiguous SLICE (an aligned power-of-two subtree of chunks starting at `start_chunk`) against
/// `root_hex` in ONE SIMD pass + the short `upper` proof. Returns true iff it re-derives to the root (L5).
pub fn verify_slice(root_hex: &str, start_chunk: u64, slice: &[u8], upper: &[Sibling]) -> bool {
    let want = root_hex.to_ascii_lowercase();
    if upper.is_empty() {
        // the slice IS the whole object → its root is the ordinary root hash.
        return blake3::hash(slice).to_hex().as_str() == want;
    }
    let mut cv = subtree_cv(slice, 0, slice.len(), start_chunk);   // SIMD-fast subtree CV of the whole span
    for (i, s) in upper.iter().enumerate() {
        let (l, r) = if s.left { (&s.cv, &cv) } else { (&cv, &s.cv) };
        if i == upper.len() - 1 {
            return merge_subtrees_root(l, r, Mode::Hash).to_hex().as_str() == want; // ROOT only at the true top
        }
        cv = merge_subtrees_non_root(l, r, Mode::Hash);
    }
    false
}

/// Verify a batch of SLICES against `root` in parallel across cores — the streaming-verify fast path that
/// reaches toward the multi-core BLAKE3 ceiling (few coarse SIMD tasks, not millions of tiny ones). Returns
/// the start_chunk of the FIRST slice that fails, or None if all verify.
pub fn verify_slices_par(root: &str, slices: &[(u64, &[u8], &[Sibling])]) -> Option<u64> {
    use rayon::prelude::*;
    slices
        .par_iter()
        .find_map_any(|&(start, bytes, proof)| if verify_slice(root, start, bytes, proof) { None } else { Some(start) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cv_from_hex(s: &str) -> ChainingValue {
        let mut out = [0u8; 32];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
    fn bytes_from_hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect()
    }

    // S4 cross-impl parity: the JS verifier (holo-bao) emits holo-bao-parity-vectors.json; this re-verifies
    // every chunk's proof natively (the SAME `blake3` crate the host hashes with) and refuses a tampered one
    // — closing slice-verify JS == Rust == CEF. Skips cleanly if the fixture is absent (run the JS witness).
    #[test]
    fn bao_slice_parity() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../holo-os/system/tools/holo-bao-parity-vectors.json");
        let Ok(raw) = std::fs::read(&path) else {
            eprintln!("bao parity vectors not found at {} — run `node tools/holo-bao-parity-witness.mjs`", path.display());
            return;
        };
        let doc: serde_json::Value = serde_json::from_slice(&raw).expect("parse vectors");
        let objects = doc.get("objects").and_then(|o| o.as_array()).expect("objects");
        assert!(!objects.is_empty());
        let mut total_chunks = 0u32;
        for obj in objects {
            let root = obj.get("root").and_then(|x| x.as_str()).expect("root");
            let chunks = obj.get("chunks").and_then(|c| c.as_array()).expect("chunks");
            for ch in chunks {
                let index = ch.get("index").and_then(|x| x.as_u64()).unwrap();
                let bytes = bytes_from_hex(ch.get("bytes").and_then(|x| x.as_str()).unwrap());
                let proof: Vec<Sibling> = ch.get("proof").and_then(|p| p.as_array()).unwrap().iter().map(|s| Sibling {
                    left: s.get("side").and_then(|x| x.as_str()).unwrap() == "L",
                    cv: cv_from_hex(s.get("cv").and_then(|x| x.as_str()).unwrap()),
                }).collect();
                assert!(verify_chunk(root, index, &bytes, &proof), "Rust must verify chunk {index} (root {})", &root[..12]);
                // a tampered chunk must be refused on the same proof
                let mut bad = bytes.clone();
                bad[0] ^= 0xff;
                assert!(!verify_chunk(root, index, &bad, &proof), "Rust must REFUSE a tampered chunk {index}");
                // a wrong index must be refused (counter binds position)
                if !proof.is_empty() {
                    assert!(!verify_chunk(root, index + 1, &bytes, &proof), "Rust must REFUSE a reordered chunk {index}");
                }
                total_chunks += 1;
            }
        }
        eprintln!("bao_slice_parity: {total_chunks} chunks verified JS == Rust, tamper + reorder refused");
    }

    // SLICE verify soundness: a contiguous run verifies as one subtree against the root; a tampered byte at
    // ANY offset in the slice is refused; a wrong slice position is refused. Across power-of-two and ragged
    // objects and several slice sizes (so the right-edge / partial-last-chunk paths are exercised).
    #[test]
    fn slice_verify_sound() {
        for &n in &[1usize, 1024, 4096, 7000, 70000, 1 << 20, (1 << 20) + 555] {
            let obj: Vec<u8> = (0..n).map(|i| (i % 251) as u8).collect();
            let root = blake3::hash(&obj).to_hex().to_string();
            let total_chunks = chunk_count(n);
            for &slice_chunks in &[1u64, 4, 64, 1024] {
                if slice_chunks > total_chunks { continue; }
                let mut start = 0u64;
                while start < total_chunks {
                    let s = slice_chunks.min(total_chunks - start);
                    // only aligned power-of-two runs are single subtrees; align the run down to a power of two.
                    let run = 1u64 << (63 - (s).leading_zeros()).min(63 - (start | (1<<62)).trailing_zeros().min(62));
                    let run = run.min(s).max(1);
                    let a = start.trailing_zeros();                 // max power-of-two aligned at `start`
                    let run = run.min(1u64 << a.min(20));
                    let sb = start as usize * CHUNK_USIZE;
                    let se = ((start + run) as usize * CHUNK_USIZE).min(n);
                    let slice = &obj[sb..se];
                    let proof = slice_proof(&obj, start, run);
                    assert!(verify_slice(&root, start, slice, &proof), "slice [{start},+{run}) of {n} must verify");
                    // tamper at the slice's last byte
                    if !slice.is_empty() {
                        let mut bad = slice.to_vec(); *bad.last_mut().unwrap() ^= 0xff;
                        assert!(!verify_slice(&root, start, &bad, &proof), "tampered slice refused @{start}");
                    }
                    start += run;
                }
            }
        }
    }

    // Native PRODUCER parity: rebuild every object's proofs in Rust and assert they are BYTE-IDENTICAL to the
    // JS-built proofs (same root, same sibling sides + chaining values) — so a stream the host PRODUCES is
    // verified by any holo-bao consumer (browser/SW/peer), and vice versa. Closes build+verify JS == Rust.
    #[test]
    fn bao_outboard_parity() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../holo-os/system/tools/holo-bao-parity-vectors.json");
        let Ok(raw) = std::fs::read(&path) else { eprintln!("no bao vectors — run holo-bao-parity-witness.mjs"); return; };
        let doc: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        let mut chunks_checked = 0u32;
        for obj in doc["objects"].as_array().unwrap() {
            let len = obj["len"].as_u64().unwrap() as usize;
            let js_root = obj["root"].as_str().unwrap();
            // reconstruct the object bytes from its chunks (hex) to feed the Rust builder
            let mut bytes = Vec::with_capacity(len);
            for ch in obj["chunks"].as_array().unwrap() { bytes.extend(bytes_from_hex(ch["bytes"].as_str().unwrap())); }
            assert_eq!(bytes.len(), len);
            let (root, proofs) = outboard(&bytes);
            assert_eq!(root, js_root, "Rust-built root == JS root");
            for ch in obj["chunks"].as_array().unwrap() {
                let index = ch["index"].as_u64().unwrap();
                let rust = &proofs[index as usize];
                let js = ch["proof"].as_array().unwrap();
                assert_eq!(rust.len(), js.len(), "proof length matches @{index}");
                for (i, s) in js.iter().enumerate() {
                    assert_eq!(rust[i].left, s["side"].as_str().unwrap() == "L", "sibling side matches @{index}.{i}");
                    assert_eq!(rust[i].cv, cv_from_hex(s["cv"].as_str().unwrap()), "sibling CV byte-identical @{index}.{i}");
                }
                // and the Rust-built proof verifies (self-consistent producer↔verifier)
                let cbytes = bytes_from_hex(ch["bytes"].as_str().unwrap());
                assert!(verify_chunk(&root, index, &cbytes, rust), "Rust-built proof verifies @{index}");
                chunks_checked += 1;
            }
        }
        eprintln!("bao_outboard_parity: {chunks_checked} Rust-built proofs are byte-identical to JS + self-verify");
    }
}
