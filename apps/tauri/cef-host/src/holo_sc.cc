// holo_sc.cc — native streaming companion backend. <windows.h> is isolated to this translation unit.
#include "holo_sc.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <thread>

namespace {

std::string EnvOr(const char* var, const char* fallback) {
  if (const char* e = std::getenv(var)) {
    if (e[0]) return std::string(e);
  }
  return std::string(fallback);
}

// Open the null device as an inheritable handle so a child's unwanted stderr/stdin goes nowhere.
HANDLE OpenNul() {
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;
  return CreateFileA("NUL", GENERIC_WRITE | GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                     OPEN_EXISTING, 0, nullptr);
}

}  // namespace

std::string HoloYtDlpPath() { return EnvOr("HOLO_YTDLP", "yt-dlp"); }
std::string HoloFfmpegPath() { return EnvOr("HOLO_FFMPEG", "ffmpeg"); }

std::string HoloScCacheDir() {
  std::string dir;
  if (const char* e = std::getenv("HOLO_VCACHE")) {
    if (e[0]) dir = e;
  }
  if (dir.empty()) {
    char tmp[MAX_PATH];
    if (GetTempPathA(MAX_PATH, tmp)) dir = std::string(tmp) + "holo-vcache";
  }
  if (dir.empty()) return std::string();
  CreateDirectoryA(dir.c_str(), nullptr);  // ok if it already exists
  return dir;
}

bool HoloHasYtDlp() {
  if (const char* e = std::getenv("HOLO_YTDLP")) {
    if (e[0]) return GetFileAttributesA(e) != INVALID_FILE_ATTRIBUTES;
  }
  return true;  // assume "yt-dlp" resolves on PATH; a launch failure later fails closed gracefully
}

int HoloRunCapture(const std::string& cmdline, std::string& out, unsigned timeout_ms) {
  out.clear();

  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;
  HANDLE rd = nullptr, wr = nullptr;
  if (!CreatePipe(&rd, &wr, &sa, 0)) return -1;
  // The parent's read end must NOT be inherited by the child (else the pipe never reports EOF).
  SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
  HANDLE nul = OpenNul();

  STARTUPINFOA si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  si.hStdOutput = wr;
  si.hStdError = nul;
  si.hStdInput = nul;
  PROCESS_INFORMATION pi{};

  std::vector<char> mut(cmdline.begin(), cmdline.end());
  mut.push_back('\0');
  if (!CreateProcessA(nullptr, mut.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr,
                      &si, &pi)) {
    CloseHandle(rd);
    CloseHandle(wr);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    return -1;
  }
  CloseHandle(wr);  // parent keeps only the read end → ReadFile returns 0 when the child exits
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);

  // Drain stdout on a worker so a timeout can terminate a stuck child and unblock the read.
  std::string buf;
  std::thread reader([&]() {
    char chunk[8192];
    DWORD n = 0;
    while (ReadFile(rd, chunk, sizeof(chunk), &n, nullptr) && n > 0) buf.append(chunk, n);
  });

  const DWORD waited = WaitForSingleObject(pi.hProcess, timeout_ms ? timeout_ms : INFINITE);
  if (waited != WAIT_OBJECT_0) TerminateProcess(pi.hProcess, 1);
  reader.join();  // child gone (exited or terminated) ⇒ pipe broken ⇒ reader returns

  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  CloseHandle(rd);
  out.swap(buf);
  return (waited == WAIT_OBJECT_0) ? static_cast<int>(code) : -1;
}

namespace {

// A URL that could break command-line quoting (an embedded double quote) is refused, never escaped — same
// posture as holo_media: fail closed rather than risk an argument-injection.
bool SafeUrl(const std::string& u) {
  return !u.empty() && u.find('"') == std::string::npos && u.size() < 8192;
}

// Split captured stdout into trimmed non-empty https?:// lines (yt-dlp -g output).
std::vector<std::string> StreamLines(const std::string& blob) {
  std::vector<std::string> lines;
  std::istringstream ss(blob);
  std::string line;
  while (std::getline(ss, line)) {
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ')) line.pop_back();
    size_t i = 0;
    while (i < line.size() && line[i] == ' ') ++i;
    if (i) line = line.substr(i);
    if (line.rfind("http://", 0) == 0 || line.rfind("https://", 0) == 0) lines.push_back(line);
  }
  return lines;
}

}  // namespace

