// holo-xxx-queue.mjs — the BATCH-INGEST queue: turn a list of sources the user is ENTITLED to (their own files,
// a CC/public-domain archive, their own yt-dlp URL list) into streamable κ-scenes, sealed into the collection.
// This is the LEGITIMATE "prepopulated streamable" path — the bytes are the user's to ingest. The queue NEVER
// fabricates a stream: an item is marked "streamable" ONLY after a real κ-sealed MediaGraph comes back from
// ingest; otherwise it stays "failed" (honest), never a fake-playable index entry.
//
// `ingest(source)` is INJECTED — the real one runs holo-xxx-ingest --acquire (yt-dlp + ffmpeg) on the user's
// machine and returns { graph, work, tags }; the witness injects a stub returning a known demo graph. So the
// queue logic is pure and Node-witnessable, and the actual downloading stays the off-substrate, user-driven edge.

import { acquireIntoCollection } from "./holo-xxx-acquire.mjs";

export function createIngestQueue({ ingest, collection, onUpdate = null } = {}) {
  if (typeof ingest !== "function") throw new Error("holo-xxx-queue: ingest(source) → { graph, work, tags } required");
  const items = [];
  const emit = () => { if (onUpdate) onUpdate(items.slice()); };
  const tally = () => ({
    total: items.length,
    pending: items.filter((i) => i.status === "pending").length,
    streamable: items.filter((i) => i.status === "streamable").length,
    failed: items.filter((i) => i.status === "failed").length,
  });

  function add(source, meta = {}) {
    const item = { id: "q" + items.length, source, meta, status: "pending", scene: null, error: null };
    items.push(item); emit(); return item;
  }

  async function processOne(item) {
    item.status = "active"; emit();
    try {
      const res = await ingest(item.source);                 // the user's machine does the acquisition (ToS edge)
      if (!res || !res.graph) throw new Error("no κ-graph produced");
      // seal the user-produced graph into a USER_OWNED scene + add to the collection (rights set in acquire).
      const { scene } = acquireIntoCollection({ graph: res.graph, work: res.work || item.meta.work || { title: item.meta.title || item.source }, tags: res.tags || item.meta.tags || [], collection, sources: res.sources || [] });
      item.scene = scene; item.status = "streamable";        // ONLY now — a real, verifiable κ-scene exists
    } catch (e) {
      item.status = "failed"; item.error = String(e.message || e);   // honest: never a fake stream
    }
    emit();
  }

  // run({ concurrency }) — process all pending with a small worker pool, so a big list ingests without blocking.
  async function run({ concurrency = 2 } = {}) {
    const queue = items.filter((i) => i.status === "pending");
    let next = 0;
    const worker = async () => { while (next < queue.length) { const i = queue[next++]; await processOne(i); } };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return tally();
  }

  return { add, run, items: () => items.slice(), tally };
}

export default { createIngestQueue };
if (typeof window !== "undefined") window.HoloXxxQueue = { createIngestQueue };
