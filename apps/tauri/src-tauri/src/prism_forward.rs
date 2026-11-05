// ── holo://build → prism-code ─────────────────────────────────────────────────────────────────────────
// uor.foundation's Build button writes `holo://build?agent=<id>&q=<sentence>`: "build me a Prism app that …",
// handed to the agent the visitor uses. Hologram owns holo://, so `npx prism-code setup` leaves the OS
// registration to Hologram and records its own handler in `$PRISM_HOME/handler.json` (default `~/.prism`,
// schema `prism/handler/1`). Hologram hands such a link to that handler as `node <entry> <link>`: two
// arguments, no shell, no console window. The handler checks the link itself (the host, the agent, the
// sentence) and opens the agent. Every other holo:// link is Hologram's, unchanged.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const RECORD_SCHEMA: &str = "prism/handler/1";

/// True for a `holo://build` link: the scheme in any case, the host exactly `build`.
pub fn is_build_link(url: &str) -> bool {
    match url.get(..7) {
        Some(scheme) if scheme.eq_ignore_ascii_case("holo://") => {
            let rest = &url[7..];
            let end = rest.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
            &rest[..end] == "build"
        }
        _ => false,
    }
}

/// `$PRISM_HOME`, or `.prism` in the home directory, where prism-code keeps its state.
pub fn prism_home() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PRISM_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|v| !v.is_empty())?;
    Some(PathBuf::from(home).join(".prism"))
}

/// The program and arguments that hand `url` to prism-code, read from the record in `prism_home`.
/// Refuses a record that is not prism-code's, or that names files no longer there.
pub fn forward_command(url: &str, prism_home: &Path) -> Result<(PathBuf, Vec<OsString>), String> {
    let path = prism_home.join("handler.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}; run `npx prism-code setup` once", path.display()))?;
    let record: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{} is not JSON: {e}", path.display()))?;
    let field = |name: &str| record.get(name).and_then(|v| v.as_str());
    if field("schema") != Some(RECORD_SCHEMA) || field("scheme") != Some("holo") || field("host") != Some("build") {
        return Err(format!("{} is not a {RECORD_SCHEMA} record for holo://build", path.display()));
    }
    let (Some(node), Some(entry)) = (field("node"), field("entry")) else {
        return Err(format!("{} names no node or entry", path.display()));
    };
    let (node, entry) = (PathBuf::from(node), PathBuf::from(entry));
    // Only prism-code's own handler runs: a record pointing anywhere else is not followed.
    if entry.file_name().and_then(|n| n.to_str()) != Some("handler.mjs") {
        return Err(format!("{} names {}, not prism-code's handler.mjs", path.display(), entry.display()));
    }
    for file in [&node, &entry] {
        if !file.is_file() {
            return Err(format!("{} does not exist; run `npx prism-code setup` again", file.display()));
        }
    }
    Ok((node, vec![entry.into_os_string(), OsString::from(url)]))
}

/// Hand a holo://build link to prism-code: no shell parses it, and no console window opens for node.
pub fn forward(url: &str) -> Result<(), String> {
    let home = prism_home().ok_or("no home directory to find prism-code in")?;
    let (program, args) = forward_command(url, &home)?;
    let mut command = Command::new(&program);
    command.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map(|_| ()).map_err(|e| format!("{}: {e}", program.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK: &str = "holo://build?agent=claude-code&q=Go%20to%20uor.foundation%20and%20build%20me%20a%20Prism%20app%20that%20tells%20whether%20a%20year%20is%20a%20leap%20year.";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hologram-prism-forward-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(dir: &Path, node: &Path, entry: &Path) {
        let json = serde_json::json!({ "schema": RECORD_SCHEMA, "scheme": "holo", "host": "build", "node": node, "entry": entry });
        std::fs::write(dir.join("handler.json"), json.to_string()).unwrap();
    }

    #[test]
    fn only_the_build_host_is_prism_codes() {
        for url in [LINK, "holo://build", "holo://build/", "HOLO://build?q=x", "holo://build#x"] {
            assert!(is_build_link(url), "{url}");
        }
        for url in ["holo://os/apps/browser/index.html", "holo://builder?q=x", "holo://BUILD?q=x", "holo://build:80?q=x", "hologram://build?q=x", "web+hologram://build", "holo:/build", "", "holo"] {
            assert!(!is_build_link(url), "{url}");
        }
    }

    #[test]
    fn the_link_reaches_the_handler_as_one_argument_after_the_entry() {
        let dir = scratch("ok");
        let (node, entry) = (dir.join("node.exe"), dir.join("handler").join("handler.mjs"));
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&node, b"").unwrap();
        std::fs::write(&entry, b"").unwrap();
        record(&dir, &node, &entry);
        let hostile = "holo://build?agent=codex&q=50%25%20%22done%22%20%26%20%7C%20%3B";
        let (program, args) = forward_command(hostile, &dir).unwrap();
        assert_eq!(program, node);
        assert_eq!(args, vec![entry.into_os_string(), OsString::from(hostile)]);
    }

    #[test]
    fn without_prism_code_set_up_nothing_runs() {
        let dir = scratch("missing");
        assert!(forward_command(LINK, &dir).unwrap_err().contains("npx prism-code setup"));
        std::fs::write(dir.join("handler.json"), "not json").unwrap();
        assert!(forward_command(LINK, &dir).unwrap_err().contains("is not JSON"));
        std::fs::write(dir.join("handler.json"), r#"{"schema":"other/1","scheme":"holo","host":"build","node":"n","entry":"handler.mjs"}"#).unwrap();
        assert!(forward_command(LINK, &dir).unwrap_err().contains("is not a prism/handler/1 record"));
        record(&dir, &dir.join("node.exe"), &dir.join("handler.mjs"));
        assert!(forward_command(LINK, &dir).unwrap_err().contains("does not exist"));
    }

    #[test]
    fn a_record_naming_another_program_is_not_followed() {
        let dir = scratch("other");
        let (node, other) = (dir.join("node.exe"), dir.join("evil.mjs"));
        std::fs::write(&node, b"").unwrap();
        std::fs::write(&other, b"").unwrap();
        record(&dir, &node, &other);
        assert!(forward_command(LINK, &dir).unwrap_err().contains("not prism-code's handler.mjs"));
    }
}
