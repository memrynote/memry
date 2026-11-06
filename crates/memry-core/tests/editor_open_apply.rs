//! The editor host on a real `data.db` (Step 14a): a window's edits are stored
//! exactly as sent, queued with their outbox rows, and replayed after a
//! relaunch; a refused or unreplayable document writes and removes nothing.

#![cfg(feature = "markdown")]

use memry_core::api::editor::EditorError;
use memry_core::api::note_files::NoteFiles;
use memry_core::crdt::CrdtError;
use memry_core::crdt::update_log;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::sync::body_debt;
use std::sync::Arc;

use crate::editor_support::{Replica, fixture};

#[test]
fn an_edit_is_stored_as_sent_and_replays_after_a_relaunch() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").expect("open");
    let window = Replica::from_state(1, &opened.state);

    let first = window.type_text("hello ");
    let second = window.type_text("world");
    let a = f
        .editor
        .apply_update(&note, &first, "main")
        .expect("first")
        .expect("changed");
    let b = f
        .editor
        .apply_update(&note, &second, "main")
        .expect("second")
        .expect("changed");

    assert_eq!((a.seq, b.seq), (1, 2));
    assert!(a.outbox_id.is_some() && b.outbox_id.is_some());
    assert_eq!(
        f.local_blobs(&note),
        vec![first, second],
        "stored exactly as received"
    );
    assert_eq!(
        f.queued(&note),
        2,
        "one outbox row per update, in the same commit"
    );

    let f = f.relaunch();
    let reopened = f.editor.open(&note, "main").expect("reopen");
    assert_eq!(
        Replica::from_state(2, &reopened.state).text(),
        "hello world"
    );
    assert!(!reopened.needs_seed);
}

#[test]
fn a_root_this_build_never_names_survives_an_apply_and_a_relaunch() {
    let f = fixture();
    let note = f.note();
    let window = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let update = window.set_foreign("kept", "yes");
    f.editor
        .apply_update(&note, &update, "main")
        .expect("apply");

    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert_eq!(side.foreign("kept").as_deref(), Some("yes"));

    let f = f.relaunch();
    let reopened = Replica::from_state(3, &f.editor.open(&note, "main").expect("reopen").state);
    assert_eq!(reopened.foreign("kept").as_deref(), Some("yes"));
}

#[test]
fn an_empty_body_needs_a_seed_unless_its_server_body_is_owed() {
    let f = fixture();
    let fresh = f.note();
    let owed = f.note();
    f.vault
        .db_handle()
        .call_blocking(|conn| body_debt::owe(conn, &owed))
        .expect("owe");

    assert!(f.editor.open(&fresh, "main").expect("fresh").needs_seed);
    assert!(!f.editor.open(&owed, "main").expect("owed").needs_seed);
}

#[test]
fn bytes_yrs_cannot_decode_are_refused_and_nothing_is_written() {
    let f = fixture();
    let note = f.note();
    f.editor.open(&note, "main").expect("open");

    let refused = f
        .editor
        .apply_update(&note, &[0xff, 0xff, 0xff, 0xff], "main");

    assert!(matches!(
        refused,
        Err(EditorError::Crdt(CrdtError::Undecodable { .. }))
    ));
    assert!(f.local_blobs(&note).is_empty());
    assert_eq!(f.queued(&note), 0);
    let window = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let update = window.type_text("still works");
    f.editor
        .apply_update(&note, &update, "main")
        .expect("a good update after");
}

#[test]
fn a_local_only_note_logs_the_edit_and_queues_nothing() {
    let f = fixture();
    let note = f.note();
    let files: NoteFiles = f.vault.note_files();
    files
        .upsert_stat(NoteFileStat {
            note_id: note.clone(),
            path: "a.md".to_owned(),
            file_type: "markdown".to_owned(),
            mime_type: None,
            file_size: Some(1),
            content_hash: None,
            file_hash: None,
            indexed_at: 1,
        })
        .expect("file row");
    files.set_local_only(&note, true).expect("local only");
    let window = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);

    let applied = f
        .editor
        .apply_update(&note, &window.type_text("private"), "main")
        .expect("apply")
        .expect("changed");

    assert_eq!(applied.outbox_id, None);
    assert_eq!(f.local_blobs(&note).len(), 1);
    assert_eq!(f.queued(&note), 0);
}

