// holo_sc.h — native streaming companion for the left-nav media apps (Holo Video + Holo Vinyl/Music).
//
// The web/dev build serves /sc/vstream, /sc/stream, /sc/resolve, /sc/track, /sc/search from the Node dev
// server (tools/holo-serve-fhs.mjs). The NATIVE CEF host serves only the sealed holo://os/* image, so those
// routes 404 and nothing in the dock plays. This unit ports the dev backend into the host as a low-latency
// STREAMING source: yt-dlp resolves the best stream, ffmpeg copy-muxes it live, and the bytes flow to the
// player as they arrive (no whole-file buffering).
//
// Codec note that makes this WORK in the prebuilt libcef: this engine has VP9/AV1/Opus but NOT H.264/AAC, so
// vstream resolves VP9/AV1 video + Opus audio and copy-muxes into WebM (a streamable container the engine
// decodes) — no re-encode, so zero quality loss and minimal latency. (Where only H.264 exists the caller can
// still fall through to the holo_media transcode path.)
//
// This header is intentionally CEF-free and OS-free; the implementation isolates <windows.h>.
#ifndef HOLO_SC_H_
#define HOLO_SC_H_

#include <cstddef>
#include <string>
#include <vector>

// Tool locations: env override ($HOLO_YTDLP / $HOLO_FFMPEG) else the bare name on PATH.
std::string HoloYtDlpPath();
std::string HoloFfmpegPath();

// True if yt-dlp is actually present/launchable (env path exists, or "yt-dlp" assumed on PATH). Cheap.
bool HoloHasYtDlp();

// Run a command line to completion, capturing stdout into `out` (stderr discarded). BLOCKING — call off the
// IO/UI thread. Returns the process exit code, or -1 if it could not be launched / timed out. `timeout_ms`
// bounds the wait so a stuck child can never hang the caller.
int HoloRunCapture(const std::string& cmdline, std::string& out, unsigned timeout_ms);

// vstream resolution: ask yt-dlp for the direct stream URL(s) of `page_url`, preferring engine-decodable
// VP9/AV1 video + Opus audio at or below `height`. On success fills `urls` with either 1 (already muxed) or
// 2 (video, audio) https URLs and returns true.
bool HoloScResolveVideoUrls(const std::string& page_url, int height, std::vector<std::string>& urls);

// audio resolution: the single best progressive http(s) audio stream URL for `page_url` (SoundCloud etc.).
bool HoloScResolveAudioUrl(const std::string& page_url, std::string& direct_url);

// The on-disk video cache directory ($HOLO_VCACHE else %TEMP%\holo-vcache), created if absent. Empty on
// failure. Repeat plays of a vstream are served straight from a finished file here (instant + seekable).
std::string HoloScCacheDir();

// Transcode/remux a resolved source to a SEEKABLE file (ffmpeg writes a real file, so it back-patches the
// container's seek index — required for Chromium's <video>/<audio> to demux it; a stream muxed to a pipe is
// rejected with "Format error"). BLOCKING — run on a worker thread. Returns true on success.
//   video → WebM (VP9/AV1 + Opus), copied (no re-encode → zero quality loss).
//   audio → WebM/Opus (cheap re-encode; uniform, engine-decodable, with a content-type).
bool HoloScTranscodeVideoToFile(const std::vector<std::string>& urls, const std::string& out_path);
bool HoloScTranscodeAudioToFile(const std::string& direct_url, const std::string& out_path);

#endif  // HOLO_SC_H_
