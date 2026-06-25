// boot_timing.rs — measure the NATIVE serve cost of a cold OS boot, isolated from CEF/process/page time.
// Where does cold-boot wall-clock go on the verifier side? Two costs: (1) load_store — parse the 22k-pin
// flat closure + build the indexes + compute the anchor; (2) resolve — per served file, read + re-derive
// its blake3 κ (Law L5) on the FIRST serve (warm hits are free). This times both against the real dist so
// we optimize the actual bottleneck, not a guess.
//
//   cargo run --release -p kappa-route --example boot_timing -- <dist-dir>

use std::time::Instant;
use std::path::PathBuf;
use kappa_route::{load_store, resolve};

fn main() {
    let dist = PathBuf::from(std::env::args().nth(1).expect("usage: boot_timing <dist-dir>"));
    let manifest = std::fs::read(dist.join("os-closure.json")).expect("dist/os-closure.json");
    let anchor = blake3::hash(&manifest).to_hex().to_string();
    let manifest_mb = manifest.len() as f64 / 1e6;

    // ── 1 · load_store: parse the flat closure + build indexes + anchor check ──
    let t = Instant::now();
    let st = load_store(dist.clone(), Some(anchor.clone()));
    let load_ms = t.elapsed().as_secs_f64() * 1e3;
    let n = st.closure.len();
    println!("manifest        : {:.1} MB, {} pins", manifest_mb, n);
    println!("load_store      : {:.1} ms  (parse + index + anchor)", load_ms);

    // The BOOT-relevant set = the small served files (modules/html/css/json) a page actually pulls — NOT the
    // multi-MB vendored blobs. Filter to files < 64 KiB; that is what gates time-to-first-paint.
    let boot: Vec<String> = {
        let doc: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
        doc.get("closure").and_then(|c| c.as_object()).map(|m| m.iter()
            .filter(|(_, v)| v.get("bytes").and_then(|b| b.as_u64()).map_or(true, |b| b < 65536))
            .map(|(k, _)| k.clone()).collect()).unwrap_or_default()
    };
    println!("boot-relevant set (<64KiB): {} files\n", boot.len());

    // ── 2 · SEQUENTIAL cold (today's path): the page pulls boot files one by one, each read+verified ──
    let st2 = load_store(dist.clone(), Some(anchor.clone()));   // fresh store = cold cache
    let mut bytes = 0u64;
    let t = Instant::now();
    for k in &boot { if let Ok((b, _)) = resolve(&st2, &format!("/os/{k}")) { bytes += b.len() as u64; } }
    let seq_ms = t.elapsed().as_secs_f64() * 1e3;
    let mb = bytes as f64 / 1e6;
    println!("boot set SEQUENTIAL cold : {:.0} ms  ({:.1} MB, {:.0} MB/s) — the serve path today", seq_ms, mb, mb / (seq_ms / 1e3));

    // ── 3 · PARALLEL warm-at-open (the lever): rayon-resolve the boot set across cores at HotStore open ──
    let st3 = load_store(dist.clone(), Some(anchor.clone()));   // fresh store = cold cache
    let t = Instant::now();
    {
        use rayon::prelude::*;
        boot.par_iter().for_each(|k| { let _ = resolve(&st3, &format!("/os/{k}")); });
    }
    let par_ms = t.elapsed().as_secs_f64() * 1e3;
    println!("boot set PARALLEL warm   : {:.0} ms  ({:.1}x faster) — warm the boot set at open; page sees warm serves", par_ms, seq_ms / par_ms.max(0.001));

    // warm hit (steady state)
    let t = Instant::now();
    for k in &boot { let _ = resolve(&st3, &format!("/os/{k}")); }
    let warm_ms = t.elapsed().as_secs_f64() * 1e3;
    println!("boot set WARM hit        : {:.0} ms  — once warm, the whole boot set serves network-free", warm_ms);

    println!("\nverdict: native cold-boot serve = load_store {:.0}ms + boot-set verify {:.0}ms (sequential).", load_ms, seq_ms);
    println!("lever 1: warm the boot set in PARALLEL at HotStore open → {:.0}ms ({:.1}x), off the critical path.", par_ms, seq_ms / par_ms.max(0.001));
    println!("lever 2: load_store {:.0}ms is paid on every reopen — a real, separate target.", load_ms);
}
