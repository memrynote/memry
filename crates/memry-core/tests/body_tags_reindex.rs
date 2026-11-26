//! A reindex replaces a note's cached body tags in one commit. `data.db`'s readers (`used_tags`,
//! `tag_counts`, `tags::gone`) run on their own connections and see the last commit, so a clear
//! and a write in autocommit showed a body that carries no tags between them.

#![cfg(feature = "markdown")]

use std::sync::Mutex;

use crate::block_refs::Vault;
use memry_core::storage::migrations::INDEX_MIGRATIONS;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use rusqlite::{Connection, OpenFlags};

/// What a reader holds for `n-plan` each time the writer starts to insert a body tag.
struct Watch {
    reader: Connection,
    held: Vec<i64>,
}

/// Set for the one test that traces; a trace callback is a plain function.
static WATCH: Mutex<Option<Watch>> = Mutex::new(None);

fn watch(event: TraceEvent<'_>) {
    match event {
        TraceEvent::Stmt(_, sql) if sql.starts_with("INSERT OR IGNORE INTO note_body_tags") => {
            let mut guard = WATCH
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(watch) = guard.as_mut() {
                let rows = watch.reader.query_row(
                    "SELECT count(*) FROM note_body_tags WHERE note_id = 'n-plan'",
                    [],
                    |row| row.get(0),
                );
                watch.held.push(rows.unwrap_or(-1));
            }
        }
        _ => {}
    }
}

#[test]
fn a_reader_sees_the_old_body_tags_until_the_reindex_commits_the_new_ones() {
    let dir = tempfile::tempdir().expect("scratch");
    let mut vault = Vault::new(dir.path(), INDEX_MIGRATIONS);
    vault
        .data
        .pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))
        .expect("data.db is WAL, as the app opens it");
    vault.note("n-plan", "Plan", "Met #job here\n");
    vault.reindex();
    let carried = |vault: &Vault| -> Vec<String> {
        let mut statement = vault
            .data
            .prepare("SELECT tag FROM note_body_tags WHERE note_id = 'n-plan' ORDER BY rowid")
            .expect("prepare");
        let rows = statement.query_map([], |row| row.get(0)).expect("query");
        rows.collect::<Result<_, _>>().expect("rows")
    };
    assert_eq!(carried(&vault), ["job"]);

    vault.body("n-plan", "Met #job and #work here\n");
    let reader =
        Connection::open_with_flags(dir.path().join("data.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("reader");
    *WATCH.lock().unwrap() = Some(Watch {
        reader,
        held: Vec::new(),
    });
    vault
        .data
        .trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(watch));
    vault.reindex();
    vault.data.trace_v2(TraceEventCodes::empty(), None);

    let held = WATCH.lock().unwrap().take().expect("watched").held;
    assert!(!held.is_empty(), "the reindex wrote no body tag");
    assert!(
        held.iter().all(|rows| *rows == 1),
        "a reader saw the body without its old tags while the reindex wrote the new: {held:?}"
    );
    assert_eq!(carried(&vault), ["job", "work"]);
}
