//! `vault_reindex` through the IPC a renderer calls, on a mock app over a real vault, vault tier
//! and note index (#5423 C9): a reindex asked while a first sync runs is held until it ends
//! (#5409), so the command answers once the index took the request instead of waiting for the
//! reindex, and the vault status says indexing until the held reindex ran. A reindex that fails
//! after the answer reaches the window through the vault status's error, as Electron's `reindex`
//! sets it.

#[allow(dead_code, reason = "the reindex reads no vault file")]
mod support;

use std::sync::{Arc, Mutex, mpsc};
use std::time::Instant;

use memry_desktop::notes::index::NoteIndex;
use memry_desktop::session::response::VaultStatus;
use memry_tauri::events::VaultStatusChangedEvent;
use serde_json::{Value, json};
use support::{Mocked, WAIT};
use tauri::test::MockRuntime;
use tauri::{Listener, Manager};
use tauri_specta::{Event, collect_commands};

fn mocked() -> Arc<Mocked> {
    let commands = tauri_specta::Builder::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::vault_index::vault_reindex::<MockRuntime>,
        ]);
    Arc::new(Mocked::open(
        &[("A.md", "# A\n"), ("B.md", "# B\n")],
        commands,
    ))
}

#[test]
fn a_reindex_asked_during_a_first_sync_answers_at_once_and_runs_once_it_ended() {
    let mocked = mocked();
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

#[test]
fn a_reindex_that_fails_after_the_answer_sets_the_vault_status_error() {
    let mocked = mocked();
    let (sink, statuses) = mpsc::channel::<VaultStatus>();
    let sink = Mutex::new(sink);
    mocked
        .webview
        .listen_any(VaultStatusChangedEvent::NAME, move |event| {
            let _ = sink
                .lock()
                .unwrap()
                .send(serde_json::from_str(event.payload()).unwrap());
        });
    let hold = mocked.session().current().unwrap().first_sync.hold();
    assert_eq!(mocked.invoke("vault_reindex", json!({})), Ok(Value::Null));

    // The index database loses a table the held reindex writes once it runs.
    let index = rusqlite::Connection::open(mocked.vault.join(".memry/core/index.db")).unwrap();
    index.execute_batch("DROP TABLE index_meta").unwrap();
    drop(hold);

    let mut seen = Vec::new();
    let failed = loop {
        let status = statuses.recv_timeout(WAIT).unwrap_or_else(|_| {
            panic!("no vault status told the window the reindex failed: {seen:?}")
        });
        if status.error.is_some() {
            break status;
        }
        seen.push(status);
    };
    assert!(failed.is_open);
    assert!(!failed.is_indexing, "the failed reindex ended the indexing");
    assert!(
        failed
            .error
            .as_deref()
            .is_some_and(|error| !error.is_empty()),
        "the error carries the command error's message"
    );
}
