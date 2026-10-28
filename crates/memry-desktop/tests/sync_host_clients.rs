//! Nothing reaches the sync server except through the pinned transport (`seams::transport`).
//!
//! The unpinned client (`memry_desktop::http::client()`) and any other reqwest client may only
//! appear where the code calls a host that is not the sync server. A new caller has to be added
//! here, with the host it calls, so a sync request cannot quietly skip the pins.

use std::path::{Path, PathBuf};

/// Files allowed to name an unpinned client, and the host each one calls.
const ALLOWED: &[(&str, &str)] = &[
    (
        "crates/memry-desktop/src/http.rs",
        "builds the shared non-sync client",
    ),
    (
        "crates/memry-desktop/src/seams/transport/mod.rs",
        "the pinned transport's own clients",
    ),
    (
        "crates/memry-desktop/src/seams/transport/http.rs",
        "the pinned transport's own clients",
    ),
    (
        "crates/memry-desktop/src/seams/transport/socket.rs",
        "the pinned transport's own socket",
    ),
    (
        "crates/memry-desktop/src/seams/transport/classify.rs",
        "the pinned transport's own errors",
    ),
    (
        "crates/memry-desktop/src/notes/unsplash/mod.rs",
        "api.unsplash.com",
    ),
    (
        "apps/desktop-tauri/src-tauri/src/commands/unsplash.rs",
        "api.unsplash.com",
    ),
];

/// A network client crate, or the shared client's module however it is named: by path, by a
/// `use` of the module or of `client`/`client_trusting`, or under a rename.
const PATTERN: &str = r"\b(reqwest|tokio_tungstenite|tungstenite|tokio_rustls|hyper|hyper_util|ureq|isahc|surf|attohttpc|tauri_plugin_http|tauri_plugin_websocket)\b|\b(crate|memry_desktop)::http\b|\bclient_trusting\b";

fn offends(line: &str) -> bool {
    let code = line.trim_start();
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(PATTERN).unwrap());
    !code.starts_with("//") && RE.is_match(code)
}

#[test]
fn the_guard_sees_every_way_to_name_an_unpinned_client() {
    for line in [
        "let client = memry_desktop::http::client();",
        "use memry_desktop::http::client;",
        "use memry_desktop::http::{self as net};",
        "use crate::http::client as unpinned;",
        "use crate::http;",
        "let c = client_trusting(root);",
        "use reqwest::Client;",
        "tokio_tungstenite::connect_async(url)",
        "use tokio_rustls::TlsConnector;",
        "hyper::Client::new()",
        "ureq::get(url)",
    ] {
        assert!(offends(line), "{line}");
    }
    for line in [
        "// reqwest is not used here",
        "let http = self.transport.send(request);",
        "mod http;",
        "http::send(&self.http, request)",
    ] {
        assert!(!offends(line), "{line}");
    }
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn only_allowlisted_files_name_an_unpinned_http_client() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    for dir in [
        "crates/memry-desktop/src",
        "apps/desktop-tauri/src-tauri/src",
    ] {
        rust_files(&root.join(dir), &mut files);
    }
    let mut offenders = Vec::new();
    for file in &files {
        let relative = file
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if ALLOWED.iter().any(|(allowed, _)| *allowed == relative) {
            continue;
        }
        let text = std::fs::read_to_string(file).unwrap();
        for (number, line) in text.lines().enumerate() {
            if offends(line) {
                offenders.push(format!("{relative}:{}: {}", number + 1, line.trim()));
            }
        }
    }
    assert!(
        files.len() > 100,
        "the scan found {} files; the paths moved",
        files.len()
    );
    assert!(
        offenders.is_empty(),
        "a sync request must go through seams::transport, never an unpinned client. \
         If this one calls another host, add it to ALLOWED with that host:\n{}",
        offenders.join("\n")
    );
}
