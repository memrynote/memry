//! The vault's read-only locks on a real `data.db` (Step 14e-1, Electron
//! `vault-locks/{registry,store}.ts`): what a lock covers, what it writes, and
//! that it outlives a relaunch.

#![cfg(feature = "markdown")]

use memry_core::api::errors::StorageError;
use memry_core::domain::vault_locks::{LockState, SetOutcome, TargetKind};
use rusqlite::{Connection, params};

use crate::editor_support::{Fixture, fixture};

fn sql(f: &Fixture) -> Connection {
    Connection::open(f.dir.path().join("data.db")).expect("a connection of its own")
}

/// `(locked, clock, created_at, updated_at, deleted_at)` of a lock row.
type Row = (bool, Option<String>, i64, i64, Option<i64>);

fn row(f: &Fixture, id: &str) -> Option<Row> {
    sql(f)
        .query_row(
            "SELECT locked, clock, created_at, updated_at, deleted_at FROM vault_locks WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok()
}

fn count(f: &Fixture, query: &str) -> i64 {
    sql(f).query_row(query, [], |r| r.get(0)).expect("count")
}

#[test]
fn a_lock_outlives_a_relaunch_and_an_unlock_keeps_its_row_unsynced() {
    let f = fixture();
    let note = f.note();
    let locks = f.vault.locks();

    assert_eq!(
        locks.set(TargetKind::Note, &note, true),
        Ok(SetOutcome::Created)
    );
    let f = f.relaunch();
    let locks = f.vault.locks();
    assert_eq!(
        locks.list(),
        Ok(LockState {
            notes: vec![note.clone()],
            folders: vec![],
        })
    );
    assert_eq!(locks.is_note_locked(&note, None), Ok(true));

    assert_eq!(
        locks.set(TargetKind::Note, &note, false),
        Ok(SetOutcome::Updated)
    );
    assert_eq!(locks.list(), Ok(LockState::default()));
    assert_eq!(locks.is_note_locked(&note, None), Ok(false));
    let (locked, clock, _, _, deleted_at) = row(&f, &format!("note:{note}")).expect("kept");
    assert_eq!((locked, clock, deleted_at), (false, None, None));
    assert_eq!(
        count(
            &f,
            "SELECT COUNT(*) FROM outbox WHERE item_type = 'vault_lock'"
        ),
        0,
        "Step 16 syncs lock rows; this step queues none"
    );
    assert_eq!(
        locks.set(TargetKind::Note, &note, true),
        Ok(SetOutcome::Updated)
    );
}

#[test]
fn setting_the_state_a_target_already_has_writes_nothing() {
    let f = fixture();
    let note = f.note();
    let locks = f.vault.locks();

    assert_eq!(
        locks.set(TargetKind::Folder, "Never", false),
        Ok(SetOutcome::Unchanged)
    );
    assert_eq!(
        locks.set(TargetKind::Note, &note, false),
        Ok(SetOutcome::Unchanged)
    );
    assert_eq!(count(&f, "SELECT COUNT(*) FROM vault_locks"), 0);

    locks.set(TargetKind::Note, &note, true).expect("lock");
    sql(&f)
        .execute("UPDATE vault_locks SET updated_at = 5", [])
        .expect("mark");
    assert_eq!(
        locks.set(TargetKind::Note, &note, true),
        Ok(SetOutcome::Unchanged)
    );
    assert_eq!(row(&f, &format!("note:{note}")).expect("row").3, 5);
}

#[test]
fn a_folder_lock_covers_the_files_under_it_and_nothing_beside_it() {
    let f = fixture();
    let (inside, deeper, beside, unfiled) = (f.note(), f.note(), f.note(), f.note());
    f.file(&inside, "Projects/plan.md");
    f.file(&deeper, "Projects/2026/q1.md");
    f.file(&beside, "Projects 2/plan.md");
    let locks = f.vault.locks();

    assert_eq!(
        locks.set(TargetKind::Folder, "/Projects/", true),
        Ok(SetOutcome::Created)
    );
    assert_eq!(locks.list().expect("list").folders, vec!["Projects"]);
    assert!(
        row(&f, "folder:Projects").is_some(),
        "keyed by the normalized path"
    );

    for (path, covering) in [
        ("Projects", Some("Projects")),
        ("Projects/2026/q1.md", Some("Projects")),
        ("Projects\\2026\\q1.md", Some("Projects")),
        ("Projects 2/plan.md", None),
        ("Projectsx.md", None),
        ("Other/Projects/a.md", None),
    ] {
        assert_eq!(
            locks.folder_covering(path),
            Ok(covering.map(str::to_owned)),
            "{path}"
        );
    }
    assert_eq!(locks.is_note_locked(&inside, None), Ok(true));
    assert_eq!(locks.is_note_locked(&deeper, None), Ok(true));
    assert_eq!(locks.is_note_locked(&beside, None), Ok(false));
    assert_eq!(
        locks.is_note_locked(&unfiled, None),
        Ok(false),
        "no file row: no folder covers it"
    );
    assert_eq!(
        locks.is_note_locked(&unfiled, Some("Projects/new.md")),
        Ok(true),
        "the caller's path wins"
    );
}

#[test]
fn a_journal_day_locks_by_its_id() {
    let f = fixture();
    f.journal
        .set_tags("2026-04-16".to_owned(), vec!["day".to_owned()])
        .expect("a day record");
    let day = f
        .journal
        .entry_id("2026-04-16".to_owned())
        .expect("read")
        .expect("the day exists");
    let locks = f.vault.locks();

    assert_eq!(
        locks.set(TargetKind::Note, &day, true),
        Ok(SetOutcome::Created)
    );
    assert_eq!(locks.is_note_locked(&day, None), Ok(true));
}

#[test]
fn a_missing_note_or_an_empty_folder_is_refused_and_writes_nothing() {
    let f = fixture();
    let gone = f.note();
    f.writer.delete(gone.clone()).expect("delete");
    let locks = f.vault.locks();

    for target in ["no-such-note", gone.as_str()] {
        assert!(
            matches!(
                locks.set(TargetKind::Note, target, true),
                Err(StorageError::NotFound { .. })
            ),
            "{target}"
        );
    }
    for target in ["", "/", "\\"] {
        assert!(
            matches!(
                locks.set(TargetKind::Folder, target, true),
                Err(StorageError::Invalid { .. })
            ),
            "{target:?}"
        );
    }
    assert_eq!(count(&f, "SELECT COUNT(*) FROM vault_locks"), 0);
}

#[test]
fn rows_this_build_cannot_act_on_lock_nothing_and_a_tombstone_locks_again_as_new() {
    let f = fixture();
    let (note, tombstoned) = (f.note(), f.note());
    f.file(&note, "Tags/a.md");
    sql(&f)
        .execute_batch(&format!(
            "INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at)
               VALUES ('tag:Tags', 'tag', 'Tags', 1, 1, 1);
             INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at,
                                      clock, deleted_at)
               VALUES ('note:{tombstoned}', 'note', '{tombstoned}', 1, 1, 1, '{{\"d\":3}}', 9);"
        ))
        .expect("rows from elsewhere");
    let locks = f.vault.locks();

    assert_eq!(locks.list(), Ok(LockState::default()));
    assert_eq!(locks.is_note_locked(&note, None), Ok(false));
    assert_eq!(locks.is_note_locked(&tombstoned, None), Ok(false));
    assert_eq!(
        locks.set(TargetKind::Note, &tombstoned, false),
        Ok(SetOutcome::Unchanged)
    );

    assert_eq!(
        locks.set(TargetKind::Note, &tombstoned, true),
        Ok(SetOutcome::Created)
    );
    let (locked, clock, created_at, _, deleted_at) =
        row(&f, &format!("note:{tombstoned}")).expect("row");
    assert_eq!(
        (locked, clock.as_deref(), deleted_at),
        (true, Some("{\"d\":3}"), None),
        "the clock stays for sync to tick past the tombstone"
    );
    assert!(created_at > 1);
    assert_eq!(locks.is_note_locked(&tombstoned, None), Ok(true));
    assert_eq!(
        count(&f, "SELECT COUNT(*) FROM vault_locks WHERE id = 'tag:Tags'"),
        1,
        "a newer build's row is kept"
    );
}
