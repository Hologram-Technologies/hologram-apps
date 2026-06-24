// broker_server.h — a minimal, loopback-only static HTTP server embedded in the host so the step-up
// WebAuthn broker can run at a VALID origin (http://localhost) without any external process. It serves
// ONLY the broker page and the holo-webauthn module graph from the host's own sealed OS dir.
//
// Attack-surface posture (the user's brief: minimize): binds 127.0.0.1 ONLY (never a routable address);
// GET only; a tight path safelist (the broker html + /usr/lib/holo/ + /_shared/ modules); no directory
// traversal ("..") ; no listing; Connection: close. It exposes only OS code that already ships in the
// sealed image — no user data, no app state.
#ifndef CHROME_BROWSER_HOLO_BROKER_SERVER_H_
#define CHROME_BROWSER_HOLO_BROKER_SERVER_H_
#include <string>
namespace holo {
// Starts the server on a detached thread for the process lifetime. No-op if it cannot bind.
void StartBrokerServer(const std::string& os_dir, int port);
// Set the live bar κ-list JSON the broker serves at /_holo/bar.json (loopback only; the κ-projector
// extension reads it to mirror the user's bookmarks onto Chrome's native bookmarks bar).
void SetBrokerBarJson(const std::string& json);
}  // namespace holo
#endif  // CHROME_BROWSER_HOLO_BROKER_SERVER_H_
