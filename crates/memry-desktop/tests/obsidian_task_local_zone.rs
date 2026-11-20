//! `import::obsidian_tasks` in the zone the app runs in: the `localZones` done dates of
//! `packages/contracts/test-vectors/importers/obsidian-tasks.json`, which Electron built in real
//! zones around a skipped midnight, a repeated one and a skipped day, replayed through
//! `chrono::Local` with `TZ` set. Its own test binary because it sets `TZ` for the process. Unix
//! only: chrono's Windows `Local` reads the system zone and ignores `TZ`.
#![cfg(unix)]

use std::fs;

use chrono::{DateTime, Local, Utc};
use memry_desktop::import::obsidian_tasks::build_obsidian_task_import;
use serde_json::Value;

const VECTORS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/contracts/test-vectors/importers/obsidian-tasks.json"
);

#[test]
fn done_dates_on_zone_transitions_match_electron_in_chrono_local() {
    let vectors: Value = serde_json::from_str(&fs::read_to_string(VECTORS).unwrap()).unwrap();
    let now = DateTime::parse_from_rfc3339(vectors["now"].as_str().unwrap())
        .unwrap()
        .with_timezone(&Utc);
    let mut failures = Vec::new();
    for zone in vectors["localZones"].as_array().unwrap() {
        let name = zone["zone"].as_str().unwrap().to_owned();
        // SAFETY: the only test in this binary, and no other thread reads the environment while
        // it runs.
        unsafe { std::env::set_var("TZ", &name) };
        let cases = zone["cases"].as_array().unwrap().clone();
        // chrono caches the zone per thread on first use, so each zone reads `TZ` on a new one.
        let got = std::thread::spawn(move || {
            cases
                .iter()
                .map(|case| {
                    let text = case["text"].as_str().unwrap();
                    let at = build_obsidian_task_import(text, now, &Local)
                        .and_then(|import| import.completed_at)
                        .map_or(Value::Null, Value::String);
                    (text.to_owned(), case["completedAt"].clone(), at)
                })
                .collect::<Vec<_>>()
        })
        .join()
        .unwrap();
        for (text, want, at) in got {
            if at != want {
                failures.push(format!("{name} {text:?}: want {want}, got {at}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
