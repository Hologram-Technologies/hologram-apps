// P2 — the Hologram action popup IS the κ app-rail. The toolbar action icon sits right of the address bar
// (native Chrome UI); clicking it shows a grid of κ apps. v1 reads the bundled κ list (a projection of the
// catalog, shared with the bookmarks bar); P2.5 swaps it for the live broker-fed catalog. A tile opens its
// app by navigating to the app's holo:// address — the κ scheme + OS resolve and open it.
(function () {
  var grid = document.getElementById("grid");
  function hue(s) { var h = 0; s = String(s || "?"); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
  function open(url) { try { chrome.tabs.create({ url: url }); } catch (e) { try { window.open(url, "_blank"); } catch (x) {} } window.close(); }

  fetch(chrome.runtime.getURL("bookmarks.json"))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var items = (data && data.items) || [];
      if (!items.length) { grid.textContent = "No apps yet."; return; }
      items.forEach(function (it) {
        if (!it || !it.url) return;
        var b = document.createElement("button");
        b.className = "tile"; b.title = it.title || it.url;
        var chip = document.createElement("span"); chip.className = "chip";
        if (it.icon && /\.(svg|png|webp|ico|jpe?g|gif)$/i.test(it.icon)) {
          var img = document.createElement("img"); img.src = it.icon; img.alt = ""; chip.appendChild(img);
        } else {
          chip.style.background = "hsl(" + hue(it.title || it.url) + ",52%,46%)";
          chip.textContent = (String(it.title || "?").trim().charAt(0) || "?").toUpperCase();
        }
        var lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = it.title || it.url;
        b.appendChild(chip); b.appendChild(lbl);
        b.addEventListener("click", function () { open(it.url); });
        grid.appendChild(b);
      });
    })
    .catch(function (e) { grid.textContent = "couldn't load apps: " + (e.message || e); });

  var m = document.getElementById("manage");
  if (m) m.addEventListener("click", function () { open("holo://os/usr/share/frame/extensions.html"); });
})();
