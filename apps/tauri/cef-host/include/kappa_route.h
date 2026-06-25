/* kappa_route.h — C ABI for the κ-route verifier (Rust crate `kappa-route`, src/ffi.rs).
 *
 * The CEF resource handler calls these to serve content-addressed, dual-axis-verified bytes
 * (holospaces Law L5 / SEC-1 / SEC-6). This declaration mirrors the #[no_mangle] extern "C" fns and
 * is cbindgen-compatible (regenerate with: cbindgen --crate kappa-route --output kappa_route.h).
 */
#ifndef KAPPA_ROUTE_H
#define KAPPA_ROUTE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque sealed-image store. */
typedef struct KStore KStore;

/* Open a store rooted at `root` (UTF-8, NUL-terminated). `expected_anchor` is the baked trust root
 * (sha256 hex of os-closure.json) or NULL/empty to skip; on mismatch the store refuses everything.
 * Free with kr_store_free; NULL on bad input. */
KStore* kr_store_open(const char* root, const char* expected_anchor);

/* Free a store handle from kr_store_open. */
void kr_store_free(KStore* st);

/* Warm the verified-bytes cache for the boot-relevant (< max_bytes; 0 = 64 KiB) files IN PARALLEL, so the
 * first page load sees warm (network-free, no re-hash) serves instead of slow sequential cold ones.
 * Call on a BACKGROUND thread right after kr_store_open (off the boot-critical path). Returns count warmed. */
size_t kr_store_warm(const KStore* st, uint64_t max_bytes);

/* Resolve `req_path` against the store, re-deriving its content address on BOTH axes.
 * Returns the HTTP status: 200 verified hit, 403 tamper/unpinned, 404 absent, 400 bad input.
 * On 200: *out_ptr/*out_len = heap buffer (free with kr_free), *out_mime = static mime (do NOT free).
 * On non-200: out-params are set NULL/0. */
uint16_t kr_resolve(const KStore* st, const char* req_path,
                    uint8_t** out_ptr, size_t* out_len, const char** out_mime);

/* Free a buffer returned by kr_resolve. */
void kr_free(uint8_t* ptr, size_t len);

/* Compute the lowercase sha256 hex (64 chars + NUL) of `len` bytes at `data` into `out` (caller
 * provides >= 65 bytes). The verifier's own content-address hash, reused for content-κ ad blocking:
 * a payload is refused by THIS hash, so a denylisted ad object is caught wherever it is served. */
void kr_sha256_hex(const uint8_t* data, size_t len, char* out);

/* BLAKE3 hex (64 chars + NUL) into `out` (>= 65 bytes) — the substrate's FAST σ-axis (did:holo:blake3:…),
 * a SIMD tree hash ~5x faster than sha256. The projection producer addresses per-frame tiles on this axis. */
void kr_blake3_hex(const uint8_t* data, size_t len, char* out);

/* Verified streaming (Bao): verify a CHUNK of a κ-object against its root κ via its Merkle proof, in
 * O(log n), WITHOUT the whole object — so the host can serve a VERIFIED RANGE of a large object streamed
 * from a peer/origin (a tampered chunk is refused, Law L5; the rest stream on). `root_hex` = NUL-terminated
 * 64-char lowercase hex; `proof` = `proof_count` siblings, each 33 bytes (1 side byte 'L'/'R' + 32-byte
 * chaining value). Returns 1 iff the chunk verifies, else 0. Same proof format as holo-bao.mjs (cross-impl). */
uint8_t kr_bao_verify_chunk(const char* root_hex, uint64_t index,
                            const uint8_t* chunk, size_t chunk_len,
                            const uint8_t* proof, size_t proof_count);

/* Verify a contiguous SLICE (aligned power-of-two run of chunks from `start_chunk`) in ONE SIMD pass + a
 * short upper proof — the host's FAST streaming-verify path (~10× the per-chunk rate; measured ~40 GB/s
 * parallel), so a κ-stream is wire-bound, not verify-bound (the InfiniBand-class requirement). Same proof
 * wire format as kr_bao_verify_chunk. Returns 1 iff the slice verifies against `root_hex`, else 0. */
uint8_t kr_bao_verify_slice(const char* root_hex, uint64_t start_chunk,
                            const uint8_t* slice, size_t slice_len,
                            const uint8_t* proof, size_t proof_count);

/* Verified-streaming PRODUCER (kr_bao_encoder_*): the host streams a large κ-object as BLAKE3-verified
 * chunks. Build the outboard ONCE (one O(n log n) SIMD pass), then serve any chunk + proof in O(1) — a
 * consumer (renderer/peer/tab) renders chunk 0 the instant it arrives; the object is never re-hashed per
 * request. The proof wire format (proof_count × 33 bytes: side 'L'/'R' + 32-byte CV) is exactly what
 * kr_bao_verify_chunk consumes, so the host produces what any holo-bao consumer verifies (cross-impl). */
