//! `vault_reindex` through the IPC a renderer calls, on a mock app over a real vault, vault tier
//! and note index (#5423 C9): a reindex asked while a first sync runs is held until it ends
//! (#5409), so the command answers once the index took the request instead of waiting for the
//! reindex, and the vault status says indexing until the held reindex ran.

#[allow(dead_code, reason = "the reindex reads no vault file")]
mod support;

use std::sync::{Arc, mpsc};
use std::time::Instant;

use memry_desktop::notes::index::NoteIndex;
use serde_json::{Value, json};
use support::{Mocked, WAIT};
use tauri::Manager;
use tauri::test::MockRuntime;
use tauri_specta::collect_commands;

#[test]
fn a_reindex_asked_during_a_first_sync_answers_at_once_and_runs_once_it_ended() {
    let commands = tauri_specta::Builder::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::vault_index::vault_reindex::<MockRuntime>,
        ]);
    let mocked = Arc::new(Mocked::open(
        &[("A.md", "# A\n"), ("B.md", "# B\n")],
        commands,
    ));
    let index = mocked.webview.state::<Arc<NoteIndex>>().inner().clone();
    let hold = mocked.session().current().unwrap().first_sync.hold();

    // On its own thread: a command that waits for the held reindex never answers.
    let (sender, answered) = mpsc::channel();
    let caller = mocked.clone();
    std::thread::spawn(move || sender.send(caller.invoke("vault_reindex", json!({}))));
    let answer = answered
        .recv_timeout(WAIT)
        .expect("vault_reindex answered while the first sync runs");
    assert_eq!(answer, Ok(Value::Null));
    assert!(
        index.indexing().is_some(),
        "the vault status says indexing while the reindex is held"
    );

    drop(hold);
    let deadline = Instant::now() + WAIT;
    while index.indexing().is_some() {
        assert!(Instant::now() < deadline, "the held reindex never ran");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
