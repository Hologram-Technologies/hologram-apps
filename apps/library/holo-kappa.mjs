// holo-kappa.mjs — the app's content-address function, kept app-LOCAL so Holo Library is a self-contained
// holospace (every import resolves inside the sealed closure; nothing reaches across packages). It is byte-for-
// byte the same κ the rest of the OS uses: blake3 over the raw bytes, "blake3:" + hex — identical to
// holo-content-net.kappaOf and holo-blake3.kappaBlake3. holo-blake3.mjs here is a byte-identical vendored copy
// of the OS canonical (its own κ therefore equals the canonical lib's), so a title pinned here addresses the
// same as everywhere else.

import { blake3hex } from "./holo-blake3.mjs";

const u8 = (b) => (b instanceof Uint8Array ? b : typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b));
export const kappaOf = (bytes) => "blake3:" + blake3hex(u8(bytes));
export { blake3hex };

export default { kappaOf, blake3hex };
