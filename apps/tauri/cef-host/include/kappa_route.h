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

#ifdef __cplusplus
}
#endif

#endif /* KAPPA_ROUTE_H */
