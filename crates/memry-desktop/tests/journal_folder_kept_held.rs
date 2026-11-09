//! A held journal day stays held whatever happens on disk afterwards (Step 13m-7b-2b stage c,
//! #3530). The hold is decided once, from the disk when the whole journal folder moved, and kept
//! in the database (`memry_core::domain::notes::place_held`), so the old folder made again (by a
//! folder create, a note create, or by hand) never turns a held day into a crossing: crossed, the
//! day would be deleted and the delete synced. With the old folder there again the setting
//! follows nothing and nothing is refused: the held days wait where they are. A day moved by hand
//! out of the journal, its folder still there, is never held. While the consumer's batch is
//! holding days, the commands refuse instead of following mid-move.
//!
//! | Test                                                              | Rule                               |
//! | ----------------------------------------------------------------- | ---------------------------------- |
//! | the app making the old folder again keeps the held days           | PB: folder create                  |
//! | a note made in the old folder keeps the days another build holds  | PB2: note create, recorded change  |
//! | the old folder made again by hand keeps the held days             | outside `mkdir`                    |
//! | a large day moved by hand is not a moved journal folder           | PA: no hold, nothing refused       |
//! | a command during the batch that holds days does not follow        | the follow waits for the batch     |
//! | a folder moved while unread and renamed again is followed         | first owed path, not the last move |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;

use memry_desktop::journal::folder_follow::pause_follow_after_batch;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::config_path;
use memry_desktop::vault::config::settings::SettingsError;
use vault_env::{Env, QUIET, indexed};

use crate::journal_change::folder;
use crate::journal_folder::{DAY, daily, make_day, outbox, quiet, reopen, row, settles, try_day};
use crate::journal_folder_held::recorded_elsewhere;
use crate::journal_folder_outside::{journal, moved_outside};
use crate::vault_settings::{opened_keeping, stored, update};

/// The day stays the held day in `held` through two opens: never crossed, no delete synced, and
/// the setting still names `journal`.
fn kept_held(e: &mut Env, held: &str) {
    std::thread::sleep(QUIET);
    e.drain();
    reopen(e);
    reopen(e);
    assert!(
        e.rows()
            .contains(&row(DAY, &format!("{held}/2025-01-02.md"))),
        "{:?}",
        e.rows()
    );
    assert!(!outbox(e, DAY).contains(&"delete".to_owned()));
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
}

/// PB: the days moved to `canvases`, where they cannot live, are held. The app then makes
/// `journal` again: no command is refused for it, a day lands there, and the opens after keep
/// the held day a day.
#[test]
fn the_app_making_the_old_folder_again_keeps_the_held_days() {
    let (mut e, notes, _, _) = journal();
    moved_outside(&mut e, "journal", "canvases");
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "journal").unwrap();
    drop(open);
    quiet(&mut e);
    make_day(&notes, &e, "2025-01-07");
    assert!(e.vault.join("journal/2025-01-07.md").exists());
    kept_held(&mut e, "canvases");
}

/// PB2: another build's journal change record holds the days moved to `Diary`; a note made in
/// folder `journal` makes the old folder again. The opens keep the held day, before and after the
/// record goes.
#[test]
fn a_note_made_in_the_old_folder_keeps_the_days_another_build_holds() {
    let (mut e, notes, _, _) = journal();
    recorded_elsewhere(&e, true);
    moved_outside(&mut e, "journal", "Diary");
    let open = e.session.current().unwrap();
    let note = NewNoteFile {
        title: "Later".into(),
        content: "A note\n".into(),
        folder: Some("journal".into()),
        ..Default::default()
    };
    notes.create(&open, note).unwrap();
    drop(open);
    kept_held(&mut e, "Diary");
    recorded_elsewhere(&e, false);
    kept_held(&mut e, "Diary");
}

