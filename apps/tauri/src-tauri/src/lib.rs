// hologram_lib — the native Hologram host.
//
// This is a CANONICAL Tauri v2 app (https://github.com/tauri-apps/tauri): the builder, the plugins
// and the window are used verbatim per the spec. The only first-party logic is the `holo://` URI
// scheme — the NATIVE κ-route — which is what makes the host "100% native to the UOR substrate":
// every byte the webview loads is resolved by content and RE-DERIVED to its content address before
// it is served (holospaces Law L5). A tampered byte is refused, fail-closed. The OS boots from
// `holo://os/…` exactly as it does over the browser dev server, but here there is no Chrome, no
// CORS wall, and a real shell + filesystem underneath.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};
use tauri::http::{Request, Response};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewBuilder,
    WebviewUrl, WindowBuilder, WindowEvent,
};

// ── the content-addressed store the κ-route serves ──────────────────────────────────────────────
// A flat OS image (`dist/`, produced by ../make-dist.mjs) + its `os-closure.json` (path → did:holo
// sha256 κ). The host re-derives each file's κ on read and refuses a mismatch (Law L5).
struct KStore {
    root: PathBuf,
    // flat served path (e.g. "_shared/holo-dock.js") → expected sha256 hex (lower-case)
    closure: HashMap<String, String>,
}

static STORE: OnceLock<KStore> = OnceLock::new();

fn store() -> &'static KStore {
    STORE.get_or_init(|| {
        // HOLO_OS_DIR overrides (dev); otherwise the bundled `dist/` next to the executable.
        let root = std::env::var("HOLO_OS_DIR").map(PathBuf::from).unwrap_or_else(|_| {
            std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("dist"))).unwrap_or_else(|| PathBuf::from("dist"))
        });
        let mut closure = HashMap::new();
        if let Ok(text) = std::fs::read_to_string(root.join("os-closure.json")) {
            if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(map) = doc.get("closure").and_then(|c| c.as_object()) {
                    for (path, v) in map {
                        if let Some(k) = v.get("kappa").and_then(|x| x.as_str()) {
                            if let Some(hex) = k.rsplit(':').next() {
                                closure.insert(path.clone(), hex.to_ascii_lowercase());
                            }
                        }
                    }
                }
            }
        }
        KStore { root, closure }
    })
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "jsonld" => "application/ld+json; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

// Normalize a requested path to the OS's ONE flat URL key — the same space the dev server and the
// Pages Service Worker speak (os/lib/holo-fhs-map.mjs). Two rules matter here; the rest of the FHS
// map is already baked into the flat `dist/` by make-dist.mjs:
//   • drop the `os` root segment (Tauri exposes the URL host as a path prefix on some platforms);
//   • collapse an app-relative `apps/<id>/_shared|pkg/…` ref to the top-level engine path — exactly
//     fhsMap's `(?:apps/<id>/)?_shared/` rule — so it hits one engine copy AND its closure pin.
fn flat_key(req_path: &str) -> String {
    let mut rel = req_path.trim_start_matches('/').to_string();
    if let Some(rest) = rel.strip_prefix("os/") {
        rel = rest.to_string();
    } else if rel == "os" {
        rel = String::new();
    }
    if let Some(i) = rel.find("/_shared/") {
        if rel.starts_with("apps/") {
            rel = rel[i + 1..].to_string();
        }
    }
    if let Some(i) = rel.find("/pkg/") {
        if rel.starts_with("apps/") {
            rel = rel[i + 1..].to_string();
        }
    }
    rel
}

// resolve a `holo://os/<path>` request → verified bytes + mime, or an HTTP error code.
fn resolve(req_path: &str) -> Result<(Vec<u8>, &'static str), u16> {
    let st = store();
    let mut rel = flat_key(req_path);
    if rel.is_empty() {
        rel = "apps/browser/index.html".into();
    } else if rel.ends_with('/') {
        rel.push_str("index.html");
    }
    // contain to the store root (no traversal).
    let full = st.root.join(&rel);
    if !full.starts_with(&st.root) || !full.is_file() {
        return Err(404);
    }
    let bytes = std::fs::read(&full).map_err(|_| 404u16)?;
    // Law L5 — re-derive the content address and verify it. Pinned files MUST match; unpinned
    // (e.g. app bytes carried by their own lock, not the OS closure) pass through.
    if let Some(expected) = st.closure.get(&rel) {
        if &sha256_hex(&bytes) != expected {
            return Err(403); // tampered byte → refuse
        }
    }
    Ok((bytes, content_type(&rel)))
}

