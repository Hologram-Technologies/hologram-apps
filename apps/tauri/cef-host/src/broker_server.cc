// broker_server.cc — see header. Minimal blocking HTTP/1.1 static server on 127.0.0.1 (Winsock).
#include "broker_server.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <mutex>

#pragma comment(lib, "ws2_32.lib")

namespace holo {
namespace {

std::mutex g_bar_mu;
std::string g_bar_json = "[]";  // live bar κ-list; set by the host, served at /_holo/bar.json


std::string MimeOf(const std::string& path) {
  auto ends = [&](const char* s) { const size_t n = std::char_traits<char>::length(s); return path.size() >= n && path.compare(path.size() - n, n, s) == 0; };
  if (ends(".html")) return "text/html; charset=utf-8";
  if (ends(".mjs") || ends(".js")) return "text/javascript; charset=utf-8";
  if (ends(".json") || ends(".jsonld")) return "application/json; charset=utf-8";
  if (ends(".css")) return "text/css; charset=utf-8";
  if (ends(".wasm")) return "application/wasm";
  if (ends(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

// Path safelist: the broker page + the holo module dirs it imports. Nothing else is reachable.
bool Allowed(const std::string& p) {
  if (p.find("..") != std::string::npos) return false;        // no traversal
  if (p == "/usr/share/frame/stepup-broker.html") return true;
  if (p.rfind("/usr/lib/holo/", 0) == 0) return true;
  if (p.rfind("/_shared/", 0) == 0) return true;
  return false;
}

void Send(SOCKET c, const std::string& status, const std::string& ctype, const std::string& body) {
  std::ostringstream h;
  h << "HTTP/1.1 " << status << "\r\n"
    << "Content-Type: " << ctype << "\r\n"
    << "Content-Length: " << body.size() << "\r\n"
    << "Cache-Control: no-store\r\n"
    << "X-Content-Type-Options: nosniff\r\n"
    << "Access-Control-Allow-Origin: *\r\n"
    << "Connection: close\r\n\r\n";
  const std::string head = h.str();
  send(c, head.data(), static_cast<int>(head.size()), 0);
  if (!body.empty()) send(c, body.data(), static_cast<int>(body.size()), 0);
}

void Handle(SOCKET c, const std::string& root) {
  std::string req;
  char buf[4096];
  for (;;) {
    const int n = recv(c, buf, sizeof(buf), 0);
    if (n <= 0) break;
    req.append(buf, n);
    if (req.find("\r\n\r\n") != std::string::npos || req.size() > 16384) break;
  }
  // parse: GET <path> HTTP/1.1
  if (req.rfind("GET ", 0) != 0) { Send(c, "405 Method Not Allowed", "text/plain", ""); return; }
  const size_t sp = req.find(' ', 4);
  if (sp == std::string::npos) { Send(c, "400 Bad Request", "text/plain", ""); return; }
  std::string path = req.substr(4, sp - 4);
  const size_t q = path.find('?');
  if (q != std::string::npos) path = path.substr(0, q);
  if (path.find('\\') != std::string::npos) { Send(c, "400 Bad Request", "text/plain", ""); return; }
  if (path == "/_holo/bar.json") { std::lock_guard<std::mutex> lk(g_bar_mu); Send(c, "200 OK", "application/json; charset=utf-8", g_bar_json); return; }
  if (!Allowed(path)) { Send(c, "404 Not Found", "text/plain", ""); return; }

  std::string file = root + path;  // path begins with '/'
  std::ifstream f(file, std::ios::binary);
  if (!f) { Send(c, "404 Not Found", "text/plain", ""); return; }
  std::ostringstream ss; ss << f.rdbuf();
  Send(c, "200 OK", MimeOf(path), ss.str());
}

void ServerLoop(std::string root, int port) {
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return;
  SOCKET srv = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (srv == INVALID_SOCKET) { WSACleanup(); return; }
  BOOL reuse = TRUE;
  setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<u_short>(port));
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);  // LOOPBACK ONLY — never a routable address
  if (bind(srv, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 || listen(srv, SOMAXCONN) != 0) {
    closesocket(srv); WSACleanup(); return;
  }
  for (;;) {
    SOCKET c = accept(srv, nullptr, nullptr);
    if (c == INVALID_SOCKET) continue;
    Handle(c, root);
    closesocket(c);
  }
}

}  // namespace

void SetBrokerBarJson(const std::string& json) { std::lock_guard<std::mutex> lk(g_bar_mu); g_bar_json = json.empty() ? "[]" : json; }

void StartBrokerServer(const std::string& os_dir, int port) {
  std::thread(ServerLoop, os_dir, port).detach();
}

}  // namespace holo
