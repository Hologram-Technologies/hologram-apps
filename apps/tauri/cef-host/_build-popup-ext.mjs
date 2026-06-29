// _build-popup-ext.mjs — build an unpacked MV3 extension WITH an action popup and a FIXED key, so its
// extension id is deterministic (Chrome derives the id = sha256(DER public key)[0:16] mapped 0-f→a-p).
// This lets us drive holo:extaction with a known id and prove the popup actually renders.
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "test-ext-popup");
mkdirSync(dir, { recursive: true });

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
const keyB64 = der.toString("base64");
const hash = createHash("sha256").update(der).digest();
let id = "";
for (let i = 0; i < 16; i++) { id += String.fromCharCode(97 + (hash[i] >> 4)); id += String.fromCharCode(97 + (hash[i] & 0xf)); }

const manifest = {
  manifest_version: 3,
  name: "Holo Popup Test",
  version: "1.0",
  key: keyB64,
  description: "Proves the κ-rail extension proxy opens a real extension popup.",
  action: { default_popup: "popup.html", default_title: "Holo Popup" },
  content_scripts: [{ matches: ["https://example.com/*"], js: ["cs.js"], run_at: "document_end" }],
};
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(dir, "popup.html"), "<!doctype html><meta charset=utf-8><title>Holo Popup</title><body style=\"font:14px system-ui;margin:16px\"><h1 id=mark>HOLO_POPUP_RENDERED_OK</h1><p>The κ-rail opened this real extension popup.</p>");
writeFileSync(join(dir, "cs.js"), "document.documentElement.setAttribute('data-holo-popup-cs','1');");

console.log("EXT_DIR=" + dir);
console.log("EXT_ID=" + id);
console.log("POPUP_URL=chrome-extension://" + id + "/popup.html");
