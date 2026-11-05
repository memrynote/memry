//! A command's round trip through the IPC a renderer calls, over a 1000-note vault (#3530
//! 13q-7): the request parsed, the command run on the blocking pool, the answer serialized.
//! Ignored, a release-build measurement that asserts no time:
//!
//! ```text
//! MEMRY_ENV=development cargo test -p memry-tauri --release --test ipc_round_trip -- --ignored --nocapture
//! ```

#[allow(
    dead_code,
    reason = "the measurement uses only the IPC of the shared mock"
)]
mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::Mocked;
use tauri::test::MockRuntime;
use tauri_specta::{ErrorHandlingMode, collect_commands};

const NOTES: usize = 1000;
const CALLS: usize = 500;

/// `p50` and `p99` of `CALLS` round trips of `cmd`, after a warm-up of ten.
fn round_trips(mocked: &Mocked, what: &str, cmd: &str, args: &Value) {
    for _ in 0..10 {
        mocked.invoke(cmd, args.clone()).unwrap();
    }
    let mut times: Vec<Duration> = (0..CALLS)
        .map(|_| {
            let started = Instant::now();
            mocked.invoke(cmd, args.clone()).unwrap();
            started.elapsed()
        })
        .collect();
    times.sort();
    let at = |q: usize| times[(times.len() * q / 100).min(times.len() - 1)];
    println!(
        "{what}: p50 {:?}, p99 {:?}, max {:?}, n {CALLS}",
        at(50),
        at(99),
        times[times.len() - 1]
    );
}

#[test]
#[ignore = "a release-build measurement"]
fn a_commands_round_trip_over_a_1000_note_vault() {
    let texts: Vec<(String, String)> = (0..NOTES)
        .map(|i| {
            (
                format!("Folder {}/Note {i}.md", i % 20),
                format!("# Note {i}\n\nSome words, #tag{}.\n", i % 7),
            )
        })
        .collect();
    let files: Vec<(&str, &str)> = texts
        .iter()
        .map(|(path, text)| (path.as_str(), text.as_str()))
        .collect();
    // As `registry::builder` lists it, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::notes::notes_list::<MockRuntime>,
        ]);
    let mocked = Mocked::open(&files, commands);
    let one = json!({ "options": { "limit": 1 } });
    round_trips(&mocked, "notes_list, one note", "notes_list", &one);
    // What the sidebar asks for (`use-note-tree-data.ts`).
    let tree = json!({ "options": { "limit": 10_000, "fields": "tree" } });
    let answer = mocked.invoke("notes_list", tree.clone()).unwrap();
    assert_eq!(answer["notes"].as_array().map(Vec::len), Some(NOTES));
    round_trips(
        &mocked,
        "notes_list, the sidebar's tree",
        "notes_list",
        &tree,
    );
}