#[test]
fn an_id_with_no_live_note_is_refused_before_anything_is_written() {
    let f = fixture();
    let update = Replica::new(1).type_text("orphan");

    assert!(matches!(
        f.editor.open("nonote000000", "main"),
        Err(EditorError::NotFound { .. })
    ));
    assert!(matches!(
        f.editor.apply_update("nonote000000", &update, "main"),
        Err(EditorError::NotFound { .. })
    ));
    assert!(f.local_blobs("nonote000000").is_empty());
    assert_eq!(f.queued("nonote000000"), 0);
}

#[test]
fn a_log_that_does_not_replay_refuses_to_open_and_removes_nothing() {
    let f = fixture();
    let note = f.note();
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            update_log::append_server_update(conn, &note, 1, &[0xff; 4], 1).map_err(|e| {
                memry_core::api::errors::StorageError::Failed {
                    what: e.to_string(),
                }
            })
        })
        .expect("plant a broken row");
    let update = Replica::new(1).type_text("lost?");

    for _ in 0..2 {
        assert!(matches!(
            f.editor.open(&note, "main"),
            Err(EditorError::Unreadable { .. })
        ));
    }
    assert!(matches!(
        f.editor.apply_update(&note, &update, "main"),
        Err(EditorError::Unreadable { .. })
    ));
    assert!(!f.editor.is_open(&note));
    assert!(f.local_blobs(&note).is_empty());
    let kept = f
        .vault
        .db_handle()
        .read_blocking(|conn| {
            Ok(update_log::load_plan(conn, &note)
                .expect("plan")
                .server_updates
                .len())
        })
        .expect("read");
    assert_eq!(kept, 1, "the broken row stays for a later build to read");
}

#[test]
fn holders_decide_what_is_open_and_the_sweep_unloads_after_the_grace_period() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").expect("main");
    f.editor.open(&note, "main").expect("main again");
    f.editor.open(&note, "side").expect("side");
    assert!(f.editor.is_open(&note));
    assert_eq!(f.editor.open_note_ids(), vec![note.clone()]);

    assert!(f.editor.release(&note, "main"));
    assert!(!f.editor.release(&note, "main"), "main held it once");
    assert!(f.editor.is_open(&note));
    assert_eq!(f.editor.release_holder("side"), vec![note.clone()]);
    assert!(!f.editor.is_open(&note));
    assert!(f.editor.open_note_ids().is_empty());

    // An edit that arrives after its window closed still lands.
    let window = Replica::from_state(1, &opened.state);
    f.editor
        .apply_update(&note, &window.type_text("late"), "main")
        .expect("late edit");
    assert!(!f.editor.is_open(&note), "an edit takes no holder");

    assert_eq!(f.editor.sweep(i64::MAX / 2), vec![note.clone()]);
    let reloaded = f.editor.open(&note, "main").expect("reload from the log");
    assert_eq!(Replica::from_state(2, &reloaded.state).text(), "late");
}

#[test]
fn a_state_diff_carries_exactly_what_a_window_lacks() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").expect("main");
    let main = Replica::from_state(1, &opened.state);
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    f.editor
        .apply_update(&note, &side.type_text("from side"), "side")
        .expect("side edit");

    let diff = f
        .editor
        .state_diff(&note, &main.state_vector())
        .expect("diff");
    main.apply(&diff);

    assert_eq!(main.text(), "from side");
    assert_eq!(
        f.editor.state_vector(&note).expect("sv"),
        main.state_vector()
    );
}

#[test]
fn an_update_that_changes_nothing_is_neither_stored_nor_queued() {
    let f = fixture();
    let note = f.note();
    let window = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let typed = window.type_text("hello");
    f.editor
        .apply_update(&note, &typed, "main")
        .expect("typed")
        .expect("changed");
    let erased = window.delete_first(2);
    f.editor
        .apply_update(&note, &erased, "main")
        .expect("erased")
        .expect("changed");

    assert_eq!(
        f.editor.apply_update(&note, &typed, "main"),
        Ok(None),
        "a resend"
    );
    assert_eq!(
        f.editor.apply_update(&note, &erased, "main"),
        Ok(None),
        "a resent delete"
    );
    assert_eq!(
        f.editor.apply_update(&note, &window.full_state(), "main"),
        Ok(None),
        "a sync-step-2 diff of a window that holds nothing new"
    );
    assert_eq!(f.local_blobs(&note), vec![typed, erased]);
    assert_eq!(f.queued(&note), 2);
}

