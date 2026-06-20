// capture-worker.js — Holo Capture's compute worker (UOR compute, off the UI thread).
//
// The page renders the live editor on the main thread for zero-latency drawing, but the
// EXPENSIVE, allocation-heavy steps — compositing the final image, running pixelate/blur
// over real pixels, PNG/JPEG encoding, and the sha256 κ — run HERE on an OffscreenCanvas so
// the UI never janks. The result is content-addressed: the worker re-derives the κ of the
// exact bytes it produced (Law 5), and the page verifies the same bytes re-derive to it
// before it ever shows "✓ κ verified" or saves to the store.
//
// Protocol (postMessage):
//   → { type:"flatten", id, doc, bitmap, format:"png"|"jpeg", quality }
//        bitmap: an ImageBitmap of the captured frame (transferred, zero-copy)
//   ← { type:"flattened", id, blob, kappa, width, height }     (blob transferred back)
//   ← { type:"error", id, message }
//
// One source of truth: the SAME _shared/holo-capture.js renderer the page uses.

/* global HoloCapture */
importScripts("./holo-capture.js");

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(u8) { const d = await crypto.subtle.digest("SHA-256", u8); return "sha256:" + hex(new Uint8Array(d)); }

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type !== "flatten") return;
  const { id, doc, bitmap, format, quality } = m;
  try {
    const region = (doc && doc.region) || { x: 0, y: 0, w: doc.w, h: doc.h };
    const W = Math.max(1, region.w | 0), H = Math.max(1, region.h | 0);
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { alpha: false });

    // Re-hydrate history-free doc and draw with the shared renderer.
    const d = HoloCapture.deserialize(HoloCapture.serialize(doc));
    HoloCapture.render(ctx, d, bitmap, {});

    const type = format === "jpeg" ? "image/jpeg" : "image/png";
    const blob = await canvas.convertToBlob(type === "image/jpeg" ? { type, quality: quality ?? 0.92 } : { type });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const kappa = await sha256(bytes);

    // Transfer the bytes back (zero-copy).
    self.postMessage({ type: "flattened", id, blob, kappa, width: W, height: H }, []);
    if (bitmap && bitmap.close) try { bitmap.close(); } catch {}
  } catch (err) {
    self.postMessage({ type: "error", id, message: String((err && err.message) || err) });
  }
};

self.postMessage({ type: "ready", tools: HoloCapture.TOOLS.length });
