//! What a journal setting change waits on, and what waits on it (Step 13m-7b-2b, #3530): a
//! change starts only once an interrupted journal folder move settled, and a change whose days
//! cannot go back holds both its folders against a folder move and a folder delete until they do
//! (`vault::journal_rename::finish_journal_change`).

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;

use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::config_path;
use memry_desktop::vault::config::settings::SettingsError;
use vault_env::{Env, indexed};

use crate::journal_change::folder;
use crate::journal_change_crash::{change_killed, reopened, settled, two_days};
use crate::journal_folder::{
    DAY, crashed_after_disk, crossed, daily, dated_note, outbox, quiet, reopen, row, settles,
};
use crate::vault_settings::{opened_keeping, stored, update};

/// A journal folder move a crash cut short after the folder moved on disk, with the settings
/// unreadable at the next open: the move waits with its days' records. A journal folder change
/// meanwhile is refused, since the days it would list are not where the saved setting says;
/// saved anyway, the next open would settle the waiting moves under the new setting as crossings
/// and delete the days. The open after it finishes the move as before.
#[test]
fn a_journal_folder_change_waits_for_an_interrupted_journal_folder_move() {
    let (mut e, store) = opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let note = dated_note(&notes, &mut e);
    crashed_after_disk(&mut e, &store, &note, "journal");
    fs::write(config_path(&e.vault), "{").unwrap();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(!crossed(&facts), "{facts:?}");
    fs::write(config_path(&e.vault), daily("journal").to_string()).unwrap();

    let refused = update(&e, folder("Other"), |_| panic!("announced"));
    assert!(
        matches!(refused, Err(SettingsError::MovesWait)),
        "{refused:?}"
    );
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    assert!(!e.vault.join("Other").exists());
    settles(&mut e, &notes, &note, "Diary");
    for id in [DAY, note.as_str()] {
        assert!(!outbox(&e, id).contains(&"delete".to_owned()), "{id}");
    }
}

/// A change to `Box/Diary` whose moved day cannot go back (a folder took its old path): until it
/// can, no folder move or delete takes a folder that is, holds or is inside either the folder its
/// days left or the one they wait in, where each would leave a day outside the saved journal; a
/// note move or rename takes no day at all. A folder apart from both still moves. Once the path is free, the next open puts the
/// day back.
#[test]
fn a_journal_change_that_waits_holds_both_its_folders() {
    let (mut e, notes, store, note) = two_days();
    let (_, killed) = change_killed(&e, folder("Box/Diary"), Some(3));
    assert!(killed);
    e.close();
    for dir in [
        "journal/2025-01-02.md",
        "journal/Inner",
        "Box/Diary/Inner",
        "Apart",
    ] {
        fs::create_dir_all(e.vault.join(dir)).unwrap();
    }
    e.drain();
    e.open();
    e.facts_until(indexed);
    quiet(&mut e);

    let open = e.session.current().unwrap();
    for held in [
        "journal",
        "journal/Inner",
        "Box",
        "Box/Diary",
        "Box/Diary/Inner",
    ] {
        let moved = notes.rename_folder(&open, held, "Moved", |_| panic!("announced"));
        assert!(
            matches!(moved, Err(NotesError::JournalChangeWaits)),
            "{held}: {moved:?}"
        );
    }
    for held in ["Box", "Box/Diary", "Box/Diary/Inner"] {
        let deleted = notes.delete_folder(&open, held);
        assert!(
            matches!(deleted, Err(NotesError::JournalChangeWaits)),
            "{held}: {deleted:?}"
        );
    }
    // A day is no note a note move or rename takes, waiting or not.
    let moved = notes.move_to_folder(&open, DAY, "Apart");
    assert!(matches!(moved, Err(NotesError::NotFound(_))), "{moved:?}");
    let renamed = notes.rename(&open, DAY, "Renamed");
    assert!(
        matches!(renamed, Err(NotesError::NotFound(_))),
        "{renamed:?}"
    );
    notes
        .rename_folder(&open, "Apart", "Moved", |_| panic!("announced"))
        .unwrap();
    drop(open);
    assert!(e.vault.join("Box/Diary/2025-01-02.md").exists());
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    assert!(!crossed(&e.drain()));

    fs::remove_dir(e.vault.join("journal/2025-01-02.md")).unwrap();
    quiet(&mut e);
    reopened(&mut e);
    assert!(e.vault.join("journal/2025-01-02.md").is_file());
    settled(&mut e, &notes, &store, &note);
}

/// A note's move that a newer build recorded and this one cannot finish (one that settles at the
/// open needs a crash and an open that cannot finish it, which a lone note move does not leave):
/// while it waits, a journal folder change is refused (`journal_moves_wait`), since that note may
/// be a day whose file is where the saved setting does not read it. Once the record is gone, the
/// change goes through.
#[test]
fn a_journal_folder_change_waits_for_a_note_move_this_build_cannot_finish() {
    let (mut e, _store) = opened_keeping(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("Notes/Plan.md", "A plan\n"),
        ],
    );
    let (id, _) = e
        .rows()
        .into_iter()
        .find(|(_, at)| at == "Notes/Plan.md")
        .unwrap();
    let key = format!("notes.app_move.v1:{id}");
    let meta = |e: &Env, sql: &'static str, key: &str| {
        let key = key.to_owned();
        e.core()
            .db_handle()
            .call_blocking(move |conn| Ok(conn.execute(sql, [key]).unwrap()))
            .unwrap();
    };
    meta(
        &e,
        r#"INSERT INTO meta (key, value) VALUES (?1, '{"version":2}')"#,
        &key,
    );

    let refused = update(&e, folder("Diary"), |_| panic!("announced"));
    assert!(
        matches!(refused, Err(SettingsError::MovesWait)),
        "{refused:?}"
    );
    assert!(e.vault.join("journal/2025-01-02.md").exists());
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    meta(&e, "DELETE FROM meta WHERE key = ?1", &key);
    update(&e, folder("Diary"), |_| {}).unwrap();
    assert!(e.vault.join("Diary/2025-01-02.md").exists());
    reopen(&mut e);
    assert!(e.rows().contains(&row(DAY, "Diary/2025-01-02.md")));
    assert!(!outbox(&e, DAY).contains(&"delete".to_owned()));
}
