// meshsync.rs — a WIRE-COMPATIBLE κ content-network peer, backed by SharedCache.
//
// Phase 1 of native networking (ADR-native-networking.md). It proves our κ + store are a conformant
// peer on the canonical Hologram content network: the frame codec and κ-label are byte-identical to
// `hologram-net-bare::BareNetSync` (upstream rev 18f553d8), so a peer built on this exchanges `fetch`/
// `announce`/`discover` frames with a real BareNetSync / holowhat browser peer. The transport here is an
// in-process content-blind link (the loopback stand-in for a socket / WebRTC NIC); P2 swaps the carrier
// behind the same store + verbs.
//
//   wire:  u32 LE len | u8 kind | payload          (len = 1 + payload.len())
//   κ-label: 71 ASCII bytes "sha256:<64 hex>"       (our did:holo:sha256:<hex> is a prefix-swap)
//
// Verify-on-receipt (SPINE-4 / Law L5) happens at the RECEIVER: a fetched body is re-derived through the
// σ-axis and a mismatch is refused — a forging responder is rejected, an unheld κ resolves to nothing.
// The carrier is content-blind; the law lives in the peer. No central operator (Law L1).

use std::collections::{BTreeMap, BTreeSet};

use crate::sha256_hex;
use crate::sharedcache::SharedCache;

// Frame kinds — byte-identical to hologram-net-bare (append-only; never renumber — SPINE-5).
const KIND_FETCH_REQ: u8 = 0x01;
const KIND_FETCH_RES_OK: u8 = 0x02;
const KIND_FETCH_RES_404: u8 = 0x03;
const KIND_ANNOUNCE: u8 = 0x10;
const KIND_DISCOVER_REQ: u8 = 0x20;
const KIND_DISCOVER_RES: u8 = 0x21;

/// "sha256:" (7) + 64 lowercase-hex = the 71-byte κ-label (the same width as the substrate's blake3 axis).
const LABEL_LEN: usize = 71;

/// Build an outbound frame: `u32 LE len | u8 kind | payload`.
fn encode_frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&((1 + payload.len()) as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(payload);
    out
}

/// Parse one inbound frame; `(kind, payload, total_consumed)` or None if a whole frame isn't buffered yet.
fn decode_frame(buf: &[u8]) -> Option<(u8, &[u8], usize)> {
    if buf.len() < 5 {
        return None;
    }
    let len = u32::from_le_bytes(buf[..4].try_into().ok()?) as usize;
    if len < 1 || buf.len() < 4 + len {
        return None;
    }
    Some((buf[4], &buf[5..4 + len], 4 + len))
}

/// Bare 64-hex κ → the 71-byte `sha256:<hex>` wire label.
fn label_of_hex(hex: &str) -> Option<[u8; LABEL_LEN]> {
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut l = [0u8; LABEL_LEN];
    l[..7].copy_from_slice(b"sha256:");
    l[7..].copy_from_slice(hex.as_bytes());
    Some(l)
}

/// A wire label → bare 64-hex, for the sha256 axis (other axes are valid labels but not ours here).
fn hex_of_label(label: &[u8]) -> Option<String> {
    if label.len() != LABEL_LEN || &label[..7] != b"sha256:" {
        return None;
    }
    let hex = core::str::from_utf8(&label[7..]).ok()?.to_ascii_lowercase();
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex)
    } else {
        None
    }
}

/// One end of the κ content network, backed by a [`SharedCache`]. Drives `fetch`/`announce`/`discover`
/// over a content-blind link. `inbox`/`outbox` are the wire; a `Link`/`run` couples two peers in tests
/// (and a real `NetworkInterface` couples them across machines in P2).
pub struct MeshPeer {
    store: SharedCache,
    inbox: Vec<u8>,
    outbox: Vec<u8>,
    /// hex → resolved result: `Some(bytes)` = verified hit, `None` = absent / refused. Absent key = pending.
    results: BTreeMap<String, Option<Vec<u8>>>,
    /// κ (hex) advertised by peers via announce / discover — *hints* (which peer to try); bytes still verified.
    discovered: BTreeSet<String>,
    /// Test-only: a forging responder answers EVERY fetch with these bytes regardless of κ.
    forge: Option<Vec<u8>>,
}

impl MeshPeer {
    /// An honest peer over `store`.
    pub fn new(store: SharedCache) -> Self {
        MeshPeer { store, inbox: Vec::new(), outbox: Vec::new(),
                   results: BTreeMap::new(), discovered: BTreeSet::new(), forge: None }
    }

    /// A malicious peer that answers every fetch with `forged` bytes — to prove the receiver refuses it.
    pub fn forging(store: SharedCache, forged: Vec<u8>) -> Self {
        let mut p = MeshPeer::new(store);
        p.forge = Some(forged);
        p
    }

    /// Publish bytes into the local store so this peer can serve them; returns the κ (bare hex).
    pub fn publish(&mut self, bytes: &[u8], mime: &str) -> String {
        self.store.put(bytes, mime)
    }

