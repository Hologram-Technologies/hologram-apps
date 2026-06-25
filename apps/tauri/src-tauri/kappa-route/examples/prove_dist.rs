// prove_dist.rs — native prove-boot of the BLAKE3-canonical verifier against the REAL production dist,
// without launching a browser window. This drives the EXACT code path the CEF host uses at runtime:
// kr_store_open → load_store(dist, blake3_anchor)  and  kr_resolve → resolve(...). It proves, on the live
// 22615-entry dist/os-closure.json:
//   • the store opens with the CANONICAL blake3 anchor (blake3(os-closure.json)) — NOT poisoned;
//   • a real pinned OS file resolves 200, re-derived on the blake3 axis (Law L5 / SEC-6);
//   • a bogus unpinned path is refused (fail-closed);
//   • a sha256-valued anchor ALSO opens (the atomic-safe fallback) — so the flip never half-breaks.
//
//   cargo run --release -p kappa-route --example prove_dist -- <path-to-dist>

use std::path::PathBuf;
use kappa_route::{load_store, resolve};

fn hex(bytes: &[u8], blake3: bool) -> String {
    if blake3 { blake3::hash(bytes).to_hex().to_string() }
    else { use sha2::{Digest, Sha256}; let mut h = Sha256::new(); h.update(bytes); h.finalize().iter().map(|b| format!("{:02x}", b)).collect() }
}

fn main() {
    let dist = PathBuf::from(std::env::args().nth(1).expect("usage: prove_dist <dist-dir>"));
    let manifest = std::fs::read(dist.join("os-closure.json")).expect("dist/os-closure.json");
    let blake_anchor = hex(&manifest, true);
    let sha_anchor = hex(&manifest, false);
    println!("dist            : {}", dist.display());
    println!("canonical anchor: blake3 {}", blake_anchor);

    let mut pass = 0u32; let mut fail = 0u32;
    let mut ok = |name: &str, cond: bool| { if cond { pass += 1; println!("PASS — {name}"); } else { fail += 1; println!("FAIL — {name}"); } };

    // 1 · open with the CANONICAL blake3 anchor — the store must NOT be poisoned.
    let st = load_store(dist.clone(), Some(blake_anchor.clone()));
    let probe = resolve(&st, "/os/_shared/holo-blake3.mjs");
    ok("store opens on the blake3 anchor (not poisoned)", probe != Err(403) || matches!(probe, Ok(_)));

    // 2 · a real pinned OS file resolves 200, re-derived on the blake3 axis.
    let pinned = ["/os/_shared/holo-blake3.mjs", "/os/_shared/holo-kappa.mjs", "/os/login.html", "/os/shell.html"];
    let mut served_one = false;
    for p in pinned {
        if let Ok((bytes, _mime)) = resolve(&st, p) {
            // re-derive on the canonical axis ourselves and confirm it equals the manifest's blake3 pin tail.
            let want = json_blake3_pin(&manifest, p.trim_start_matches("/os/"));
            if let Some(w) = want { if hex(&bytes, true) == w { served_one = true; println!("       served+blake3-verified: {p} ({} bytes)", bytes.len()); break; } }
        }
    }
    ok("a real pinned OS file serves 200 + re-derives on the blake3 axis", served_one);

    // 3 · a bogus unpinned path is refused (fail-closed, SEC-1).
    ok("a bogus unpinned path is refused (fail-closed)", matches!(resolve(&st, "/os/__definitely_not_pinned__.js"), Err(_)));

    // 4 · the legacy sha256 anchor value ALSO opens the store (atomic-safe fallback during the flip).
    let st_sha = load_store(dist.clone(), Some(sha_anchor));
    ok("sha256 anchor value also admits the image (atomic-safe fallback)", resolve(&st_sha, "/os/_shared/holo-blake3.mjs").is_ok());

    // 5 · a WRONG anchor poisons the whole image (the trust root actually bites).
    let st_bad = load_store(dist, Some("0".repeat(64)));
    ok("a wrong anchor poisons the image (trust root fail-closed)", matches!(resolve(&st_bad, "/os/_shared/holo-blake3.mjs"), Err(403)));

    println!("\nprove_dist: {pass} passed, {fail} failed");
    std::process::exit(if fail == 0 { 0 } else { 1 });
}

// pull the blake3 pin tail for a serve-rel path out of the manifest (top-level field or alsoKnownAs).
fn json_blake3_pin(manifest: &[u8], rel: &str) -> Option<String> {
    let doc: serde_json::Value = serde_json::from_slice(manifest).ok()?;
    let v = doc.get("closure")?.get(rel)?;
    let s = v.get("blake3").and_then(|x| x.as_str())
        .or_else(|| v.get("alsoKnownAs").and_then(|a| a.as_array()).and_then(|arr| arr.iter().filter_map(|x| x.as_str()).find(|s| s.contains("blake3"))))?;
    Some(s.rsplit(':').next()?.to_ascii_lowercase())
}
