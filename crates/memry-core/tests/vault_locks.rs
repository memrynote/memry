//! The vault's read-only locks on a real `data.db` (Step 14e-1, Electron
//! `vault-locks/{registry,store}.ts`): what a lock covers, what it writes, and
//! that it outlives a relaunch.

#![cfg(feature = "markdown")]

use memry_core::api::errors::StorageError;
use memry_core::domain::vault_locks::{FileMode, LockState, SetOutcome, TargetKind};
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
fn a_lock_outlives_a_relaunch_and_an_unlock_keeps_its_row_and_queues_it() {
    let f = fixture();
    let note = f.note();
    let locks = f.vault.locks();

    assert_eq!(
        locks.set(TargetKind::Note, &note, true, "device-a"),
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
        locks.set(TargetKind::Note, &note, false, "device-a"),
        Ok(SetOutcome::Updated)
    );
    assert_eq!(locks.list(), Ok(LockState::default()));
    assert_eq!(locks.is_note_locked(&note, None), Ok(false));
    let (locked, clock, _, _, deleted_at) = row(&f, &format!("note:{note}")).expect("kept");
    assert_eq!(
        (locked, clock.as_deref(), deleted_at),
        (false, Some("{\"device-a\":2}"), None)
    );
    assert!(
        count(
            &f,
            "SELECT COUNT(*) FROM outbox WHERE item_type = 'vault_lock'"
        ) > 0,
        "each change is queued for sync (Step 16)"
    );
    assert_eq!(
        locks.set(TargetKind::Note, &note, true, "device-a"),
        Ok(SetOutcome::Updated)
    );
}

#[test]
fn setting_the_state_a_target_already_has_writes_nothing() {
    let f = fixture();
    let note = f.note();
    let locks = f.vault.locks();

    assert_eq!(
        locks.set(TargetKind::Folder, "Never", false, "device-a"),
        Ok(SetOutcome::Unchanged)
    );
    assert_eq!(
        locks.set(TargetKind::Note, &note, false, "device-a"),
        Ok(SetOutcome::Unchanged)
    );
    assert_eq!(count(&f, "SELECT COUNT(*) FROM vault_locks"), 0);

    locks
        .set(TargetKind::Note, &note, true, "device-a")
        .expect("lock");
    sql(&f)
        .execute("UPDATE vault_locks SET updated_at = 5", [])
        .expect("mark");
    assert_eq!(
        locks.set(TargetKind::Note, &note, true, "device-a"),
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
        locks.set(TargetKind::Folder, "/Projects/", true, "device-a"),
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

/// This build never writes an empty folder target, but a synced row may carry
/// one (Electron reads `folder:` as the vault root): it covers every file.
#[test]
fn a_folder_row_with_an_empty_target_covers_the_whole_vault() {
    let f = fixture();
    let note = f.note();
    f.file(&note, "top.md");
    sql(&f)
        .execute(
            "INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at)
             VALUES ('folder:', 'folder', '', 1, 1, 1)",
            [],
        )
        .expect("a root row from elsewhere");
    let locks = f.vault.locks();

    assert_eq!(locks.is_note_locked(&note, None), Ok(true));
    assert_eq!(
        locks.folder_covering("Deep/down/a.md"),
        Ok(Some(String::new()))
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
        locks.set(TargetKind::Note, &day, true, "device-a"),
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
                locks.set(TargetKind::Note, target, true, "device-a"),
                Err(StorageError::NotFound { .. })
            ),
            "{target}"
        );
    }
    for target in ["", "/", "\\"] {
        assert!(
            matches!(
                locks.set(TargetKind::Folder, target, true, "device-a"),
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
        locks.set(TargetKind::Note, &tombstoned, false, "device-a"),
        Ok(SetOutcome::Unchanged)
    );

    assert_eq!(
        locks.set(TargetKind::Note, &tombstoned, true, "device-a"),
        Ok(SetOutcome::Created)
    );
    let (locked, clock, created_at, _, deleted_at) =
        row(&f, &format!("note:{tombstoned}")).expect("row");
    assert_eq!(
        (locked, clock.as_deref(), deleted_at),
        (true, Some("{\"d\":3,\"device-a\":1}"), None),
        "the new clock ticks past the tombstone's"
    );
    assert!(created_at > 1);
    assert_eq!(locks.is_note_locked(&tombstoned, None), Ok(true));
    assert_eq!(
        count(&f, "SELECT COUNT(*) FROM vault_locks WHERE id = 'tag:Tags'"),
        1,
        "a newer build's row is kept"
    );
}

#[test]
fn a_baseline_is_replaced_whole_and_outlives_a_relaunch_until_dropped() {
    let f = fixture();
    let locks = f.vault.locks();
    assert_eq!(locks.baseline("n1"), Ok(None));
    locks.write_baseline("n1", "first", "h1").expect("write");
    locks.write_baseline("n2", "other", "h2").expect("write");
    locks.write_baseline("n1", "second", "h3").expect("replace");

    let f = f.relaunch();
    let locks = f.vault.locks();
    let kept = locks.baseline("n1").unwrap().expect("kept");
    assert_eq!(
        (kept.content.as_str(), kept.content_hash.as_str()),
        ("second", "h3")
    );
    assert!(kept.updated_at > 1_000_000_000_000, "epoch milliseconds");
    assert_eq!(
        locks.baseline_note_ids(),
        Ok(vec!["n1".to_owned(), "n2".to_owned()])
    );

    locks.delete_baseline("n1").expect("drop");
    assert_eq!(locks.baseline("n1"), Ok(None));
    assert_eq!(locks.baseline_note_ids(), Ok(vec!["n2".to_owned()]));
}

#[test]
fn a_file_mode_record_is_replaced_whole_and_outlives_a_relaunch_until_forgotten() {
    let f = fixture();
    let locks = f.vault.locks();
    assert_eq!(locks.file_mode("a.md"), Ok(None));
    locks.record_file_mode("a.md", 0o644, None).expect("record");
    locks
        .record_file_mode("b/c.png", 0o600, Some("1:2"))
        .expect("record");
    locks
        .record_file_mode("a.md", 0o640, Some("3:4"))
        .expect("replace");

    let f = f.relaunch();
    let locks = f.vault.locks();
    let a = FileMode {
        mode: 0o640,
        identity: Some("3:4".to_owned()),
    };
    assert_eq!(locks.file_mode("a.md"), Ok(Some(a.clone())));
    let c = FileMode {
        mode: 0o600,
        identity: Some("1:2".to_owned()),
    };
    assert_eq!(
        locks.file_modes(),
        Ok(vec![
            ("a.md".to_owned(), a),
            ("b/c.png".to_owned(), c.clone())
        ])
    );

    locks.forget_file_mode("a.md").expect("forget");
    assert_eq!(locks.file_mode("a.md"), Ok(None));
    assert_eq!(locks.file_modes(), Ok(vec![("b/c.png".to_owned(), c)]));
    assert_eq!(
        count(&f, "SELECT COUNT(*) FROM outbox"),
        0,
        "device-local: neither table is queued"
    );
}