/// The old folder made again by hand while the days wait in `canvases`.
#[test]
fn the_old_folder_made_again_by_hand_keeps_the_held_days() {
    let (mut e, notes, _, _) = journal();
    moved_outside(&mut e, "journal", "canvases");
    fs::create_dir(e.vault.join("journal")).unwrap();
    quiet(&mut e);
    make_day(&notes, &e, "2025-01-07");
    kept_held(&mut e, "canvases");
}

/// PA: a day of the large-file class moved by hand to `Notes/`, `journal/` still there, is owed
/// its move (the large file is never read to cross it) and never held. Day creates go on, the
/// setting never follows to `Notes`, a journal setting change goes on, and once the file is
/// small again it crosses into a note, as a day moved out of the journal does (Electron's
/// `renameKeepsJournalDate`).
#[test]
fn a_large_day_moved_by_hand_is_not_a_moved_journal_folder() {
    let (mut e, store) = opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    fs::write(
        e.vault.join("journal/2025-01-02.md"),
        "word ".repeat(40 * 1024),
    )
    .unwrap();
    quiet(&mut e);
    assert!(e.rows().contains(&row(DAY, "journal/2025-01-02.md")));
    fs::create_dir(e.vault.join("Notes")).unwrap();
    fs::rename(
        e.vault.join("journal/2025-01-02.md"),
        e.vault.join("Notes/2025-01-02.md"),
    )
    .unwrap();
    quiet(&mut e);
    make_day(&notes, &e, "2025-01-07");
    assert!(e.vault.join("journal/2025-01-07.md").exists());
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    std::thread::sleep(QUIET);
    e.drain();
    reopen(&mut e);
    make_day(&notes, &e, "2025-01-08");
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    assert!(e.rows().contains(&row(DAY, "Notes/2025-01-02.md")));
    update(&e, folder("Other"), |_| {}).unwrap();
    assert_eq!(stored(&e.vault)["journalFolder"], "Other");
    fs::write(e.vault.join("Notes/2025-01-02.md"), "A day\n").unwrap();
    std::thread::sleep(QUIET);
    e.drain();
    e.close();
    e.drain();
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(QUIET);
    e.drain();
    let rows = e.rows();
    let at = rows.iter().find(|(_, path)| path == "Notes/2025-01-02.md");
    assert!(at.is_some_and(|(id, _)| id != DAY), "{rows:?}");
}

/// While the consumer's batch holds the days of a folder moved outside and has not followed
/// yet, a day create and a journal setting change are refused rather than following mid-move.
/// Once the batch's follow runs, the setting follows.
#[test]
fn a_command_during_the_batch_that_holds_days_does_not_follow() {
    let (mut e, notes, _, note) = journal();
    let root = e.session.current().unwrap().path.clone();
    let paused = pause_follow_after_batch(&root);
    moved_outside(&mut e, "journal", "Diary");
    let refused = try_day(&notes, &e, "2025-01-07");
    assert!(
        matches!(refused, Err(NotesError::JournalFolderHeld)),
        "{refused:?}"
    );
    let refused = update(&e, folder("Other"), |_| panic!("announced"));
    assert!(
        matches!(refused, Err(SettingsError::JournalFolderHeld)),
        "{refused:?}"
    );
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    drop(paused);
    std::thread::sleep(QUIET);
    e.drain();
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    settles(&mut e, &notes, &note, "Diary");
}

/// Moved while the settings cannot be read, the day is owed but not held (the journal folder is
/// unknown). Renamed again once they read, the move is read from where the day was before its
/// first owed move, so it is the journal moving on: held, and followed after the batch. Read
/// from the last move alone, the day would leave the journal and cross into a note.
#[test]
fn a_folder_moved_while_unread_and_renamed_again_is_followed() {
    let (mut e, notes, _, note) = journal();
    fs::write(config_path(&e.vault), "{").unwrap();
    moved_outside(&mut e, "journal", "Diary");
    fs::write(config_path(&e.vault), daily("journal").to_string()).unwrap();
    moved_outside(&mut e, "Diary", "Diary2");
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary2");
    settles(&mut e, &notes, &note, "Diary2");
}
