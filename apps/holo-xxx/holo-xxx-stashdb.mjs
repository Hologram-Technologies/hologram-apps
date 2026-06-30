// holo-xxx-stashdb.mjs — StashDB as a METADATA SceneProvider. StashDB (stashdb.org) is the open, community-built
// metadata DB that the Stash app's own scrapers query: canonical titles, performers, studios, dates, tags, and
// cover art for adult-scene-space. It carries NO content, so it contributes mediaType:"meta" — it enriches a
// scene (and supplies the cover + the tags the catalogue facets by) but never claims to be playable bytes. This
// keeps the rights model honest (holo-scene-manifest.assertRightsCoherent): metadata is an index, never a stream.
//
// StashDB is a GraphQL endpoint that requires a free account API key (Settings → API Key on stashdb.org). The key
// is INJECTED, never embedded — same discipline as every other provider. Without a key the provider disables
// itself (returns []), so the hub degrades to owned-content + demo, exactly like a book provider that errors.
//
//   POST https://stashdb.org/graphql   { ApiKey: <key> }
//   query Q($t:String!){ queryScenes(input:{title:$t, per_page:24}){ scenes{
//     id title release_date duration
//     studio{ name } performers{ performer{ name } } tags{ name }
//     images{ url } } } }

const ENDPOINT = "https://stashdb.org/graphql";
const FIELDS = `id title release_date duration studio{name} performers{as performer{name}} tags{name} images{url width} urls{url}`;
// title search (the discovery box) …
const QUERY = `query Q($t:String!,$n:Int!){queryScenes(input:{title:$t,per_page:$n}){scenes{${FIELDS}}}}`;
// … and a no-filter BROWSE page (newest first), so importCatalog can page the whole DB into the wall.
const BROWSE = `query B($p:Int!,$n:Int!){queryScenes(input:{page:$p,per_page:$n,sort:DATE,direction:DESC}){scenes{${FIELDS}}}}`;

function normalize(s) {
  // pick the widest image as the cover (catalogue art is the authority for the tile).
  const cover = (s.images || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;
  return {
    id: "stashdb:" + s.id,
    mediaType: "meta",
    title: s.title || "",
    performers: (s.performers || []).map((p) => p.as || p.performer?.name).filter(Boolean),
    studio: s.studio?.name || "",
    date: s.release_date || "",
    tags: (s.tags || []).map((t) => t.name).filter(Boolean),
    cover,
    duration: s.duration || null,
    // the scene's source page URLs (where it can be found). The aggregator forwards the first as _src so a
    // recognized host can resolve-on-play (yt-dlp); an unrecognized paysite page simply stays an index entry.
    urls: (s.urls || []).map((u) => u.url).filter(Boolean),
    license: "",                                   // metadata only — no content license claim
  };
}

export function createStashDB({ fetch: f, cache, apiKey, endpoint = ENDPOINT, perPage = 24 } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!doFetch) throw new Error("holo-xxx-stashdb: fetch required");
  const live = !!apiKey;                            // no key → disabled provider (hub drops it, never errors out)

  // NOTE on CORS: a browser fetch from the holo:// origin to stashdb.org may be blocked by CORS. In the native
  // host, route `doFetch` through the OS fetch proxy (same seam Holo Player's resolvers use) so the request is
  // server-side. Pass that proxying fetch in as `fetch:` — the provider logic is identical either way.
  async function run(query, variables, key) {
    const body = JSON.stringify({ query, variables });
    const fetcher = async () => {
      const r = await doFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ApiKey: apiKey }, body });
      if (!r.ok) throw new Error("stashdb " + r.status);
      const j = await r.json();
      return j?.data?.queryScenes?.scenes || [];
    };
    if (!cache) return fetcher();
    const { body: out } = await cache.through("stashdb|" + key, fetcher); return out;
  }

  return {
    id: "builtin:stashdb", name: "StashDB", kind: "open", mediaType: "meta", enabled: live, trust: 4,
    async search(q) {
      if (!live || !q?.trim()) return [];
      let scenes; try { scenes = await run(QUERY, { t: q.trim(), n: perPage }, "q:" + q.trim()); } catch { return []; }
      return (scenes || []).map(normalize).filter((s) => s.title);
    },
    // browse(page) → a page of newest scenes (no filter) for the bulk catalogue importer (holo-xxx-catalog).
    async browse(page = 0) {
      if (!live) return [];
      let scenes; try { scenes = await run(BROWSE, { p: page + 1, n: perPage }, "b:" + page); } catch { return []; }
      return (scenes || []).map(normalize).filter((s) => s.title);
    },
  };
}

export default { createStashDB };
if (typeof window !== "undefined") window.HoloXxxStashDB = { createStashDB };