typedef struct BaoEncoder BaoEncoder;
BaoEncoder* kr_bao_encoder_new(const uint8_t* data, size_t len);          /* free with kr_bao_encoder_free */
void        kr_bao_encoder_root(const BaoEncoder* enc, char* out /*>=65*/);
uint64_t    kr_bao_encoder_chunk_count(const BaoEncoder* enc);
/* Serve chunk `index`: bytes (out_chunk/out_chunk_len, free kr_free) + proof (out_proof/out_proof_count
 * siblings × 33 bytes, free kr_free over out_proof_count*33). Returns 1, or 0 if index is out of range. */
uint8_t     kr_bao_encoder_chunk(const BaoEncoder* enc, uint64_t index,
                                 uint8_t** out_chunk, size_t* out_chunk_len,
                                 uint8_t** out_proof, size_t* out_proof_count);
void        kr_bao_encoder_free(BaoEncoder* enc);

/* κ-fabric effective-goodput proof: run the InfiniBand-class benchmark for an object_mb-MiB object and
 * return a heap JSON string (free with kr_cache_free_mime) — bare-metal ceilings (raw + parallel BLAKE3,
 * Bao verify 1-core vs all-cores, memcpy) + the effective-goodput sweep vs IB (HDR/NDR/XDR) + honest notes.
 * The host calls this from a holo:// page (cefQuery) to surface the proof live, the hot path in native Rust. */
char* kr_fabric_goodput(size_t object_mb);

/* ── Open-web κ-cache (kr_cache_*). The host's resource path content-addresses every cacheable http(s)
 * subresource and serves repeats from this cache at memory speed (no DNS/TLS/network) — projecting the
 * substrate in front of the network for EVERY website, not just holo://. Distinct from the sealed,
 * read-only kr_store. Thread-safe (the handle wraps a Mutex<WebCache>). Safe because κ = the content
 * address: a hit only returns bytes that re-derive to the requested κ (Law L5). */
typedef struct KCache KCache;

/* Open an open-web κ-cache bounded to `cap` distinct κ (the resident working set). Free with kr_cache_free. */
KCache* kr_cache_new(size_t cap);
/* Open a κ-cache whose resident cap is auto-sized to this device's RAM (no setting; scales weak↔strong). */
KCache* kr_cache_new_auto(void);
void kr_cache_free(KCache* c);

/* Serve a GET `url` from the cache if held (re-derives κ first — L5; tamper ⇒ miss). Returns 1 on a hit
 * (*out_ptr/*out_len = buffer, free with kr_free; *out_mime = mime buffer, free with kr_cache_free_mime),
 * else 0 (out-params cleared). */
uint8_t kr_cache_get(const KCache* c, const char* url,
                     uint8_t** out_ptr, size_t* out_len, char** out_mime);

/* Install a fetched (cold-miss) body, deduped by κ. `immutable` (0/1) marks serve-forever assets. */
void kr_cache_put(const KCache* c, const char* url,
                  const uint8_t* data, size_t len, const char* mime, uint8_t immutable);

/* Free a mime string returned by kr_cache_get. */
void kr_cache_free_mime(char* m);

/* Enumerate the cache as a JSON array string [{"url","kappa","mime","len"}] — the manifest the Living
 * Window reads to compose from what you browsed. NO bodies (metadata only; bytes stay fetchable via the
 * serve-hit path). Heap string; free with kr_cache_free_mime. NULL on bad input. */
char* kr_cache_entries(const KCache* c);

/* Fetch a held object BY its κ (bare hex or "did:holo:sha256:<hex>") — how the Living Window pulls a
 * captured doc/asset's bytes by the κ from the manifest. Returns 1 on a verified hit (*out_ptr/*out_len =
 * buffer, free with kr_free; *out_mime = mime, free with kr_cache_free_mime), else 0 (re-derives — L5). */
uint8_t kr_cache_get_kappa(const KCache* c, const char* kappa,
                           uint8_t** out_ptr, size_t* out_len, char** out_mime);

/* Fetch a held object BY its BLAKE3 σ-axis hex — how the projection lens pulls a tile addressed on the fast
 * axis (holo://os/cache/blake3/<hex>). Returns 1 on a verified hit (same out-params + free rules as
 * kr_cache_get_kappa), else 0 (re-derives BLAKE3 — L5). */
uint8_t kr_cache_get_b3(const KCache* c, const char* b3hex,
                        uint8_t** out_ptr, size_t* out_len, char** out_mime);

/* ── Planetary shared-κ substrate (kr_shared_*). The next layer above kr_cache: a SHARED, content-addressed
 * store keyed BY κ (not url) behind a swappable transport — so the web's FIRST load for you is served from a
 * blob a PEER already minted, origin untouched, only a hash ever crossing the wire. A read re-derives the κ
 * and refuses a mismatch (Law L5), so an untrusted relay is safe (a hostile peer ⇒ miss ⇒ origin fallback,
 * never poison). This first landing backs the transport with a directory (one blob file per κ); a network
 * relay is the same get/put-BY-κ interface. Thread-safe (Mutex). See kappa-route/src/sharedcache.rs. */
typedef struct KShared KShared;