// Quality target: the BEST engine-decodable stream up to 1080p, at the HIGHEST bitrate. We deliberately cap
// at 1080 (not 4K/8K): this prebuilt CEF crashes the renderer on a true-4K non-seekable stream (~300 MB; it
// can't evict the buffer without HTTP range, which a CefResourceHandler 206 breaks), and 10-bit HDR (vp9.2)
// decode is unstable — so we prefer SDR and the highest 1080p bitrate, which IS pristine Full-HD and plays
// rock-solid. The selector is STRICT VP9/AV1 video + Opus audio (the only codecs this engine decodes — never
// an H.264 fallback that can't play). ffmpeg copy-muxes it losslessly (no quality lost vs the source).
bool HoloScResolveVideoUrls(const std::string& page_url, int height, std::vector<std::string>& urls) {
  if (!SafeUrl(page_url)) return false;
  const int h = std::min(2160, std::max(360, height ? height : 1080));  // handler sets the real ceiling
  const std::string hs = std::to_string(h);
  const std::string codec = "[vcodec~='^(vp0?9|av01)']";
  const std::string sdr = "[dynamic_range=SDR]";
  const std::string cmd =
      "\"" + HoloYtDlpPath() + "\""
      " -f \"bv*[height<=" + hs + "]" + codec + sdr + "+ba[acodec=opus]"
      "/bv*[height<=" + hs + "]" + codec + sdr + "+ba"
      "/bv*[height<=" + hs + "]" + codec + "+ba"
      "/bv*" + codec + sdr + "+ba\""
      " -S \"res,fps,br,vcodec:av01,vcodec:vp9,acodec:opus,abr\""
      " -g --no-warnings --no-playlist \"" + page_url + "\"";
  std::string out;
  if (HoloRunCapture(cmd, out, 30000) != 0) return false;
  urls = StreamLines(out);
  if (urls.size() > 2) urls.resize(2);
  return !urls.empty();
}

bool HoloScResolveAudioUrl(const std::string& page_url, std::string& direct_url) {
  if (!SafeUrl(page_url)) return false;
  const std::string cmd =
      "\"" + HoloYtDlpPath() + "\""
      " -f \"bestaudio[protocol^=http]/http_mp3_128/http_mp3_0/bestaudio\""
      " -S \"abr,acodec:opus\""
      " -g --no-warnings --no-playlist \"" + page_url + "\"";
  std::string out;
  if (HoloRunCapture(cmd, out, 30000) != 0) return false;
  const std::vector<std::string> lines = StreamLines(out);
  if (lines.empty()) return false;
  direct_url = lines.front();
  return true;
}

// WebM is VP9/Opus's native container and the one this engine reliably demuxes (VP9-in-MP4 is advertised by
// canPlayType but does not actually decode here). The output MUST be a real file, not a pipe: ffmpeg seeks
// back to write the SeekHead/Cues + Segment size, and only THAT seekable WebM is accepted by the <video>
// element (a pipe-muxed WebM has duration=N/A → "Format error"). Copy (no re-encode) → zero quality loss.
bool HoloScTranscodeVideoToFile(const std::vector<std::string>& urls, const std::string& out_path) {
  if (urls.empty() || !SafeUrl(urls[0]) || out_path.find('"') != std::string::npos) return false;
  std::string in;
  if (urls.size() >= 2 && SafeUrl(urls[1]))
    in = " -i \"" + urls[0] + "\" -i \"" + urls[1] + "\" -map 0:v:0 -map 1:a:0";
  else
    in = " -i \"" + urls[0] + "\"";
  // -f webm is explicit: the temp path ends in ".part.<id>", so ffmpeg can't infer the format from it.
  const std::string cmd = "\"" + HoloFfmpegPath() + "\" -hide_banner -loglevel error -nostdin -y" + in +
                          " -c copy -f webm \"" + out_path + "\"";
  std::string out;
  return HoloRunCapture(cmd, out, 180000) == 0;  // 3-min ceiling; -c copy is fast (no re-encode)
}

bool HoloScTranscodeAudioToFile(const std::string& direct_url, const std::string& out_path) {
  if (!SafeUrl(direct_url) || out_path.find('"') != std::string::npos) return false;
  // Re-encode to Opus/WebM (cheap) so the output is uniform + engine-decodable regardless of the source codec.
  const std::string cmd = "\"" + HoloFfmpegPath() + "\" -hide_banner -loglevel error -nostdin -y -i \"" +
                          direct_url + "\" -vn -c:a libopus -b:a 160k -f webm \"" + out_path + "\"";
  std::string out;
  return HoloRunCapture(cmd, out, 180000) == 0;
}