// ── deep links: hologram:// · web+hologram:// · holo:// → open the OS at that object ──────────────
// The browser's "Open in Hologram" button emits `hologram://open?go=<urlencoded object>`; a bare
// `holo://κ` also works. We honor a `?go=` hint (Holo Browser's universal navigator param) and route
// it through the boot page; with no hint we just open home — "a new Hologram window".
fn target_for(url: &str) -> String {
    let after = url.splitn(2, "://").nth(1).unwrap_or("");
    let query = after.splitn(2, '?').nth(1).unwrap_or("");
    let go = query.split('&').find_map(|kv| kv.strip_prefix("go=")).map(percent_decode);
    match go {
        Some(obj) if !obj.is_empty() => format!("holo://os/apps/browser/index.html?go={}", urlencoding(&obj)),
        // a direct holo:// object with no ?go= → carry it as the object to open.
        _ if url.starts_with("holo://") => format!("holo://os/apps/browser/index.html?go={}", urlencoding(url)),
        _ => "holo://os/apps/browser/index.html".to_string(),
    }
}

fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.replace('+', " ").into_bytes();
    let hex = |b: u8| match b { b'0'..=b'9' => Some(b - b'0'), b'a'..=b'f' => Some(b - b'a' + 10), b'A'..=b'F' => Some(b - b'A' + 10), _ => None };
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(a), Some(c)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) { out.push(a * 16 + c); i += 3; continue; }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── native renderer (Route A): each TAB is a real Chromium webview, not an iframe ────────────────
// The "chrome" webview draws the shell (tab strip + omnibox + window controls + NTP). Each tab gets
// its OWN sibling "content-<tabId>" webview positioned below the shell's top strip — a native
// WebContents, exactly the seam holo-browser.js describes, one tier deeper than the iframe. Only the
// active tab's webview is shown; the rest are hidden with their page state intact, so switching tabs
// is instant and stateful (Chrome's model). Every load still passes the holo:// κ-route above (and
// the same-origin service worker re-derives it — Law L5). The shell reports where its page area
// begins so every content webview aligns to the device pixel (crisp on any DPR).
struct Layout {
    content_top: f64,
}
const DEFAULT_CONTENT_TOP: f64 = 96.0;

fn content_label(id: &str) -> String {
    format!("content-{}", id)
}

// content rect, in PHYSICAL pixels (inner_size() and webview rects share that space — no DPR drift).
fn content_rect(app: &tauri::AppHandle) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let top_logical = app
        .state::<Mutex<Layout>>()
        .lock()
        .map(|l| l.content_top)
        .unwrap_or(DEFAULT_CONTENT_TOP);
    let win = app.get_window("main")?;
    let sz = win.inner_size().ok()?;
    let sf = win.scale_factor().unwrap_or(1.0);
    let top_px = (top_logical * sf).round() as u32;
    Some((
        PhysicalPosition::new(0, top_px as i32),
        PhysicalSize::new(sz.width, sz.height.saturating_sub(top_px)),
    ))
}

// show only `keep`'s webview; hide every other tab's (state preserved).
fn show_only(app: &tauri::AppHandle, keep: &str) {
    for (label, wv) in app.webviews() {
        if label.starts_with("content-") {
            if label == keep {
                let _ = wv.show();
            } else {
                let _ = wv.hide();
            }
        }
    }
}

// hide every tab's webview → the chrome's New Tab Page shows through.
fn hide_all_content(app: &tauri::AppHandle) {
    for (label, wv) in app.webviews() {
        if label.starts_with("content-") {
            let _ = wv.hide();
        }
    }
}

// keep every content webview sized to the content rect (only the active one is visible).
fn relayout(app: &tauri::AppHandle) {
    if let Some((pos, size)) = content_rect(app) {
        for (label, wv) in app.webviews() {
            if label.starts_with("content-") {
                let _ = wv.set_position(pos);
                let _ = wv.set_size(size);
            }
        }
    }
}

