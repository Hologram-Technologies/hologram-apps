// holo_media.cc — κ Universal Media Resolver backend. <windows.h> is isolated to this translation unit.
#include "holo_media.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <vector>

namespace {

std::string LowerNoQuery(const std::string& url) {
  std::string s = url;
  const size_t q = s.find_first_of("?#");
  if (q != std::string::npos) s.resize(q);
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
  return s;
}

bool EndsWith(const std::string& s, const char* suffix) {
  const size_t n = std::strlen(suffix);
  return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}

std::string FfmpegPath() {
  if (const char* e = std::getenv("HOLO_FFMPEG")) {
    if (e[0]) return std::string(e);
  }
  return "ffmpeg";  // rely on PATH
}

// Read a whole binary file into `out`. Returns false if missing/empty.
bool ReadAll(const std::string& path, std::string& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  f.seekg(0, std::ios::end);
  const std::streamoff len = f.tellg();
  if (len <= 0) return false;
  f.seekg(0, std::ios::beg);
  out.resize(static_cast<size_t>(len));
  f.read(&out[0], len);
  return f.good() && !out.empty();
}

}  // namespace

bool HoloIsTranscodableMediaUrl(const std::string& url) {
  const std::string s = LowerNoQuery(url);
  // Already engine-playable containers → never transcode.
  if (EndsWith(s, ".webm") || EndsWith(s, ".weba") || EndsWith(s, ".ogg") ||
      EndsWith(s, ".ogv") || EndsWith(s, ".opus"))
    return false;
  // Clear H.264/AAC containers the prebuilt libcef can't decode.
  return EndsWith(s, ".mp4") || EndsWith(s, ".m4v") || EndsWith(s, ".m4a") ||
         EndsWith(s, ".mov") || EndsWith(s, ".aac") || EndsWith(s, ".ts");
}

bool HoloTranscodeToWebm(const std::string& url, std::string& out_webm) {
  // A double-quote in the URL would break command-line quoting; refuse rather than risk an injection.
  if (url.find('"') != std::string::npos) return false;

  // Unique temp output path.
  char tmpdir[MAX_PATH];
  if (!GetTempPathA(MAX_PATH, tmpdir)) return false;
  char tmpfile[MAX_PATH];
  if (!GetTempFileNameA(tmpdir, "hwm", 0, tmpfile)) return false;  // creates a .tmp placeholder
  const std::string out_path = tmpfile;

  // ffmpeg fetches the source itself and transcodes to VP9/Opus WebM. Software libvpx-vp9 in realtime mode
  // is the portable default (hardware vp9_qsv is an optimization to wire later once device-init is proven).
  const std::string cmd = "\"" + FfmpegPath() + "\""
      " -y -nostdin -loglevel error"
      " -i \"" + url + "\""
      " -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -row-mt 1 -b:v 2M"
      " -c:a libopus"
      " -f webm \"" + out_path + "\"";

  std::vector<char> mutable_cmd(cmd.begin(), cmd.end());
  mutable_cmd.push_back('\0');

  STARTUPINFOA si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi{};
  bool ok = false;
  if (CreateProcessA(nullptr, mutable_cmd.data(), nullptr, nullptr, FALSE,
                     CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
    // Bound the wait so a stuck/huge source can never hang the resolver.
    const DWORD waited = WaitForSingleObject(pi.hProcess, 120000);  // 120 s ceiling
    if (waited == WAIT_OBJECT_0) {
      DWORD code = 1;
      GetExitCodeProcess(pi.hProcess, &code);
      ok = (code == 0);
    } else {
      TerminateProcess(pi.hProcess, 1);
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }

  if (ok) ok = ReadAll(out_path, out_webm);
  DeleteFileA(out_path.c_str());  // best-effort cleanup
  return ok && !out_webm.empty();
}
