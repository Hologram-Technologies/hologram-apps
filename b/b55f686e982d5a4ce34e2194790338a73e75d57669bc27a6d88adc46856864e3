// holo-providers.mjs — the Provider Registry (HOLO-ANIMATE-PLATFORM, M2). Nixpacks-shaped, but grounded on the
// Realizer Ladder: each provider knows a language/framework and emits the LIGHTEST tier that runs it +
// a deterministic recipe (build/install/start/port/output). `detectProvider(files,pkg)` walks providers
// most-specific → least and returns the first match — so "how to run this repo" is one decision, extensible
// by adding a provider (not editing a giant if-tree). The tier feeds holo-animate's ladder; the recipe feeds
// holo-provision. Pure + isomorphic (Node + browser identical). This is what makes "any repo just works".
//
// Tiers: R0 inline (static, instant) · R1 build-then-inline (client SPA/SSG, in-tab) · R3 vm (server/native).
// (R2 wasm-runtime is reserved; providers may target it later for pure-compute runtimes.)

export const VERSION = "holo-providers/0.2.0";

// ── ctx helpers over a files Map<path,{text}|Buffer|string> + parsed package.json ─────────────────────────
function makeCtx(files, pkg) {
  const paths = [...files.keys()].map((p) => p.replace(/^\.?\//, ""));
  const set = new Set(paths);
  // truly isomorphic: `Buffer` is a Node global — guard it (a bare `Buffer.isBuffer` is a ReferenceError in
  // a browser/service-worker, which broke the claimed Node+browser parity); bytes decode via TextDecoder.
  const isBuf = (f) => typeof Buffer !== "undefined" && Buffer.isBuffer(f);
  const dec = (b) => { try { return new TextDecoder().decode(b); } catch { return null; } };
  const text = (p) => { const f = files.get(p) || files.get(p.replace(/^/, "")); if (f == null) return null; if (typeof f === "string") return f; if (isBuf(f)) return f.toString("utf8"); if (f instanceof Uint8Array) return dec(f); return f.text != null ? f.text : (f.bytes ? dec(f.bytes) : null); };
  const has = (re) => paths.some((p) => re.test(p));
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const depNames = Object.keys(deps);
  const dep = (list) => depNames.some((d) => list.includes(d));
  const scripts = (pkg && pkg.scripts) || {};
  const scriptText = Object.values(scripts).join(" ; ");
  const rootHtml = ["index.html", "public/index.html", "dist/index.html", "docs/index.html", "build/index.html", "_site/index.html"].find((p) => set.has(p)) || null;
  return { paths, set, has, text, pkg, deps, depNames, dep, scripts, scriptText, rootHtml };
}

const BUNDLERS = ["vite", "webpack", "rollup", "parcel", "esbuild", "snowpack", "@vitejs/plugin-react", "react-scripts", "@angular/cli", "@builder.io/qwik"];
const CLIENT_FW = ["react", "react-dom", "vue", "preact", "svelte", "solid-js", "@angular/core", "lit", "alpinejs"];
const SSR_FW = { next: "next", nuxt: "nuxt", "@remix-run/dev": "remix", astro: "astro", "@sveltejs/kit": "sveltekit", gatsby: "gatsby" };
const SERVER = ["express", "fastify", "koa", "hapi", "@nestjs/core", "socket.io", "ws", "@hapi/hapi", "polka", "restify"];

// each provider: { name, tier, detect(ctx)→bool, recipe(ctx)→{...} }. Order = priority (first match wins).
// Order note: CLIENT app providers (next/ssr/node-spa/static) are evaluated BEFORE the container providers
// (docker-compose/dockerfile) on purpose. A great many client games ship a Dockerfile/compose.yml for CI or
// self-hosting even though the app itself is a pure in-browser bundle — letting Docker win there needlessly
// forces a whole VM (R3) for something that runs as R1/R0 in a tab. So we detect the runnable client surface
// first and only fall to a container when there is NO lighter way to run it (genuine polyglot/server apps).
export const PROVIDERS = [
  { name: "next", tier: "R3", detect: (c) => c.dep(["next"]),
    recipe: (c) => { const exp = /output\s*:\s*["']export["']/.test(c.text("next.config.js") || c.text("next.config.mjs") || "") || /next export/.test(c.scriptText);
      return exp ? { tier: "R1", install: ["npm ci"], build: "npm run build", output: "out", start: null, port: 0 } : { install: ["npm ci"], build: "npm run build", start: "npm start", port: 3000 }; } },

  { name: "ssr-framework", tier: "R3", detect: (c) => Object.keys(SSR_FW).some((d) => c.dep([d])),
    recipe: (c) => { const fw = Object.entries(SSR_FW).find(([d]) => c.dep([d]))[1];
      const staticBuild = fw === "astro" || fw === "gatsby";   // these have a first-class static build
      return staticBuild ? { tier: "R1", install: ["npm ci"], build: "npm run build", output: fw === "gatsby" ? "public" : "dist", start: null, port: 0 } : { install: ["npm ci"], build: "npm run build", start: "npm start", port: 3000, framework: fw }; } },

  { name: "node-spa", tier: "R1", detect: (c) => c.pkg && (c.dep(BUNDLERS) || c.dep(CLIENT_FW) || /\b(vite|webpack|rollup|parcel)\b/.test(c.scriptText) || c.has(/^src\/(main|index|App)\.[jt]sx?$/)),
    recipe: (c) => ({ install: [c.set.has("package-lock.json") ? "npm ci" : "npm install"], build: "esbuild", output: "dist", start: null, port: 0, bundler: (BUNDLERS.find((b) => c.dep([b])) || "esbuild") }) },

  // container providers sit BELOW the client providers (node-spa/static — see order note) so a client game that
  // merely ships a Dockerfile/compose for CI still animates as R1/R0, but ABOVE node-server + the language
  // providers so a genuine (possibly multi-service) server app runs via its own compose/Dockerfile recipe.
  { name: "docker-compose", tier: "R3", detect: (c) => c.has(/^(docker-)?compose\.ya?ml$/),
    recipe: () => ({ base: "docker-in-guest", needsDocker: true, install: [], build: null, start: "docker compose up --build", port: 0 }) },

  { name: "dockerfile", tier: "R3", detect: (c) => c.set.has("Dockerfile"),
    recipe: (c) => { const t = c.text("Dockerfile") || ""; const port = (t.match(/EXPOSE\s+(\d+)/i) || t.match(/ENV\s+PORT[=\s]+(\d+)/i) || t.match(/-p\s+(\d{2,5})\b/) || t.match(/PORT[=:\s]+(\d{2,5})\b/) || [])[1] * 1 || 8080;
      return { base: "docker-in-guest", needsDocker: true, install: [], build: "docker build -t holo/app .", start: "docker run holo/app", port }; } },

  { name: "node-server", tier: "R3", detect: (c) => c.dep(SERVER) && !c.rootHtml,
    recipe: (c) => ({ install: [c.set.has("package-lock.json") ? "npm ci" : "npm install"], build: c.scripts.build ? "npm run build" : null, start: c.scripts.start ? "npm start" : ("node " + ((c.pkg && c.pkg.main) || (c.set.has("server.js") ? "server.js" : c.set.has("app.js") ? "app.js" : "index.js"))), port: 3000 }) },

  { name: "jekyll", tier: "R1", detect: (c) => c.set.has("_config.yml") || c.set.has("_config.yaml"),
    recipe: () => ({ base: "ruby", install: ["bundle install"], build: "bundle exec jekyll build", output: "_site", start: null, port: 0 }) },

  { name: "hugo", tier: "R1", detect: (c) => c.set.has("config.toml") || c.set.has("hugo.toml") || c.has(/^(archetypes|content)\//),
    recipe: () => ({ base: "hugo", install: [], build: "hugo --minify", output: "public", start: null, port: 0 }) },

  // require a real Python app marker (deps manifest or a root app entry) — NOT merely "some .py exists", which
  // false-matched JS/native repos that ship Python build/tooling scripts (e.g. a game engine's helper scripts).
  { name: "python", tier: "R3", detect: (c) => c.has(/^(requirements\.txt|pyproject\.toml|Pipfile|manage\.py|setup\.py)$/) || ["app.py", "main.py", "wsgi.py", "server.py", "application.py"].some((f) => c.set.has(f)),
    recipe: (c) => { const pip = "python3 -m pip install --break-system-packages";   // Alpine PEP668 + python3 (no `python`/`pip` on PATH)
      const reqs = c.text("requirements.txt") || ""; const mod = (["app.py", "main.py", "wsgi.py", "server.py", "application.py"].find((f) => c.set.has(f)) || "app.py").replace(/\.py$/, "");
      // the Procfile `web:` line is the app author's authoritative start (as every PaaS honors) — force the bind.
      const proc = (c.text("Procfile") || "").match(/^web:\s*(.+)$/m)?.[1]?.trim();
      const forceBind = (cmd) => /gunicorn/.test(cmd) ? cmd + " --bind 0.0.0.0:8000" : /uvicorn/.test(cmd) ? cmd + " --host 0.0.0.0 --port 8000" : cmd;
      // force 0.0.0.0:8000 (12-factor: apps must bind the forwarded port) — the universal deploy constraint.
      const start = proc ? forceBind(proc)
        : c.set.has("manage.py") ? "python3 manage.py runserver 0.0.0.0:8000"
        : /uvicorn|fastapi/i.test(reqs) ? "python3 -m uvicorn " + mod + ":app --host 0.0.0.0 --port 8000"
        : /flask/i.test(reqs) ? "FLASK_APP=" + mod + " python3 -m flask run --host 0.0.0.0 --port 8000"
        : /gunicorn/i.test(reqs) ? "gunicorn " + mod + ":app --bind 0.0.0.0:8000"
        : "python3 " + mod + ".py";
      return { base: "python", install: c.set.has("requirements.txt") ? [pip + " -r requirements.txt"] : c.set.has("pyproject.toml") ? [pip + " ."] : [pip + " pipenv && pipenv install"], build: null, start, port: 8000 }; } },

  { name: "deno", tier: "R3", detect: (c) => c.set.has("deno.json") || c.set.has("deno.jsonc") || c.has(/^deps\.ts$/),
    recipe: (c) => ({ base: "deno", install: [], build: null, start: "deno run -A " + (c.set.has("main.ts") ? "main.ts" : c.set.has("server.ts") ? "server.ts" : "mod.ts"), port: 8000 }) },

  { name: "bun", tier: "R3", detect: (c) => c.set.has("bun.lockb") || c.set.has("bunfig.toml"),
    recipe: (c) => ({ base: "bun", install: ["bun install"], build: c.scripts.build ? "bun run build" : null, start: c.scripts.start ? "bun run start" : "bun " + ((c.pkg && c.pkg.main) || "index.ts"), port: 3000 }) },

  { name: "elixir-phoenix", tier: "R3", detect: (c) => c.set.has("mix.exs"),
    recipe: () => ({ base: "elixir", install: ["mix deps.get"], build: "mix compile", start: "mix phx.server", port: 4000 }) },

  { name: "dotnet", tier: "R3", detect: (c) => c.has(/\.csproj$/) || c.has(/\.sln$/),
    recipe: () => ({ base: "dotnet", install: ["dotnet restore"], build: "dotnet build -c Release", start: "dotnet run -c Release", port: 5000 }) },

  { name: "go", tier: "R3", detect: (c) => c.set.has("go.mod"),
    recipe: () => ({ base: "go", install: ["go mod download"], build: "go build -o /app/server .", start: "/app/server", port: 8080 }) },

  { name: "rust", tier: "R3", detect: (c) => c.set.has("Cargo.toml"),
    recipe: () => ({ base: "rust", install: [], build: "cargo build --release", start: "cargo run --release", port: 8080 }) },

  { name: "ruby", tier: "R3", detect: (c) => c.set.has("Gemfile"),
    recipe: (c) => ({ base: "ruby", install: ["bundle install"], build: null, start: /rails/.test(c.text("Gemfile") || "") ? "bundle exec rails server -b 0.0.0.0 -p 3000" : "bundle exec ruby app.rb", port: 3000 }) },

  { name: "php", tier: "R3", detect: (c) => c.set.has("composer.json") || c.set.has("index.php"),
    recipe: (c) => ({ base: "php", install: c.set.has("composer.json") ? ["composer install"] : [], build: null, start: "php -S 0.0.0.0:8000 -t .", port: 8000 }) },

  { name: "java", tier: "R3", detect: (c) => c.set.has("pom.xml") || c.set.has("build.gradle") || c.set.has("build.gradle.kts"),
    recipe: (c) => ({ base: "java", install: [], build: c.set.has("pom.xml") ? "mvn -q package -DskipTests" : "gradle build -x test", start: "java -jar $(ls target/*.jar build/libs/*.jar 2>/dev/null | head -1)", port: 8080 }) },

  { name: "static", tier: "R0", detect: (c) => !!c.rootHtml && !(c.pkg && (c.dep(BUNDLERS) || c.has(/^src\/(main|index|App)\.[jt]sx?$/))),
    recipe: (c) => ({ install: [], build: null, start: null, entry: c.rootHtml, port: 0 }) },

  { name: "library", tier: "none", detect: (c) => c.pkg && (c.pkg.bin || (c.pkg.main && !c.rootHtml)) && !c.dep(CLIENT_FW),
    recipe: () => ({ reason: "a library/CLI — no browser-renderable surface to run" }) },
];

// detectProvider(files, pkg?) → { provider, tier, recipe, why }. pkg is parsed if not passed.
export function detectProvider(files, pkg = undefined) {
  if (pkg === undefined) { try { const pf = files.get("package.json"); const t = pf && (typeof pf === "string" ? pf : pf.text); pkg = t ? JSON.parse(t) : null; } catch { pkg = null; } }
  const c = makeCtx(files, pkg);
  for (const p of PROVIDERS) {
    let ok = false; try { ok = !!p.detect(c); } catch { ok = false; }
    if (ok) { const r = p.recipe(c) || {}; const tier = r.tier || p.tier; return { provider: p.name, tier, recipe: { kind: p.name, ...r, tier }, why: describe(p.name, tier) }; }
  }
  return { provider: "unknown", tier: "none", recipe: { kind: "unknown", reason: "no recognized language/framework or app entry" }, why: "unclassifiable — surfaced, never guessed" };
}
function describe(name, tier) {
  const t = { R0: "static — inline, instant", R1: "client app — compile in-tab", R3: "server/native — run in a VM", none: "not a runnable app" }[tier];
  return name + " → " + t;
}

// coverage() → the provider list (for the store to show "we understand N stacks") ─────────────────────────
export const coverage = () => PROVIDERS.map((p) => ({ name: p.name, tier: p.tier }));

export function describeProviders() {
  return { is: "the Provider Registry — Nixpacks-shaped detection grounded on the Realizer Ladder; each provider emits the lightest tier + a deterministic recipe",
    extensible: "add a language/framework by adding one provider entry; detection is ordered most-specific → least, first match wins",
    tiers: "R0 static/instant · R1 client compile in-tab · R3 server/native in a VM (R2 wasm reserved)" };
}

export default { VERSION, PROVIDERS, detectProvider, coverage, describeProviders };