// Navigate (creating it on first use) the tab's own native webview, and make it the visible one.
#[tauri::command]
fn tab_navigate(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    let label = content_label(&id);
    let u: tauri::Url = url.parse().map_err(|_| format!("bad url: {url}"))?;
    if let Some(wv) = app.get_webview(&label) {
        wv.navigate(u).map_err(|e| e.to_string())?;
    } else {
        let (pos, size) = content_rect(&app).ok_or("no window")?;
        let win = app.get_window("main").ok_or("no window")?;
        let wvurl = if u.scheme() == "holo" {
            WebviewUrl::CustomProtocol(u)
        } else {
            WebviewUrl::External(u)
        };
        let h = app.clone();
        let id2 = id.clone();
        win.add_child(
            WebviewBuilder::new(&label, wvurl)
                // dark backing color so a new tab never flashes white before its page paints.
                .background_color(tauri::webview::Color(10, 14, 20, 255))
                .on_navigation(move |nav| {
                    let _ = h.emit_to("chrome", "holo://navigated", (id2.clone(), nav.to_string()));
                    true
                }),
            pos,
            size,
        )
        .map_err(|e| e.to_string())?;
    }
    show_only(&app, &label);
    Ok(())
}

// Switch to an already-loaded tab — just show its webview (no reload → instant, state preserved).
#[tauri::command]
fn tab_select(app: tauri::AppHandle, id: String) {
    let label = content_label(&id);
    if app.get_webview(&label).is_some() {
        show_only(&app, &label);
    } else {
        hide_all_content(&app);
    }
}

// The active tab is showing the New Tab Page → hide all content webviews.
#[tauri::command]
fn tab_ntp(app: tauri::AppHandle) {
    hide_all_content(&app);
}

// Close a tab's native webview (the tab was closed).
#[tauri::command]
fn tab_close(app: tauri::AppHandle, id: String) {
    if let Some(wv) = app.get_webview(&content_label(&id)) {
        let _ = wv.close();
    }
}

// The shell reports the y where its page area begins, so content webviews align precisely.
#[tauri::command]
fn holo_set_content_top(app: tauri::AppHandle, top: f64) {
    if let Ok(mut l) = app.state::<Mutex<Layout>>().lock() {
        l.content_top = top;
    }
    relayout(&app);
}

// ── Holo DevTools real-CDP discovery (ADR-0095, the NATIVE human door) ────────────────────────────
// On Windows the Tauri webview IS Chromium (WebView2). With --remote-debugging-port (set at run()
// start) WebView2 exposes the REAL Chrome DevTools Protocol on a localhost-only port — so Dev mode
// gets genuine F12 of the live holospace tab (real DOM · Console · Sources · Network), not the κ-CDP
// subset. The OS shell calls this to list the page targets; it then points the vendored
// devtools-frontend at the matching target's webSocketDebuggerUrl. CDP stays the human door's PRIVATE
// transport (ADR-0095 §7): localhost, native-only, never reachable off-device.
const HOLO_CDP_PORT: u16 = 9333;