    /// Advertise that this peer holds `kappa` (hex) — a best-effort hint to the link's other end.
    pub fn announce(&mut self, kappa: &str) {
        if let Some(l) = label_of_hex(kappa) {
            self.outbox.extend_from_slice(&encode_frame(KIND_ANNOUNCE, &l));
        }
    }

    /// Begin fetching `kappa` (hex) from the peer. Poll [`fetch_take`] after the link is pumped.
    pub fn fetch_start(&mut self, kappa: &str) {
        if let Some(l) = label_of_hex(kappa) {
            self.outbox.extend_from_slice(&encode_frame(KIND_FETCH_REQ, &l));
        }
    }

    /// The fetch outcome for `kappa`: `Some(Some(bytes))` verified hit, `Some(None)` absent/refused,
    /// `None` still pending.
    pub fn fetch_take(&self, kappa: &str) -> Option<Option<Vec<u8>>> {
        self.results.get(kappa).cloned()
    }

    /// Ask the peer which κ it holds.
    pub fn discover_start(&mut self) {
        self.outbox.extend_from_slice(&encode_frame(KIND_DISCOVER_REQ, &[]));
    }

    /// κ (hex) learned from peers so far (hints).
    pub fn discovered(&self) -> Vec<String> {
        self.discovered.iter().cloned().collect()
    }

    /// Feed bytes received from a REAL transport (TCP socket / relay) into the inbox. Pairs with `drain_out`
    /// to drive this peer over a real wire — the same frames `pump` moves in-process in tests. This is how the
    /// wire-compatible mirror interoperates with the upstream BareNetSync over a socket (P6 interop).
    pub fn feed(&mut self, bytes: &[u8]) {
        self.inbox.extend_from_slice(bytes);
    }

    /// Take the bytes this peer wants to transmit (its outbox), to write to a real transport.
    pub fn drain_out(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.outbox)
    }

    /// Process every whole frame currently buffered in the inbox, generating responses into the outbox.
    /// Returns the number of frames handled.
    pub fn poll(&mut self) -> usize {
        let mut handled = 0;
        loop {
            let parsed = decode_frame(&self.inbox).map(|(k, p, c)| (k, p.to_vec(), c));
            match parsed {
                Some((kind, payload, consumed)) => {
                    self.inbox.drain(..consumed);
                    self.handle(kind, &payload);
                    handled += 1;
                }
                None => break,
            }
        }
        handled
    }

    fn handle(&mut self, kind: u8, payload: &[u8]) {
        match kind {
            KIND_FETCH_REQ => {
                let Some(hex) = hex_of_label(payload) else { return };
                let label = match label_of_hex(&hex) { Some(l) => l, None => return };
                if let Some(forged) = self.forge.clone() {
                    // A forging responder: returns attacker bytes under the requested κ.
                    let mut buf = Vec::with_capacity(LABEL_LEN + forged.len());
                    buf.extend_from_slice(&label);
                    buf.extend_from_slice(&forged);
                    self.outbox.extend_from_slice(&encode_frame(KIND_FETCH_RES_OK, &buf));
                } else if let Some((bytes, _mime)) = self.store.get(&hex) {
                    let mut buf = Vec::with_capacity(LABEL_LEN + bytes.len());
                    buf.extend_from_slice(&label);
                    buf.extend_from_slice(&bytes);
                    self.outbox.extend_from_slice(&encode_frame(KIND_FETCH_RES_OK, &buf));
                } else {
                    self.outbox.extend_from_slice(&encode_frame(KIND_FETCH_RES_404, payload));
                }
            }
            KIND_FETCH_RES_OK => {
                if payload.len() < LABEL_LEN {
                    return;
                }
                let Some(hex) = hex_of_label(&payload[..LABEL_LEN]) else { return };
                let bytes = &payload[LABEL_LEN..];
                // SPINE-4 / Law L5 — re-derive before accepting. A forging responder is rejected here.
                if sha256_hex(bytes) == hex {
                    self.results.insert(hex, Some(bytes.to_vec()));
                } else {
                    self.results.insert(hex, None);
                }
            }
            KIND_FETCH_RES_404 => {
                if let Some(hex) = hex_of_label(payload) {
                    self.results.insert(hex, None);
                }
            }
            KIND_ANNOUNCE => {
                if let Some(hex) = hex_of_label(payload) {
                    self.discovered.insert(hex);
                }
            }
            KIND_DISCOVER_REQ => {
                let listed = self.store.iterate();
                let mut p = Vec::with_capacity(4 + listed.len() * LABEL_LEN);
                p.extend_from_slice(&(listed.len() as u32).to_le_bytes());
                for hex in &listed {
                    if let Some(l) = label_of_hex(hex) {
                        p.extend_from_slice(&l);
                    }
                }
                self.outbox.extend_from_slice(&encode_frame(KIND_DISCOVER_RES, &p));
            }
            KIND_DISCOVER_RES => {
                if payload.len() < 4 {
                    return;
                }
                let n = u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
                let mut off = 4;
                for _ in 0..n {
                    if off + LABEL_LEN > payload.len() {
                        break;
                    }
                    if let Some(hex) = hex_of_label(&payload[off..off + LABEL_LEN]) {
                        self.discovered.insert(hex);
                    }
                    off += LABEL_LEN;
                }
            }
            _ => {} // unknown kinds ignored — forward-compatible (SPINE-5)
        }
    }
}