#[test]
fn a_journal_day_body_is_queued_under_the_journal_item_type() {
    let f = fixture();
    f.journal
        .set_tags("2026-04-16".to_owned(), vec!["day".to_owned()])
        .expect("a day record");
    let day = f
        .journal
        .entry_id("2026-04-16".to_owned())
        .expect("read")
        .expect("the day exists");
    let window = Replica::from_state(1, &f.editor.open(&day, "main").expect("open").state);

    f.editor
        .apply_update(&day, &window.type_text("today"), "main")
        .expect("apply")
        .expect("changed");

    assert_eq!(f.queued_types(&day), vec!["journal".to_owned()]);
}

#[test]
fn the_vault_has_one_editor_and_an_evicted_note_replays_on_reopen() {
    let f = fixture();
    assert!(Arc::ptr_eq(
        &f.editor,
        &f.vault.editor(f.store.clone()).expect("again")
    ));
    let first = f.note();
    let window = Replica::from_state(1, &f.editor.open(&first, "main").expect("open").state);
    f.editor
        .apply_update(&first, &window.set_foreign("kept", "yes"), "main")
        .expect("apply");
    f.editor
        .apply_update(&first, &window.type_text("body"), "main")
        .expect("apply");
    f.editor.release(&first, "main");

    for _ in 0..40 {
        let other = f.note();
        f.editor.open(&other, "main").expect("open another");
        f.editor.release(&other, "main");
    }

    let reopened = Replica::from_state(2, &f.editor.open(&first, "main").expect("reopen").state);
    assert_eq!(reopened.text(), "body");
    assert_eq!(reopened.foreign("kept").as_deref(), Some("yes"));
}

/// The window types `hello` and then makes `second`, and the core gets them the
/// other way round, across relaunches: the early edit waits on the one it
/// follows, so it must be stored when it arrives or it is gone at the next
/// replay.
fn sent_out_of_order(second: impl FnOnce(&Replica) -> Vec<u8>) {
    let f = fixture();
    let note = f.note();
    let window = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let first = window.type_text("hello");
    let early = second(&window);

    let held_back = f.editor.apply_update(&note, &early, "main").expect("early");
    assert!(held_back.is_some(), "held back, and new to the document");
    assert_eq!(f.local_blobs(&note), vec![early]);

    let f = f.relaunch();
    f.editor
        .apply_update(&note, &first, "main")
        .expect("first")
        .expect("changed");
    let f = f.relaunch();
    let reopened = Replica::from_state(2, &f.editor.open(&note, "main").expect("reopen").state);
    assert_eq!(reopened.text(), window.text());
}

#[test]
fn an_insert_that_arrives_before_the_one_it_follows_survives_relaunches() {
    sent_out_of_order(|window| window.type_text(" world"));
}

#[test]
fn a_delete_that_arrives_before_the_text_it_removes_survives_relaunches() {
    sent_out_of_order(|window| window.delete_first(2));
}

#[test]
fn an_edit_stuck_waiting_does_not_make_every_later_update_a_change() {
    let f = fixture();
    let note = f.note();
    let window = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let sent = window.type_text("a");
    f.editor.apply_update(&note, &sent, "main").expect("sent");
    let _never_sent = window.type_text("b");
    let stuck = window.type_text("c");
    f.editor.apply_update(&note, &stuck, "main").expect("stuck");

    assert_eq!(
        f.editor.apply_update(&note, &sent, "main"),
        Ok(None),
        "a resend"
    );
    assert_eq!(
        f.editor.apply_update(&note, &stuck, "main"),
        Ok(None),
        "the stuck one again"
    );
    assert_eq!(f.local_blobs(&note).len(), 2);
    assert_eq!(f.queued(&note), 2);
}

#[test]
fn an_open_that_fails_keeps_the_hold_the_holder_already_had() {
    let f = fixture();
    let note = f.note();
    f.editor.open(&note, "main").expect("open");
    let rename = |from: &str, to: &str| {
        let sql = format!("ALTER TABLE {from} RENAME TO {to}");
        f.vault
            .db_handle()
            .call_blocking(move |conn| {
                conn.execute_batch(&sql).map_err(|e| {
                    memry_core::api::errors::StorageError::Failed {
                        what: e.to_string(),
                    }
                })
            })
            .expect("rename");
    };

    rename("meta", "meta_away");
    let failed = f.editor.open(&note, "main");
    rename("meta_away", "meta");

    assert!(failed.is_err(), "the owed-body read failed");
    assert!(f.editor.is_open(&note), "the earlier open still holds it");
}