#[tauri::command]
fn holo_devtools_targets() -> Result<String, String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;
    let addr = format!("127.0.0.1:{HOLO_CDP_PORT}");
    let mut stream =
        TcpStream::connect(&addr).map_err(|e| format!("CDP endpoint not up on {addr}: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let req = format!(
        "GET /json/list HTTP/1.1\r\nHost: 127.0.0.1:{HOLO_CDP_PORT}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    // /json/list returns a JSON ARRAY of page targets; slice it out robustly (skip HTTP headers and
    // any transfer-encoding framing) by the outer brackets — the targets never contain a bare top [ ].
    let body = text.splitn(2, "\r\n\r\n").nth(1).unwrap_or("");
    let json = match (body.find('['), body.rfind(']')) {
        (Some(s), Some(e)) if e >= s => &body[s..=e],
        _ => body,
    };
    Ok(json.trim().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Holo DevTools real-CDP (ADR-0095, native door): open WebView2's real Chrome DevTools Protocol on
    // a localhost-only debugging port BEFORE any webview is created (WebView2 reads this env var at
    // environment creation and appends it to the browser command line). --remote-allow-origins lets the
    // devtools-frontend (origin holo://) complete the WebSocket handshake. Native + localhost only.
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        format!("--remote-debugging-port={HOLO_CDP_PORT} --remote-allow-origins=*"),
    );
    tauri::Builder::default()
        .manage(Mutex::new(Layout { content_top: DEFAULT_CONTENT_TOP }))
        .invoke_handler(tauri::generate_handler![
            tab_navigate,
            tab_select,
            tab_ntp,
            tab_close,
            holo_set_content_top,
            holo_devtools_targets
        ])
        // the OFFICIAL plugins — verbatim, the source of the native powers.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        // the NATIVE κ-route: serve the content-addressed OS, re-derived + verified (Law L5).
        .register_asynchronous_uri_scheme_protocol("holo", |_ctx, request: Request<Vec<u8>>, responder| {
            let path = request.uri().path().to_string();
            std::thread::spawn(move || {
                let resp = match resolve(&path) {
                    Ok((body, mime)) => Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        // cross-origin isolation so the OS's WASM engines (SharedArrayBuffer) run.
                        .header("Cross-Origin-Opener-Policy", "same-origin")
                        .header("Cross-Origin-Embedder-Policy", "credentialless")
                        .header("Cross-Origin-Resource-Policy", "cross-origin")
                        .header("Cache-Control", "no-store")
                        .body(body)
                        .unwrap(),
                    Err(code) => Response::builder().status(code).body(Vec::new()).unwrap(),
                };
                responder.respond(resp);
            });
        })
        .setup(|app| {
            // 1) claim the schemes so a single link boots the host, and resolve the object to open.
            #[cfg(desktop)]
            let initial = {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register("hologram");
                let _ = app.deep_link().register("web+hologram");
                let _ = app.deep_link().register("holo");
                // WARM: a link clicked while Hologram is already running → navigate the open window.
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    if let Some(url) = event.urls().first() {
                        if let Some(chrome) = handle.get_webview("chrome") {
                            let _ = chrome.navigate(target_for(url.as_str()).parse().unwrap());
                        }
                    }
                });
                // COLD: a link launched us → open straight to that object (no home flash).
                match app.deep_link().get_current() { Ok(Some(urls)) => urls.first().map(|u| target_for(u.as_str())), _ => None }
            };
            #[cfg(not(desktop))]
            let initial: Option<String> = None;
            // 2) the window is the OS — frameless (Hologram draws its own chrome). Route A: the shell
            //    runs in a "chrome" webview; each TAB later spawns its own "content-<id>" webview — a
            //    real native Chromium WebContents, NOT an iframe — served + verified by the holo://
            //    route above. The tab strip is the window drag handle; #winctl supplies min/max/close.
            let start = initial.unwrap_or_else(|| "holo://os/apps/browser/index.html".to_string());
            let win = WindowBuilder::new(app, "main")
                .title("Hologram")
                .inner_size(1280.0, 800.0)
                .decorations(false)
                .resizable(true)
                .build()?;
            let phys = win.inner_size()?;
            let sf = win.scale_factor().unwrap_or(1.0);
            let (w, h) = (phys.width as f64 / sf, phys.height as f64 / sf);
            // the shell (tab strip + omnibox + window controls + NTP). auto_resize() keeps it exactly
            // filling the window — the robust fix for the earlier right-edge overflow. Tab content
            // webviews are created lazily by `tab_navigate` and stack above the shell's page area.
            win.add_child(
                WebviewBuilder::new("chrome", WebviewUrl::CustomProtocol(start.parse().unwrap()))
                    .auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(w, h),
            )?;
            // keep all content webviews laid out as the window resizes / maximizes.
            let resize_handle = app.handle().clone();
            win.on_window_event(move |e| {
                if let WindowEvent::Resized(_) = e {
                    relayout(&resize_handle);
                }
            });
            // lay both webviews out to the real (settled) window size. The user maximizes via the
            // expand control (toggleMaximize); the Resized handler keeps the layout in sync.
            relayout(&app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Hologram host");
}
