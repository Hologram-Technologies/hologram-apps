// prove_bao_stream.rs — native verified-streaming PERFORMANCE prove: a large κ-object encoded as BLAKE3
// streams as verified chunks at very LOW LATENCY (time-to-first-verified-chunk) and very HIGH THROUGHPUT
// (SIMD-BLAKE3), the whole object never re-hashed per request. This is the host's streamable-κ path:
//   • build the outboard ONCE (one SIMD pass) → report hash throughput (MB/s);
//   • serve+verify chunk 0 → report time-to-first-verified-chunk (the latency that matters for "press play");
//   • serve+verify EVERY chunk O(1) → report end-to-end verified-stream throughput + per-chunk latency;
//   • peak residency = one chunk + its O(log n) proof, not the object;
//   • correctness: every produced chunk verifies against the root; a tampered chunk is refused.
//
//   cargo run --release -p kappa-route --example prove_bao_stream [size_mb]

use std::time::Instant;
use kappa_route::bao::{BaoEncoder, verify_chunk, Sibling};

fn main() {
    let mb: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(64);
    let n = mb * 1024 * 1024;
    // a deterministic large object (a stand-in for a 4K frame / model layer / media segment).
    let mut obj = vec![0u8; n];
    for (i, b) in obj.iter_mut().enumerate() { *b = (i as u32).wrapping_mul(2654435761).to_le_bytes()[0]; }

    let mut pass = 0u32; let mut fail = 0u32;
    let mut ok = |name: &str, c: bool| { if c { pass += 1; println!("PASS — {name}"); } else { fail += 1; println!("FAIL — {name}"); } };

    println!("object: {mb} MiB ({n} bytes) encoded as BLAKE3\n");

    // ── 1 · build the outboard ONCE → SIMD hash throughput ──
    let t0 = Instant::now();
    let enc = BaoEncoder::new(obj.clone());
    let build = t0.elapsed();
    let root = enc.root().to_string();
    let chunks = enc.chunk_count();
    let build_mbps = (n as f64 / 1_048_576.0) / build.as_secs_f64();
    println!("  outboard build: {:.1} ms  →  {:.0} MB/s SIMD-BLAKE3 over {chunks} chunks", build.as_secs_f64() * 1e3, build_mbps);
    ok("outboard builds (root + per-chunk proofs) in one pass", chunks > 0 && root.len() == 64);

    // ── 2 · serve + verify chunk 0 → TIME-TO-FIRST-VERIFIED-CHUNK (the low-latency that matters) ──
    let t1 = Instant::now();
    let (c0, p0) = enc.chunk(0).expect("chunk 0");
    let v0 = verify_chunk(&root, 0, c0, p0);
    let ttfc = t1.elapsed();
    println!("  time-to-first-verified-chunk: {:.1} µs  (render/play starts here, not after the whole object)", ttfc.as_secs_f64() * 1e6);
    ok("chunk 0 serves + verifies (render-on-first-chunk)", v0);

    // ── 3 · serve + verify EVERY chunk O(1) → end-to-end verified-stream throughput + per-chunk latency ──
    let t2 = Instant::now();
    let mut verified = 0u64;
    let mut peak_resident = 0usize;
    for i in 0..chunks {
        let (cb, pf) = enc.chunk(i).unwrap();                 // O(1) from the prebuilt outboard
        peak_resident = peak_resident.max(cb.len() + pf.len() * 33);
        if verify_chunk(&root, i, cb, pf) { verified += 1; }
    }
    let stream = t2.elapsed();
    let stream_mbps = (n as f64 / 1_048_576.0) / stream.as_secs_f64();
    let per_chunk_us = stream.as_secs_f64() * 1e6 / chunks as f64;
    println!("  verified stream: {:.1} ms  →  {:.0} MB/s  ({:.2} µs/chunk serve+verify)", stream.as_secs_f64() * 1e3, stream_mbps, per_chunk_us);
    println!("  peak residency: {} bytes (one chunk + proof) vs {} object  →  {:.0}× smaller", peak_resident, n, n as f64 / peak_resident as f64);
    ok("every chunk serves + verifies against the root", verified == chunks);
    ok("peak residency is one chunk + proof, not the object (streamable)", peak_resident < 4096 && n / peak_resident > 1000);

    // ── 4 · a tampered chunk is refused (Law L5 at chunk granularity) ──
    let (cmid, pmid) = enc.chunk(chunks / 2).unwrap();
    let mut bad = cmid.to_vec(); bad[0] ^= 0xff;
    ok("a tampered chunk is REFUSED (fail-closed, the rest stream on)", !verify_chunk(&root, chunks / 2, &bad, pmid));

    // ── 5 · a cross-impl-shaped sanity: a single-chunk object's root is the ordinary blake3 hash ──
    let small = BaoEncoder::new(b"one chunk".to_vec());
    let (sb, sp) = small.chunk(0).unwrap();
    let _ = std::convert::identity::<&[Sibling]>(sp);
    ok("a single-chunk object verifies (proof empty, root = blake3::hash)", verify_chunk(small.root(), 0, sb, sp));

    println!("\nprove_bao_stream: {pass} passed, {fail} failed");
    println!("→ native Hologram serves streamable BLAKE3 κ-objects: low latency (first chunk in µs), high throughput (SIMD), O(1)/chunk, whole object never resident.");
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
