//! Ports of `apps/desktop/src/main/sync/note-sync-state.test.ts` and
//! `large-notes.test.ts` over a migrated `data.db`.

use rusqlite::{Connection, params};

use super::*;
use crate::domain::owed_file_body;
use crate::storage::test_support::{TempDir, temp_dir};
use crate::storage::{Db, open_data};

const T0: i64 = 1_760_000_000_000;

struct Vault {
    _dir: TempDir,
    db: Db,
}

impl Vault {
    fn new() -> Self {
        let dir = temp_dir("body-state");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        Self { _dir: dir, db }
    }

    fn with<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, StorageError> + Send + 'static,
    ) -> T {
        self.db
            .call_blocking(move |conn| f(conn))
            .expect("the database call")
    }

    fn note(&self, id: &str, local_only: bool) {
        let id = id.to_owned();
        self.with(move |conn| {
            conn.execute(
                "INSERT INTO notes (id, title) VALUES (?1, ?2)",
                params![id, format!("Title {id}")],
            )
            .map_err(failed)?;
            conn.execute(
                "INSERT INTO note_files (note_id, path, local_only, indexed_at)
                 VALUES (?1, ?2, ?3, 0)",
                params![id, format!("notes/{id}.md"), local_only],
            )
            .map_err(failed)?;
            Ok(())
        });
    }

    fn queue(&self, id: &str, op: &str, at: i64) {
        let (id, op) = (id.to_owned(), op.to_owned());
        self.with(move |conn| {
            conn.execute(
                "INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('note', ?1, ?2, ?3)",
                params![id, op, at],
            )
            .map_err(failed)?;
            Ok(())
        });
    }

    fn owe_file(&self, id: &str, at: i64) {
        let id = id.to_owned();
        self.with(move |conn| owed_file_body::record(conn, &id, at));
    }

    fn record(&self, id: &str, event: PushEvent, at: i64) {
        let id = id.to_owned();
        self.with(move |conn| record(conn, &id, event, at));
    }

    fn state(&self, id: &str) -> Option<NoteSyncState> {
        self.state_eligible(id, true)
    }

    fn state_eligible(&self, id: &str, eligible: bool) -> Option<NoteSyncState> {
        let id = id.to_owned();
        self.with(move |conn| note_sync_state(conn, &id, eligible))
    }

    fn unsent(&self, limit: usize) -> UnsentNotes {
        self.with(move |conn| unsent_notes(conn, true, limit))
    }
}

const BODY: &str = OP_CRDT_UPDATE;
const RECORD: &str = "upsert";

fn state_of(vault: &Vault, id: &str) -> SyncStateValue {
    vault.state(id).expect("a known note").state
}

#[test]
fn a_queued_body_row_is_waiting() {
    let vault = Vault::new();
    vault.note("n1", false);
    vault.queue("n1", BODY, T0);
    let state = vault.state("n1").unwrap();
    assert_eq!(state.state, SyncStateValue::Pending);
    assert_eq!(state.waiting_since, Some(T0));
    assert_eq!(state.body_confirmed_at, None);
}

#[test]
fn a_push_with_no_answer_yet_is_sent() {
    let vault = Vault::new();
    vault.note("n1", false);
    vault.queue("n1", BODY, T0);
    vault.record("n1", PushEvent::Sent, T0 + 1000);
    assert_eq!(state_of(&vault, "n1"), SyncStateValue::Sent);
}

#[test]
fn a_stored_push_is_confirmed_with_its_time() {
    let vault = Vault::new();
    vault.note("n1", false);
    vault.record("n1", PushEvent::Sent, T0);
    vault.record("n1", PushEvent::Confirmed, T0 + 500);
    assert_eq!(
        vault.state("n1"),
        Some(NoteSyncState {
            state: SyncStateValue::Confirmed,
            waiting_since: None,
            last_sent_at: Some(T0),
            body_confirmed_at: Some(T0 + 500),
            last_failed_at: None,
            last_rejected_at: None,
        })
    );
}

#[test]
fn a_retryable_failure_is_pending_and_keeps_the_confirmed_time_even_while_a_retry_is_out() {
    let vault = Vault::new();
    vault.note("n1", false);
    vault.record("n1", PushEvent::Confirmed, T0);
    vault.queue("n1", BODY, T0 + 2000);
    vault.record("n1", PushEvent::Sent, T0 + 3000);
    vault.record("n1", PushEvent::Failed, T0 + 4000);
    let state = vault.state("n1").unwrap();
    assert_eq!(state.state, SyncStateValue::Pending);
    assert_eq!(state.waiting_since, Some(T0 + 2000));
    assert_eq!(state.body_confirmed_at, Some(T0));
    vault.record("n1", PushEvent::Sent, T0 + 4001);
    assert_eq!(state_of(&vault, "n1"), SyncStateValue::Pending);
}

#[test]
fn a_note_never_pushed_by_this_version_is_not_recorded() {
    let vault = Vault::new();
    vault.note("n1", false);
    assert_eq!(state_of(&vault, "n1"), SyncStateValue::NotRecorded);
}

#[test]
fn a_refusal_holds_past_later_accepted_updates_until_a_snapshot_is_stored() {
    let vault = Vault::new();
    vault.note("n1", false);
    vault.record("n1", PushEvent::Rejected, T0);
    vault.record("n1", PushEvent::Sent, T0 + 1000);
    vault.record("n1", PushEvent::Confirmed, T0 + 2000);
    assert_eq!(state_of(&vault, "n1"), SyncStateValue::Rejected);
    let unsent = vault.unsent(MAX_UNSENT_NOTES);
    assert_eq!(unsent.notes[0].reasons, vec![UnsentReason::Rejected]);

    vault.record("n1", PushEvent::Snapshot, T0 + 3000);
    let state = vault.state("n1").unwrap();
    assert_eq!(state.state, SyncStateValue::Confirmed);
    assert_eq!(state.body_confirmed_at, Some(T0 + 3000));
    assert_eq!(vault.unsent(MAX_UNSENT_NOTES).total, 0);
}

