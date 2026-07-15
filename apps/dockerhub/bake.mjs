// bake.mjs — Holo Hub's static snapshot baker. Resolves the LIVE Docker Hub catalog (top-pulled +
// every category) and captures it — WITH the original artwork inlined as data URIs — into one
// self-contained catalog.json. The published app then browses 100% serverless: zero network, no
// proxy, no CORS, works in any browser off github.io. A scheduled GitHub Action re-runs this to keep
// the snapshot near-live. Run: `node bake.mjs` (Node 18+, global fetch).
import { writeFile } from "node:fs/promises";

const HUB = "https://hub.docker.com";
const OUT = new URL("./catalog.json", import.meta.url);
const PER_CAT = 24;     // images captured per category
const TOP = 60;         // most-pulled overall (the landing grid + spotlight)
const ART_MAX = 24_000; // skip absurd logos; keep the snapshot lean

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hub(path) {
  for (let t = 0; t < 4; t++) {
    const r = await fetch(HUB + path, { headers: { "user-agent": "holo-hub-baker" } });
    if (r.ok) return r.json();
    if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
    throw new Error("hub " + r.status + " " + path);
  }
  throw new Error("hub retries exhausted " + path);
}

// Fetch a logo and return a data URI — the original artwork, captured so the app ships it itself.
const artCache = new Map();
async function art(url) {
  if (!url) return "";
  if (artCache.has(url)) return artCache.get(url);
  let out = "";
  try {
    const r = await fetch(url);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length && buf.length <= ART_MAX) {
        const mime = r.headers.get("content-type") || "image/png";
        out = `data:${mime};base64,${buf.toString("base64")}`;
      }
    }
  } catch {}
  artCache.set(url, out);
  return out;
}

function mapImage(r) {
  const id = r.id || "";
  const rp = (r.rate_plans || [])[0] || {};
  const repo = (rp.repositories || [])[0] || {};
  return {
    id,
    name: r.name || id,
    image: id.startsWith("library/") ? id.slice(8) : id,
    official: id.startsWith("library/"),
    verified: r.source === "verified_publisher",
    why: r.short_description || "",
    logo: (r.logo_url && (r.logo_url.small || r.logo_url.large)) || "",
    pulls: repo.pull_count || "",
    stars: r.star_count || 0,
    updated: r.updated_at || "",
    cats: (r.categories || []).map((c) => c.name),
    archs: (rp.architectures || []).map((a) => a.label),
  };
}

async function search({ query = "", category = "", sort = "pull_count", size = 24 }) {
  const qs = new URLSearchParams({ from: 0, size, type: "image", sort, order: "desc" });
  if (query) qs.set("query", query);
  if (category) qs.set("categories", category);
  const d = await hub("/api/search/v3/catalog/search?" + qs);
  return { total: d.total || 0, results: (d.results || []).filter((r) => r.type === "image" && !r.archived).map(mapImage) };
}

const main = async () => {
  const categories = await hub("/v2/categories/"); // [{name, slug}]
  console.log(`baker: ${categories.length} categories`);

  const byId = new Map();
  const keep = (img) => { if (img.id && !byId.has(img.id)) byId.set(img.id, img); };

  // Landing: most-pulled overall.
  const top = await search({ sort: "pull_count", size: TOP });
  top.results.forEach(keep);
  const topIds = top.results.map((r) => r.id);
  console.log(`baker: top ${top.results.length} of ${top.total.toLocaleString()}`);

  // Per-category (the browse spine).
  const catTotals = {};
  for (const c of categories) {
    const s = await search({ category: c.slug, sort: "pull_count", size: PER_CAT });
    s.results.forEach(keep);
    catTotals[c.slug] = s.total;
    console.log(`baker: ${c.slug} → ${s.results.length} / ${s.total.toLocaleString()}`);
    await sleep(120);
  }

  // Inline the original artwork for every unique image.
  const imgs = [...byId.values()];
  let withArt = 0;
  for (const img of imgs) { img.art = await art(img.logo); if (img.art) withArt++; }
  console.log(`baker: ${imgs.length} unique images, ${withArt} with inlined artwork`);

  const snapshot = {
    baked_at: new Date().toISOString(),
    hub_total: top.total,
    categories,
    cat_totals: catTotals,
    top_ids: topIds,
    images: imgs,
  };
  await writeFile(OUT, JSON.stringify(snapshot));
  const mb = (JSON.stringify(snapshot).length / 1048576).toFixed(2);
  console.log(`baker: wrote catalog.json (${mb} MiB, ${imgs.length} images, ${categories.length} categories)`);
};
main().catch((e) => { console.error(e); process.exit(1); });
