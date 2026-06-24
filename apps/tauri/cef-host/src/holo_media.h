// holo_media.h — κ Universal Media Resolver backend (the transcode primitive).
//
// The CEF host's prebuilt libcef lacks proprietary H.264/AAC decoders, so clear (non-DRM) .mp4 media
// the open web ships does not play. This unit converts such a source, on demand, into VP9/Opus WebM —
// which the engine ALREADY decodes — using ffmpeg (hardware-accelerated where available). The CEF
// resource handler (handler.cc) caches the result in the κ-substrate so a repeat is instant.
//
// This header is intentionally CEF-free and OS-free; the implementation isolates <windows.h>.
#ifndef HOLO_MEDIA_H_
#define HOLO_MEDIA_H_

#include <string>

// True if `url` is a clear-media container the engine can't decode (mp4/m4v/mov/m4a/aac/ts), and thus a
// candidate for transcoding. WebM/Ogg/Opus are already playable → false (never needlessly transcoded).
// Pure string test (lower-cased path/extension); no network.
bool HoloIsTranscodableMediaUrl(const std::string& url);

// Fetch + transcode `url` → VP9/Opus WebM, returning the complete bytes in `out_webm`.
// BLOCKING (run on a worker thread, never the IO/UI thread). ffmpeg downloads the source itself (its own
// HTTP/S), so no separate fetch is needed. Returns true on success with a non-empty `out_webm`; false on
// any failure (caller fails closed — no worse than today, since the engine couldn't play the source anyway).
// ffmpeg binary: $HOLO_FFMPEG if set, else "ffmpeg" on PATH.
bool HoloTranscodeToWebm(const std::string& url, std::string& out_webm);

#endif  // HOLO_MEDIA_H_