#[test]
fn a_queued_record_change_and_a_file_not_taken_are_waiting() {
    let vault = Vault::new();
    vault.note("n1", false);
    vault.note("n2", false);
    vault.queue("n1", RECORD, T0 + 5000);
    vault.owe_file("n2", T0 + 7000);
    assert_eq!(vault.state("n1").unwrap().waiting_since, Some(T0 + 5000));
    let n2 = vault.state("n2").unwrap();
    assert_eq!(
        (n2.state, n2.waiting_since),
        (SyncStateValue::Pending, Some(T0 + 7000))
    );
}

#[test]
fn local_only_and_not_syncing_come_before_anything_else_and_an_unknown_id_is_none() {
    let vault = Vault::new();
    vault.note("n1", true);
    vault.note("n2", false);
    vault.queue("n2", BODY, T0);
    assert_eq!(state_of(&vault, "n1"), SyncStateValue::LocalOnly);
    assert_eq!(
        vault.state_eligible("n2", false).unwrap().state,
        SyncStateValue::NotSyncing
    );
    assert_eq!(vault.state("missing"), None);
}

#[test]
fn the_unsent_list_puts_refusals_first_then_the_oldest_and_leaves_out_local_and_unknown_notes() {
    let vault = Vault::new();
    for id in ["a", "b", "c", "d", "e", "f"] {
        vault.note(id, false);
    }
    vault.note("local", true);
    vault.queue("a", BODY, T0 + 3000);
    vault.queue("b", RECORD, T0 + 1000);
    vault.owe_file("c", T0 + 2000);
    vault.record("d", PushEvent::Confirmed, T0);
    vault.record("d", PushEvent::Rejected, T0 + 9000);
    vault.record("e", PushEvent::Confirmed, T0);
    vault.record("f", PushEvent::Rejected, T0);
    vault.record("f", PushEvent::Snapshot, T0 + 1);
    vault.queue("local", BODY, T0);
    vault.queue("ghost", BODY, T0);

    let result = vault.unsent(MAX_UNSENT_NOTES);

    assert_eq!(result.total, 4);
    let listed: Vec<_> = result
        .notes
        .iter()
        .map(|note| (note.id.as_str(), note.state, note.reasons.clone()))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("d", SyncStateValue::Rejected, vec![UnsentReason::Rejected]),
            ("b", SyncStateValue::Pending, vec![UnsentReason::Record]),
            (
                "c",
                SyncStateValue::Pending,
                vec![UnsentReason::FileNotTaken]
            ),
            ("a", SyncStateValue::Pending, vec![UnsentReason::Body]),
        ]
    );
    assert_eq!(
        (
            result.notes[1].title.as_str(),
            result.notes[1].path.as_str()
        ),
        ("Title b", "notes/b.md")
    );
}

#[test]
fn the_unsent_list_is_capped_but_keeps_the_total() {
    let vault = Vault::new();
    for id in ["a", "b", "c"] {
        vault.note(id, false);
        vault.queue(id, BODY, T0);
    }
    let result = vault.unsent(2);
    assert_eq!((result.total, result.notes.len()), (3, 2));
}

#[test]
fn a_record_keeps_earlier_columns() {
    let vault = Vault::new();
    vault.record("n1", PushEvent::Sent, T0);
    vault.record("n1", PushEvent::Confirmed, T0 + 1);
    vault.record("n1", PushEvent::Failed, T0 + 2);
    let pushes = vault.with(|conn| pushes_of(conn, "n1")).unwrap();
    assert_eq!(
        pushes,
        Pushes {
            sent: Some(T0),
            confirmed: Some(T0 + 1),
            failed: Some(T0 + 2),
            rejected: None,
            snapshot: None,
        }
    );
}

#[test]
fn large_notes_classify_at_the_bounds_skip_attachments_and_local_notes_and_sort_largest_first() {
    let vault = Vault::new();
    for id in ["warn", "below", "over", "max", "local", "gone"] {
        vault.note(id, id == "local");
    }
    vault.note("pdf", false);
    vault.with(|conn| {
        conn.execute(
            "UPDATE note_files SET file_type = 'pdf' WHERE note_id = 'pdf'",
            [],
        )
        .map_err(failed)?;
        Ok(())
    });
    let max = NOTE_SYNC_MAX_BYTES as u64;
    let warn = crate::api::large_notes::warn_bytes() as u64;
    let candidates = vault.with(large_note_candidates);
    let result = large_notes(candidates, |path| match path {
        "notes/warn.md" => Some(warn),
        "notes/below.md" => Some(warn - 1),
        "notes/over.md" => Some(max + 1),
        "notes/max.md" => Some(max),
        "notes/gone.md" => None,
        _ => Some(max * 2),
    });
    assert_eq!(result.max_bytes, max);
    let listed: Vec<_> = result
        .notes
        .iter()
        .map(|note| (note.id.as_str(), note.status))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("over", SizeStatus::Over),
            ("max", SizeStatus::Approaching),
            ("warn", SizeStatus::Approaching),
        ]
    );
}

#[test]
fn large_notes_are_capped() {
    let vault = Vault::new();
    for index in 0..(MAX_LARGE_NOTES + 5) {
        vault.note(&format!("n{index}"), false);
    }
    let candidates = vault.with(large_note_candidates);
    let result = large_notes(candidates, |_| Some(NOTE_SYNC_MAX_BYTES as u64 + 1));
    assert_eq!(result.notes.len(), MAX_LARGE_NOTES);
}
