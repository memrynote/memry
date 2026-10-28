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
    (
        "apps/desktop-tauri/src-tauri/src/updater/velopack_backend.rs",
        "the update feed on github.com, fetched by Velopack; only its error type is named here",
    ),
    (
        "apps/desktop-tauri/src-tauri/src/updater/velopack_backend/tests.rs",
        "builds Velopack's error values, no request",
    ),
];

/// A network client crate, or the shared client's module however it is named: by path from
/// `crate`, `memry_desktop`, `super` or `self`, in a braced (possibly multi-line) `use`, by
/// `http::client` after the module was imported, by a rename, or `client_trusting`.
const PATTERN: &str = r"(?s)\b(reqwest|tokio_tungstenite|tungstenite|tokio_rustls|hyper|hyper_util|ureq|isahc|surf|attohttpc|tauri_plugin_http|tauri_plugin_websocket)\b|\b(crate|memry_desktop|super|self)::http\b|\bhttp::client(_trusting)?\b|\bclient_trusting\b|\buse\s+(crate|memry_desktop|super|self)::\{[^;]*?\bhttp\b[^;]*?\}";

/// Each match in `source` as `line: text`, comments blanked first (line numbers kept).
fn offenses(source: &str) -> Vec<(usize, String)> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(PATTERN).unwrap());
    let code: String = source
        .lines()
        .map(|line| match line.find("//") {
            Some(at) => &line[..at],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    RE.find_iter(&code)
        .map(|found| {
            let line = code[..found.start()].matches('\n').count() + 1;
            (
                line,
                found
                    .as_str()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        })
        .collect()
}

#[test]
fn the_guard_sees_every_way_to_name_an_unpinned_client() {
    for source in [
        "let client = memry_desktop::http::client();",
        "use memry_desktop::http::client;",
        "use memry_desktop::http::{self as net};",
        "use crate::http::client as unpinned;",
        "use crate::http;",
        "use super::http;",
        "use self::http::client;",
        "let client = http::client();",
        "let client = http::client_trusting(root);",
        "let c = client_trusting(root);",
        "use crate::{config::RuntimeConfig, http};",
        "use crate::{\n    config::RuntimeConfig,\n    http,\n    session::Session,\n};",
        "use memry_desktop::{\n    http::client,\n};",
        "use reqwest::Client;",
        "tokio_tungstenite::connect_async(url)",
        "use tokio_rustls::TlsConnector;",
        "hyper::Client::new()",
        "ureq::get(url)",
    ] {
        assert!(!offenses(source).is_empty(), "{source}");
    }
    for source in [
        "// reqwest is not used here",
        "let x = 1; // use crate::http;",
        "let http = self.transport.send(request);",
        "mod http;",
        "http::send(&self.http, request)",
        "use crate::{config::RuntimeConfig, http_cache};",
        "use crate::{a::b};\nlet http = 1;",
    ] {
        assert!(offenses(source).is_empty(), "{source}");
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
        for (line, found) in offenses(&text) {
            offenders.push(format!("{relative}:{line}: {found}"));
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
