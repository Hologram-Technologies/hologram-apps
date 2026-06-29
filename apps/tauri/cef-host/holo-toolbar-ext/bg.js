// Hologram toolbar projector (service worker).
// P0: κ-read path settled (holo:// SW-fetch blocked; the host's localhost broker over http is the channel).
// P1: project a κ bookmark list onto Chrome's NATIVE bookmarks bar via chrome.bookmarks.
// P1.5: LIVE user data. The shell pushes its real bookmark κ-list to the host (cefQuery holo:bar:push); the
//       loopback broker serves it at /_holo/bar.json; this SW reads it over http (host_permissions
//       http://localhost/*) and projects it. Falls back to the bundled default list when the broker is empty.

const BROKER = ["http://localhost:8495/_holo/bar.json", "http://127.0.0.1:8495/_holo/bar.json"];

function findBar(tree) {
  const roots = (tree && tree[0] && tree[0].children) || [];
  return roots.find((c) => c.id === "1") || roots.find((c) => c.children) || null;
}

// a κ bar item {ref,label,icon,words,open,kind} → a native bookmark {title,url}.
function itemsToBookmarks(items) {
  return (items || []).map((it) => {
    const ref = String((it && it.ref) || "").replace(/^holo:\/\//, "");
    const open = it && it.open && String(it.open).indexOf("holo://") === 0 ? it.open : (ref ? "holo://" + ref : "");
    return { title: (it && it.label) || ref || open, url: open };
  }).filter((b) => b.url);
}

// readLive — fetch the user's live bar κ-list from the broker; [] if unavailable/empty.
async function readLive() {
  for (const u of BROKER) {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) continue;
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) return itemsToBookmarks(arr);
      return [];
    } catch (e) {}
  }
  return [];
}

async function bundled() {
  try { return ((await (await fetch(chrome.runtime.getURL("bookmarks.json"))).json()).items) || []; } catch (e) { return []; }
}

// projectBookmarks — mirror a {title,url}[] list onto the native bookmarks bar. Idempotent: clears our prior
// holo:// entries, recreates in order. Only touches holo:// bookmarks — never the user's own.
async function projectBookmarks(list) {
  const result = { at: Date.now(), removed: 0, created: 0, source: list && list.__src || "?", err: "" };
  try {
    const items = list || [];
    const tree = await chrome.bookmarks.getTree();
    const bar = findBar(tree);
    if (!bar) { result.err = "bookmarks bar not found"; }
    else {
      const kids = await chrome.bookmarks.getChildren(bar.id);
      for (const k of kids) { if (k.url && k.url.indexOf("holo://") === 0) { await chrome.bookmarks.remove(k.id); result.removed++; } }
      for (const it of items) { if (it && it.url) { await chrome.bookmarks.create({ parentId: bar.id, title: it.title || it.url, url: it.url }); result.created++; } }
    }
  } catch (e) { result.err = String((e && e.message) || e); }
  try { await chrome.storage.local.set({ holoBookmarksProjected: result }); } catch (e) {}
  return result;
}

// boot — prefer the LIVE list (broker); fall back to the bundled default so the bar is never empty.
async function boot() {
  let list = await readLive(); let src = "live";
  if (!list.length) { list = await bundled(); src = "bundled"; }
  list.__src = src;
  return projectBookmarks(list);
}

boot();
try { chrome.runtime.onInstalled.addListener(boot); } catch (e) {}
try { chrome.runtime.onStartup.addListener(boot); } catch (e) {}
// Wake on navigation (the shell loading / pushing its bar) and re-sync — idempotent, so repeated wakes are safe.
try { chrome.webNavigation.onCompleted.addListener(() => { boot(); }); } catch (e) {}
try { chrome.runtime.onMessage.addListener((m, _s, reply) => { if (m === "holo:project") { boot().then(reply); return true; } }); } catch (e) {}
