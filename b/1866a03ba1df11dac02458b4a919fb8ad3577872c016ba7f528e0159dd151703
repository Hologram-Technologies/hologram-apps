// Witness: holo-ladder — the serverless paywall bypass. Detection, in-place unlock (JSON-LD reader,
// overlay/scroll-lock neutralize, metering-script drop), per-host rules, archive sources, rung-3
// header spoof. Pure/offline — no wire. Run: node ladder.witness.mjs
import { detectPaywall, unlock, ruleFor, archiveSources, ladderHeaders } from "./_shared/holo-ladder.mjs";

const results = []; const ok = (n, c) => { results.push([n, c]); console.log((c ? "✓ " : "✗ ") + n); };
const URL_NYT = "https://www.nytimes.com/2024/01/01/world/story.html";
const URL_PLAIN = "https://example.com/blog/free-post";

const BODY = ("First paragraph with plenty of substance to clear the length gate and prove the reader reconstructs the body. " +
  "It runs well past four hundred characters so the substantial-body test is unambiguous.\n\n" +
  "Second paragraph continues the reporting with more detail so the recovered text is unmistakably the real article, " +
  "carrying the phrase clear the length gate that the witness looks for, plus enough words to be a genuine article body.");
const mkDoc = (headline) => `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline, author: { name: "Jane Reporter" }, datePublished: "2024-01-01", isAccessibleForFree: false, articleBody: BODY })}</script>
</head><body><div class="paywall-overlay">Subscribe to continue</div><article class="article-body--truncated">First paragraph…</article>
<script src="https://cdn.tinypass.com/api/tinypass.min.js"></script></body></html>`;
const LOCKED_LDJSON = mkDoc("The Big Story");

const FREE = `<!doctype html><html><head></head><body><article><p>Free content, no wall here at all.</p></article></body></html>`;

// ── detection ──
{ const d = detectPaywall(LOCKED_LDJSON, URL_NYT); ok("detect: locked doc flagged", d.locked && d.why.length > 0); }
{ const d = detectPaywall(FREE, URL_PLAIN); ok("detect: free doc NOT flagged", !d.locked); }
{ const d = detectPaywall(`<meta property="article:content_tier" content="locked">`, URL_PLAIN); ok("detect: content_tier=locked", d.locked); }
// REGRESSION (real, from the live scorecard): a free article that merely LOADS Piano/tinypass for a
// newsletter/consent (BBC) must NOT be flagged — a vendor meter present ≠ this page is walled.
{ const bbc = `<!doctype html><html><head><script src="https://cdn.tinypass.com/api/tinypass.min.js"></script></head><body><div class="tp-modal" style="display:none"></div><article><p>Free BBC news article, fully readable, no wall.</p></article></body></html>`;
  const d = detectPaywall(bbc, "https://www.bbc.com/news/x"); ok("detect: vendor-meter-only NOT flagged (no false defacing)", !d.locked);
  ok("unlock: free-with-vendor-meter untouched", unlock(bbc, "https://www.bbc.com/news/x").html === bbc); }

// ── rung 1: in-place unlock ──
{ const u = unlock(LOCKED_LDJSON, URL_NYT);
  ok("unlock: recovers body from JSON-LD", u.recovered && u.html.includes("holo-ladder-reader"));
  ok("unlock: reader carries real article text", u.html.includes("clear the length gate"));
  ok("unlock: headline + byline rendered", u.html.includes("The Big Story") && u.html.includes("Jane Reporter"));
  ok("unlock: neutralize CSS injected", u.html.includes("holo-ladder-css"));
  ok("unlock: metering script dropped", !u.html.includes("tinypass.min.js"));
  ok("unlock: labeled applied steps", u.applied.includes("reader:ld+json") && u.applied.includes("strip-scripts")); }

// idempotent — a second pass over already-unlocked HTML must NOT inject a second reader/CSS
{ const once = unlock(LOCKED_LDJSON, URL_NYT).html; const twice = unlock(once, URL_NYT).html;
  ok("unlock: idempotent (no double reader)", (twice.match(/id="holo-ladder-reader"/g) || []).length === 1 && (twice.match(/id="holo-ladder-css"/g) || []).length === 1); }

// free doc in AUTO passes through untouched; forced unlock still neutralizes
{ const u = unlock(FREE, URL_PLAIN); ok("unlock: free doc untouched in auto", !u.locked && u.html === FREE); }
{ const u = unlock(FREE, URL_PLAIN, { force: true }); ok("unlock: force injects neutralize even when free", u.html.includes("holo-ladder-css")); }

// escaping — a hostile headline must be escaped when WE inject it into the reader panel
{ const u = unlock(mkDoc("Evil <img src=x onerror=alert(1)> Headline"), URL_NYT);
  const at = u.html.indexOf('id="holo-ladder-reader"'); const panel = u.html.slice(at, at + 2000);
  ok("unlock: reader-injected headline HTML-escaped", panel.includes("Evil &lt;img") && !/<img src=x onerror/.test(panel)); }

// ── per-host rules ──
{ ok("rule: nytimes matched", !!ruleFor(URL_NYT) && ruleFor(URL_NYT).host === "nytimes.com"); }
{ ok("rule: unknown host → none", ruleFor(URL_PLAIN) === null); }
{ const u = unlock(LOCKED_LDJSON, "https://www.wsj.com/x"); ok("rule: wsj kill-css applied", u.html.includes("holo-ladder-rule")); }

// ── rung 2: archive sources ──
{ const a = archiveSources(URL_NYT);
  ok("archive: wayback first", a[0].via === "wayback" && a[0].api.includes("archive.org/wayback/available"));
  ok("archive: includes archive.today + reader", a.some((s) => s.via === "archive.today") && a.some((s) => s.via === "reader")); }

// ── rung 3: header spoof shape ──
{ const h = ladderHeaders(URL_NYT);
  ok("headers: googlebot UA", /Googlebot/i.test(h["x-holo-ua"]));
  ok("headers: google referer + xff", h["x-holo-referer"].includes("google.com") && h["x-holo-xff"] === "66.249.66.1"); }

const pass = results.filter((r) => r[1]).length;
console.log("\n" + pass + "/" + results.length + (pass === results.length ? "  ALL GREEN" : "  — FAIL"));
process.exit(pass === results.length ? 0 : 1);