/* Open the shared substrate rooted at `dir` (UTF-8, NUL-terminated). Free with kr_shared_free; NULL on bad
 * input. Two handles over the same dir are two nodes sharing the same relay. */
KShared* kr_shared_open(const char* dir);
void kr_shared_free(KShared* c);

/* Fetch bytes for a `kappa` (bare 64-hex or "did:holo:sha256:<hex>"). Returns 1 on a VERIFIED hit
 * (*out_ptr/*out_len = buffer, free with kr_free; *out_mime = mime, free with kr_cache_free_mime), else 0
 * (miss/refusal). A malformed κ is refused (path-traversal guard). */
uint8_t kr_shared_get(const KShared* c, const char* kappa,
                      uint8_t** out_ptr, size_t* out_len, char** out_mime);

/* Publish bytes to the shared substrate (deduped by κ). `kappa` is advisory — the address is recomputed
 * from the bytes, so a caller cannot mislabel content. */
void kr_shared_put(const KShared* c, const char* kappa,
                   const uint8_t* data, size_t len, const char* mime);

/* BLAKE3 σ-axis variants — the projection cross-device transport (the substrate is blake3-canonical; tiles
 * never touch sha256). Separate `b3/` blob namespace. get re-derives BLAKE3 and refuses a mismatch (L5).
 * `kappa` may be bare 64-hex or "did:holo:blake3:<hex>"; put recomputes the blake3 address from the bytes. */
uint8_t kr_shared_get_b3(const KShared* c, const char* kappa,
                         uint8_t** out_ptr, size_t* out_len, char** out_mime);
void kr_shared_put_b3(const KShared* c, const uint8_t* data, size_t len, const char* mime);

/* Record url→κ in the shared manifest (the gossip κ-source) so a node that never fetched `url` can resolve
 * its content address. Called on a cold miss alongside kr_shared_put. The BYTE transport stays κ-only; this
 * sidecar reveals only the public url↔κ fact. */
void kr_shared_note(const KShared* c, const char* url, const char* kappa);

/* The κ a peer recorded for `url`, or NULL if unknown. Heap string (bare 64-hex); free with
 * kr_cache_free_mime. This is the κ the HIT seam asks the shared substrate for. */
char* kr_shared_kappa_for(const KShared* c, const char* url);

/* ── Mesh bridge (kr_mesh_get). On a shared-cache miss for a κ a peer gossiped, ask the LOCAL mesh sidecar
 * (holo-mesh-node gateway) to fetch it from a remote peer over BareNetSync. The gateway verifies (L5) and
 * persists the blob into HOLO_SHARED_DIR, so the host re-reads kr_shared_get and serves it (kappa-mesh).
 * Returns 1 if fetched+persisted (re-read kr_shared_get), 0 otherwise (no gateway / no peer / timeout →
 * fall through to the origin). Gateway addr from env HOLO_MESH_GATEWAY (default 127.0.0.1:9802). std::net
 * only — no networking deps in this crate; the BareNetSync machinery lives in the sidecar process. */
uint8_t kr_mesh_get(const char* kappa);

/* ── Peer/agent identity + semantic conformance (P5 host wiring). did:holo is a κ-rooted, self-certifying W3C
 * DID (the DID is sha256(pubkey); no registry). The host serves its DID Document at /.well-known/did.json so
 * any W3C consumer or agent resolves + verifies it. kr_ld_validate is validate-before-serve: a κ-object's
 * properties must be W3C AS2 / schema.org / DID-core terms (or a declared local-context extension). */

/* did:holo:<sha256(pubkey)>. Heap string; free with kr_cache_free_mime. NULL on bad input. */
char* kr_did_from_key(const uint8_t* pubkey, size_t len);
/* 1 iff `did` == did:holo:sha256(pubkey) (self-certifying), else 0. */
uint8_t kr_did_verify(const char* did, const uint8_t* pubkey, size_t len);
/* The W3C DID Document (JSON) for did:holo rooted in `pubkey`, advertising the verification key + a
 * HoloContentNetwork `serviceEndpoint`. Heap string; free with kr_cache_free_mime. NULL on bad input. */
char* kr_did_document(const uint8_t* pubkey, size_t len, const char* endpoint);
/* The W3C DID Document for an EXPLICIT `did` (the TEE-authenticated operator κ — already a valid
 * did:holo:sha256:<hex>), with `pubkey` as the verification key. The unified-identity form: the host's
 * peer/mesh/agent DID IS the operator identity. Heap string; free with kr_cache_free_mime. NULL on bad input. */
char* kr_did_document_for(const char* did, const uint8_t* pubkey, size_t len, const char* endpoint);

/* Validate one JSON-LD object (NUL-terminated JSON). 1 if every property is a W3C AS2/schema.org/DID-core
 * term, a JSON-LD keyword, or a declared local-context term; else 0. The host's validate-before-serve. */
uint8_t kr_ld_validate(const char* json);

#ifdef __cplusplus
}
#endif

#endif /* KAPPA_ROUTE_H */
