// Canonical Tauri v2 desktop entry point — verbatim shape. It just calls into the lib (which is also
// the mobile entry point), so desktop + mobile share one code path. All logic lives in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hologram_lib::run()
}
