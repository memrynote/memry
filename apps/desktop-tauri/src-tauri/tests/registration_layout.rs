//! `registry.rs` and `events/mod.rs` hold only the chain of areas. A command or event goes in
//! `registry/<area>.rs` and an event type in `events/<area>.rs`, so PRs in different areas never
//! edit the same file.

use std::path::Path;

fn source(path: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(path);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[test]
fn shared_registration_files_hold_only_the_chain() {
    let registry = source("registry.rs");
    let events = source("events/mod.rs");
    let entries = [
        ("registry.rs", &registry, "crate::commands::"),
        ("registry.rs", &registry, "crate::events::"),
        ("registry.rs", &registry, "crate::fonts::"),
        ("events/mod.rs", &events, "#[derive("),
    ];
    for (file, text, entry) in entries {
        let line = text.lines().find(|line| line.contains(entry));
        assert!(
            line.is_none(),
            "{file} lists `{}`: put it in its area's `registry/<area>.rs` or `events/<area>.rs`",
            line.unwrap_or_default().trim()
        );
    }
}
