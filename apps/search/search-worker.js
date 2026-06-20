// search-worker.js — the Holo Search engine, off the UI thread. Loads the content-addressed
// OS corpus (search/corpus.json), builds the OpenSearch index (holo-search.js) AND the HoloRank
// reference graph (holo-rank.js), then answers queries with the blended relevance:
//
//   score = BM25(lexical)  ×  (1 + ln(1 + GAIN·HoloRank))   ×  (1 + W·semanticCosine)
//           └ OpenSearch ┘     └ the OS object-graph authority ┘   └ deterministic embedding ┘
//
// expressed in the faithful OpenSearch function_score / script_score DSL, so the blend is a
// query, not a bolt-on. Every hit carries its did:holo; a holospace hit can be re-derived on
// demand (Law L5) by fetching its loader bytes and re-hashing to the κ in hub-manifest.json.
//
// Module worker: imports the SAME engines the page and the witnesses use (one source of truth).

import { Index, embed, cosine } from "../../_shared/holo-search.js";
import { buildGraph, query as rankQuery } from "../../_shared/holo-rank.js";

const GAIN = 800;       // HoloRank authority gain (tuned so top holospaces lead specs)
const SEMW = 0.25;      // semantic (vector cosine) blend weight
const DIMS = 64;        // embedding dimensionality

let ix = null, corpus = null, rankScores = new Map(), ready = false;

// plain corpus edge → HoloRank's F-keyed reference edge (the published holo-rank vocab).
const toRankEdge = (e) => ({ "rel": e.rel, "prov:wasDerivedFrom": e.from, "schema:itemReviewed": e.to,
  "prov:wasAttributedTo": "did:holo:system", "schema:reviewRating": e.weight ?? 1, "dcterms:created": e.at || 0 });

async function init(corpusUrl) {
  corpus = await fetch(corpusUrl, { cache: "no-store" }).then((r) => r.json());
  // 1 · HoloRank over the OS object graph (global authority: teleport from every holospace).
  const graph = buildGraph(corpus.edges.map(toRankEdge), {});
  const seed = corpus.docs.filter((d) => d.kind === "holospace").map((d) => d.node);
  rankScores = rankQuery(graph, seed.length ? seed : corpus.docs.map((d) => d.node)).scores;
  // 2 · the OpenSearch index — schema.org-typed fields + a knn_vector auto-embedded from text.
  ix = new Index("holo", { settings: { default_analyzer: "english" }, mappings: { properties: {
    title: { type: "text", analyzer: "english" }, summary: { type: "text", analyzer: "english" },
    body: { type: "text", analyzer: "english" }, keywords: { type: "text", analyzer: "english" },
    kind: { type: "keyword" }, categories: { type: "keyword" }, developer: { type: "keyword" },
    holorank: { type: "float" }, vec: { type: "knn_vector", dimension: DIMS, from: ["title", "summary", "keywords"] },
  } } });
  for (const d of corpus.docs) ix.index(d.id, {
    ...d, keywords: (d.keywords || []).join(" "), categories: d.categories || [],
    holorank: rankScores.get(d.node) || 0,
  });
  ready = true;
  return { count: corpus.count, edges: corpus.edges.length, corpusKappa: corpus.kappa };
}

// the blended query — OpenSearch function_score (BM25 × HoloRank) then a semantic re-rank.
function runQuery(q, { size = 12, kind = null, category = null } = {}) {
  const must = [{ multi_match: { query: q, fields: ["title^3", "summary^2", "keywords^2", "body"], operator: "or", fuzziness: "AUTO" } }];
  const filter = [];
  if (kind) filter.push({ term: { kind } });
  if (category) filter.push({ term: { categories: category } });
  const body = {
    size: 60, // over-fetch, then semantic re-rank + paginate
    query: { function_score: {
      query: { bool: { must, ...(filter.length ? { filter } : {}) } },
      script_score: { script: { source: "_score * (1 + ln(1 + " + GAIN + " * doc['holorank'].value))" } },
      boost_mode: "replace",
    } },
    highlight: { fields: { summary: {}, body: {} }, pre_tags: ["<mark>"], post_tags: ["</mark>"] },
    aggs: { kinds: { terms: { field: "kind", size: 10 } }, cats: { terms: { field: "categories", size: 12 } } },
  };
  const res = ix.search(body);
  // semantic blend: deterministic embedding cosine, folded multiplicatively.
  const qv = embed(q, DIMS);
  const docVec = (id) => ix.vectors.get("vec")?.get(id) || null;
  for (const h of res.hits.hits) {
    const v = docVec(h._id); const sem = v ? Math.max(0, cosine(qv, v)) : 0;
    h._semantic = sem; h._blended = h._score * (1 + SEMW * sem);
  }
  res.hits.hits.sort((a, b) => b._blended - a._blended);
  const page = res.hits.hits.slice(0, size).map((h) => ({
    id: h._id, node: h._source.node, kind: h._source.kind, title: h._source.title,
    summary: h._source.summary, snippet: (h.highlight?.summary?.[0] || h.highlight?.body?.[0] || h._source.summary || "").slice(0, 240),
    loader: h._source.loader || null, appId: h._source.appId || null, icon: h._source.icon || null,
    url: h._source.url || null, categories: h._source.categories || [], type: h._source.type || [],
    accent: h._source.accent || null, real: !!h._source.real,
    score: h._blended, bm25: h._score, holorank: h._source.holorank, semantic: h._semantic,
  }));
  return { took: res.took, total: res.hits.total.value, hits: page,
    facets: { kind: res.aggregations.kinds.buckets, categories: res.aggregations.cats.buckets } };
}

// completion suggester for type-ahead (titles), plus a fuzzy did-you-mean.
function suggest(q) {
  if (!q || q.length < 1) return [];
  const r = ix.search({ size: 6, query: { bool: { should: [
    { match_phrase: { title: { query: q, slop: 2 } } },
    { match: { title: { query: q, operator: "and", fuzziness: "AUTO", boost: 2 } } },
    { prefix: { title: q.toLowerCase() } },
    { match: { keywords: { query: q, fuzziness: "AUTO" } } },
  ], minimum_should_match: 1 } } });
  const seen = new Set();
  return r.hits.hits.map((h) => ({ text: h._source.title, kind: h._source.kind, appId: h._source.appId, loader: h._source.loader }))
    .filter((s) => !seen.has(s.text) && seen.add(s.text)).slice(0, 6);
}

// Law L5 on demand: re-derive a holospace hit's loader bytes → sha256 → compare to its node κ.
async function verify(node, loaderUrl) {
  try {
    const buf = await fetch(loaderUrl, { cache: "no-store" }).then((r) => r.arrayBuffer());
    const dig = await crypto.subtle.digest("SHA-256", buf);
    const hex = [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { ok: "did:holo:sha256:" + hex === node, kappa: "sha256:" + hex };
  } catch (e) { return { ok: null, error: String(e?.message || e) }; }
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === "init") { const info = await init(m.corpusUrl); self.postMessage({ type: "ready", ...info }); }
    else if (m.type === "query") { if (!ready) return; self.postMessage({ type: "results", id: m.id, q: m.q, ...runQuery(m.q, m.opts || {}) }); }
    else if (m.type === "suggest") { if (!ready) return; self.postMessage({ type: "suggest", id: m.id, q: m.q, items: suggest(m.q) }); }
    else if (m.type === "verify") { const v = await verify(m.node, m.loaderUrl); self.postMessage({ type: "verified", id: m.id, node: m.node, ...v }); }
  } catch (err) { self.postMessage({ type: "error", id: m.id, error: String(err?.message || err) }); }
};