/// Couple two peers over a content-blind link: each peer's outbox is delivered to the other's inbox.
/// (In P2 a real `NetworkInterface` does this across machines; here it is one in-process hop.)
pub fn pump(a: &mut MeshPeer, b: &mut MeshPeer) -> usize {
    let moved = a.outbox.len() + b.outbox.len();
    b.inbox.append(&mut a.outbox);
    a.inbox.append(&mut b.outbox);
    moved
}

/// Pump + poll both peers `rounds` times — enough for a request to reach a peer and its reply to return.
pub fn run(a: &mut MeshPeer, b: &mut MeshPeer, rounds: usize) {
    for _ in 0..rounds {
        pump(a, b);
        a.poll();
        b.poll();
    }
}

// ── witness: our store + κ are a conformant, wire-compatible mesh peer (mirrors content_network_selftest) ──
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmpdir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("holo-meshsync-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn mesh_fetch_verified() {
        // A holds content; B has never seen it. B fetches from A over the wire and verifies on receipt.
        let (da, db) = (tmpdir("a1"), tmpdir("b1"));
        let mut a = MeshPeer::new(SharedCache::open(da.clone()));
        let mut b = MeshPeer::new(SharedCache::open(db.clone()));
        let content = b"uor-native content, delivered peer-to-peer with no central operator".to_vec();
        let k = a.publish(&content, "text/plain");
        b.fetch_start(&k);
        run(&mut a, &mut b, 4);
        assert_eq!(b.fetch_take(&k), Some(Some(content)), "B served verified bytes from a peer, zero origin");
        let _ = fs::remove_dir_all(&da);
        let _ = fs::remove_dir_all(&db);
    }

    #[test]
    fn mesh_absent_is_none() {
        let (da, db) = (tmpdir("a2"), tmpdir("b2"));
        let mut a = MeshPeer::new(SharedCache::open(da.clone()));
        let mut b = MeshPeer::new(SharedCache::open(db.clone()));
        let k = sha256_hex(b"content that no peer holds");
        b.fetch_start(&k);
        run(&mut a, &mut b, 4);
        assert_eq!(b.fetch_take(&k), Some(None), "an unheld κ resolves to nothing (404, no forging)");
        let _ = fs::remove_dir_all(&da);
        let _ = fs::remove_dir_all(&db);
    }

    #[test]
    fn mesh_forging_rejected() {
        // A is a forging responder (answers every fetch with attacker bytes). B re-derives and REFUSES.
        let (da, db) = (tmpdir("a3"), tmpdir("b3"));
        let real = b"the real content for this kappa".to_vec();
        let k = sha256_hex(&real);
        let mut a = MeshPeer::forging(SharedCache::open(da.clone()), b"/* EVIL PAYLOAD */".to_vec());
        let mut b = MeshPeer::new(SharedCache::open(db.clone()));
        b.fetch_start(&k);
        run(&mut a, &mut b, 4);
        assert_eq!(b.fetch_take(&k), Some(None), "forged bytes rejected on re-derivation (SPINE-4 / L5)");
        let _ = fs::remove_dir_all(&da);
        let _ = fs::remove_dir_all(&db);
    }

    #[test]
    fn mesh_discover_lists_peer_kappas() {
        let (da, db) = (tmpdir("a4"), tmpdir("b4"));
        let mut a = MeshPeer::new(SharedCache::open(da.clone()));
        let mut b = MeshPeer::new(SharedCache::open(db.clone()));
        let k1 = a.publish(b"one", "t");
        let k2 = a.publish(b"two", "t");
        let k3 = a.publish(b"three", "t");
        b.discover_start();
        run(&mut a, &mut b, 4);
        let d = b.discovered();
        assert!(d.contains(&k1) && d.contains(&k2) && d.contains(&k3), "B discovered A's κs as fetch hints");
        let _ = fs::remove_dir_all(&da);
        let _ = fs::remove_dir_all(&db);
    }

    #[test]
    fn wire_frame_and_label_byte_compat() {
        // Frame + κ-label are byte-identical to hologram-net-bare — the interop guarantee.
        let f = encode_frame(KIND_FETCH_REQ, b"abc");
        assert_eq!(&f[..4], &4u32.to_le_bytes(), "len = 1(kind) + 3(payload), little-endian");
        assert_eq!(f[4], 0x01, "FETCH_REQ kind");
        assert_eq!(&f[5..], b"abc");
        assert_eq!(decode_frame(&f), Some((0x01u8, &b"abc"[..], f.len())));
        let hex = sha256_hex(b"x");
        let l = label_of_hex(&hex).unwrap();
        assert_eq!(l.len(), 71);
        assert_eq!(&l[..7], b"sha256:");
        assert_eq!(hex_of_label(&l), Some(hex), "label round-trips to bare hex");
    }
}
