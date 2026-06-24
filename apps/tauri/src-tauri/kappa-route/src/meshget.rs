// meshget.rs — the host's lean bridge to the mesh sidecar (P3b).
//
// On a shared-cache miss for a κ a peer gossiped, the host asks its LOCAL gateway (the holo-mesh-node
// sidecar) to fetch that κ from a remote peer over BareNetSync. The gateway verifies (re-derivation,
// Law L5) and persists the blob into HOLO_SHARED_DIR, then replies `OK <len>`; the host re-reads
// kr_shared_get and serves it (X-Holo-Source: kappa-mesh). If there is no gateway, no peer holds the κ,
// or it times out, the gateway answers `MISS` (or the connect fails) → 0 → the host falls through to the
// ORIGIN floor (no regression, no hang — the seamless contract).
//
// This is std::net ONLY: the shipping verifier crate stays lean (no hologram-net-bare / tokio). All the
// content-network machinery lives in the sidecar process, sharing the host's HOLO_SHARED_DIR.

use std::ffi::{c_char, CStr};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Ask the local mesh gateway to fetch `kappa` from a peer. Returns 1 if the gateway fetched + persisted
/// it (the host should re-read kr_shared_get), else 0. Gateway address from `HOLO_MESH_GATEWAY`
/// (default `127.0.0.1:9802`). Bounded timeouts so a page load never hangs on the mesh.
///
/// # Safety: `kappa` must be a NUL-terminated C string (or NULL).
#[no_mangle]
pub unsafe extern "C" fn kr_mesh_get(kappa: *const c_char) -> u8 {
    if kappa.is_null() {
        return 0;
    }
    let raw = match CStr::from_ptr(kappa).to_str() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let hex = raw.strip_prefix("did:holo:sha256:").unwrap_or(raw);
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return 0;
    }
    let addr = std::env::var("HOLO_MESH_GATEWAY").unwrap_or_else(|_| "127.0.0.1:9802".to_string());
    mesh_get(&addr, hex) as u8
}

/// Connect to the gateway, send `GET <hex>\n`, return true iff it replies `OK …`. Pure std::net.
fn mesh_get(addr: &str, hex: &str) -> bool {
    let sa: SocketAddr = match addr.parse() {
        Ok(s) => s,
        Err(_) => return false,
    };
    let mut s = match TcpStream::connect_timeout(&sa, Duration::from_millis(400)) {
        Ok(s) => s,
        Err(_) => return false, // no gateway → origin floor
    };
    s.set_read_timeout(Some(Duration::from_secs(3))).ok();
    s.set_write_timeout(Some(Duration::from_millis(500))).ok();
    if s.write_all(format!("GET {hex}\n").as_bytes()).is_err() {
        return false;
    }
    s.flush().ok();
    let mut resp = String::new();
    if BufReader::new(&s).read_line(&mut resp).is_err() {
        return false;
    }
    resp.starts_with("OK")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn mesh_get_ok_then_miss_then_no_gateway() {
        // A mock gateway on an ephemeral port: first GET → OK, second GET → MISS.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let h = thread::spawn(move || {
            for (i, conn) in listener.incoming().take(2).enumerate() {
                let mut c = conn.unwrap();
                let mut buf = [0u8; 128];
                let n = c.read(&mut buf).unwrap();
                assert!(std::str::from_utf8(&buf[..n]).unwrap().starts_with("GET "));
                c.write_all(if i == 0 { b"OK 42\n" } else { b"MISS\n" }).unwrap();
            }
        });
        let hex = "aa".repeat(32);
        assert!(mesh_get(&addr, &hex), "OK reply → fetched");
        assert!(!mesh_get(&addr, &hex), "MISS reply → not fetched");
        h.join().unwrap();
        // No gateway listening → false (origin floor), never a hang.
        assert!(!mesh_get("127.0.0.1:1", &hex));
        // Malformed addr → false.
        assert!(!mesh_get("not-an-addr", &hex));
    }
}
