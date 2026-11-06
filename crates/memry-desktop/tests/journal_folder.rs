//! The journal folder moved in the app (Step 13m-7b-2, #3530), on an open vault whose days the
//! app's own identity (`NotesIdentity`) names. A day is a day only while its path is in the
//! configured folder and format, so the move takes the setting along, the setting always
//! follows the folder on disk, and whatever a crash leaves pairs as the day. No record is
//! deleted, so no delete syncs.
//!
//! | Test                                                              | Rule                                  |
//! | ----------------------------------------------------------------- | ------------------------------------- |
//! | moving the journal folder takes the setting along                 | `followJournalFolderMove`             |
//! | moving a folder that holds the journal takes the setting along    | `followJournalFolderMove`             |
//! | a note a date names moves with the journal folder as a note       | `renameKeepsJournalDate`              |
//! | respelling the journal folder takes the setting along             | case only                             |
//! | a journal folder held open is not moved entry by entry            | #3957, whole or not at all            |
//! | a journal folder whose notes cannot follow goes back              | the setting goes back first           |
//! | a journal folder whose setting cannot go back stays moved         | the setting follows the disk          |
//! | a journal folder that cannot go back keeps the followed setting   | the setting follows the disk          |
//! | no folder moves while the settings are unread                     | no setting, no move                   |
//! | a journal folder stored unnormalized takes the setting along      | read as the days are                  |
//! | a journal folder move a crash cut short keeps its days            | the open follows, before the lane     |
//! | ... a crash cut short waits for readable settings                 | the move waits with its records       |
//! | ... a day made once the settings read again lands beside its days | the follow before a day is named      |
//! | ... a folder made where it was still finishes                     | moved on disk: `to` and the notes     |
//! | a folder moved by hand after an app move keeps its notes          | no ownership left behind              |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::io;
use std::sync::{Arc, Mutex};

use memry_core::domain::notes::app_move::AppMoved;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::journal::write::NewDay;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::{VaultConfig, config_path};
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::move_dir::{Step, simulated_hold};
use serde_json::{Value, json};
use vault_env::{Env, QUIET, indexed};

use crate::vault_settings::{opened_keeping, stored};

const DAY: &str = "j2025-01-02";

fn daily(folder: &str) -> Value {
    json!({
        "journalFolder": folder,
        "journalDateFormat": "YYYY-MM-DD",
        "journalShowInSidebar": true
    })
}

fn row(id: &str, path: &str) -> (String, String) {
    (id.to_owned(), path.to_owned())
}

fn journal_vault(config: Value, files: &[(&str, &str)]) -> (Env, Arc<NotesService>) {
    let (e, store) = opened_keeping(config, files);
    let notes = NotesService::new(e.tier.clone(), store);
    (e, notes)
}

fn crossed(facts: &[Applied]) -> bool {
    facts
        .iter()
        .any(|f| matches!(f, Applied::Added { .. } | Applied::Removed { .. }))
}

/// The facts once the watcher is quiet: it made and removed no note.
fn quiet(e: &mut Env) {
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(!crossed(&facts), "{facts:?}");
}

/// Closes and opens the vault again: the open made and removed no note.
fn reopen(e: &mut Env) {
    e.close();
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(!crossed(&facts), "{facts:?}");
    quiet(e);
}

/// The sync operations queued for the record `id`: a `delete` reaches every device.
fn outbox(e: &Env, id: &str) -> Vec<String> {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            let mut stmt = conn
                .prepare("SELECT op FROM outbox WHERE item_id = ?1")
                .unwrap();
            let ops = stmt.query_map([id], |r| r.get::<_, String>(0)).unwrap();
            Ok(ops.map(Result::unwrap).collect::<Vec<_>>())
        })
        .unwrap()
}

fn try_day(notes: &NotesService, e: &Env, date: &str) -> Result<(), NotesError> {
    let open = e.session.current().unwrap();
    let day = NewDay {
        date: date.to_owned(),
        content: "Later".to_owned(),
        ..NewDay::default()
    };
    notes.create_day(&open, day).map(drop)
}

fn make_day(notes: &NotesService, e: &Env, date: &str) {
    try_day(notes, e, date).unwrap();
}

/// A note whose title is a date, in the journal folder: a note at a day's path.
fn dated_note(notes: &NotesService, e: &mut Env) -> String {
    let open = e.session.current().unwrap();
    let note = NewNoteFile {
        title: "2025-01-05".into(),
        content: "A note\n".into(),
        folder: Some("journal".into()),
        ..Default::default()
    };
    let id = notes.create(&open, note).unwrap().id;
    std::thread::sleep(QUIET);
    e.drain();
    id
}

/// Each day moves as a day, read under the folder it follows to: no move is left owed.
#[test]
fn moving_the_journal_folder_takes_the_setting_along() {
    let (mut e, store) = opened_keeping(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/Ideas.md", "A note\n"),
        ],
    );
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let ideas = e.rows()[1].0.clone();
    let synced = outbox(&e, DAY);
    let open = e.session.current().unwrap();
    let heard: Mutex<Option<VaultConfig>> = Mutex::default();
    notes
        .rename_folder(&open, "journal", "Diary", |settings| {
            *heard.lock().unwrap() = Some(settings.clone());
        })
        .unwrap();

    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    let owed = e.core().notes_writer(store).unwrap().owed_places().unwrap();
    assert!(owed.is_empty(), "{owed:?}");
    let heard = heard.into_inner().unwrap().expect("announced");
    assert_eq!(heard.journal_folder, "Diary");
    quiet(&mut e);
    assert_eq!(
        e.rows(),
        [
            row(DAY, "Diary/2025-01-02.md"),
            row(&ideas, "Diary/Ideas.md")
        ]
    );
    make_day(&notes, &e, "2025-01-06");
    assert!(e.vault.join("Diary/2025-01-06.md").exists());
    // A day's path is never synced: its move queues nothing.
    assert_eq!(outbox(&e, DAY), synced);
}

#[test]
fn moving_a_folder_that_holds_the_journal_takes_the_setting_along() {
    let (mut e, notes) = journal_vault(
        daily("Personal/journal"),
        &[("Personal/journal/2025-01-02.md", "A day\n")],
    );
    fs::create_dir(e.vault.join("Archive")).unwrap();
    let open = e.session.current().unwrap();
    notes
        .rename_folder(&open, "Personal", "Archive/Personal", |_| {})
        .unwrap();

    assert_eq!(
        stored(&e.vault)["journalFolder"],
        "Archive/Personal/journal"
    );
    quiet(&mut e);
    assert_eq!(
        e.rows(),
        [row(DAY, "Archive/Personal/journal/2025-01-02.md")]
    );
}

/// A respelling in case only is a move of the journal folder too.
#[test]
fn respelling_the_journal_folder_takes_the_setting_along() {
    let (mut e, notes) = journal_vault(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let open = e.session.current().unwrap();
    notes
        .rename_folder(&open, "journal", "Journal", |_| {})
        .unwrap();
    drop(open);

    assert_eq!(stored(&e.vault)["journalFolder"], "Journal");
    quiet(&mut e);
    reopen(&mut e);
    assert_eq!(e.rows(), [row(DAY, "Journal/2025-01-02.md")]);
    assert!(!outbox(&e, DAY).contains(&"delete".to_owned()));
}

/// A note at a day's path stays that note: read as a day after the move, its next open would
/// delete it and make the day.
#[test]
fn a_note_a_date_names_moves_with_the_journal_folder_as_a_note() {
    let (mut e, store) = opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let note = dated_note(&notes, &mut e);
    let open = e.session.current().unwrap();
    notes
        .rename_folder(&open, "journal", "Diary", |_| {})
        .unwrap();

    let owed = e.core().notes_writer(store).unwrap().owed_places().unwrap();
    assert!(owed.is_empty(), "{owed:?}");
    quiet(&mut e);
    drop(open);
    reopen(&mut e);
    let rows = e.rows();
    assert!(
        rows.contains(&row(&note, "Diary/2025-01-05.md")),
        "{rows:?}"
    );
    assert!(rows.contains(&row(DAY, "Diary/2025-01-02.md")), "{rows:?}");
    assert!(!outbox(&e, &note).contains(&"delete".to_owned()));
}

/// The journal folder moves by the plain rename only: one Windows holds (#3957) is refused as
/// it is, never moved entry by entry, whose rollback could leave days in `(incomplete move)`.
#[test]
fn a_journal_folder_held_open_is_not_moved_entry_by_entry() {
    let (mut e, notes) = journal_vault(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let open = e.session.current().unwrap();
    let mut held = |step: Step<'_>| match step {
        Step::Whole { .. } => Err(simulated_hold()),
        _ => Ok(()),
    };
    let refused = notes.rename_folder_checked(
        &open,
        "journal",
        "Diary",
        |_| panic!("announced"),
        &mut held,
        &mut || Ok(()),
    );

    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    assert!(e.vault.join("journal/2025-01-02.md").exists());
    let names: Vec<String> = fs::read_dir(&e.vault)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(
        !names.iter().any(|name| name.starts_with(".memry-move-")),
        "{names:?}"
    );
    quiet(&mut e);
    assert_eq!(e.rows(), [row(DAY, "journal/2025-01-02.md")]);
}

/// The old folder is saved again as the days read it (`/journal/` is `journal`).
#[test]
fn a_journal_folder_whose_notes_cannot_follow_goes_back() {
    let (mut e, notes) = journal_vault(daily("/journal/"), &[("journal/2025-01-02.md", "A day\n")]);
    let open = e.session.current().unwrap();
    let failed = notes.rename_folder_checked(
        &open,
        "journal",
        "Diary",
        |_| panic!("announced"),
        &mut |_| Ok(()),
        &mut || Err(NotesError::Io(io::Error::other("injected"))),
    );

    assert!(matches!(failed, Err(NotesError::Io(_))), "{failed:?}");
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    assert!(e.vault.join("journal/2025-01-02.md").exists());
    assert!(!e.vault.join("Diary").exists());
    quiet(&mut e);
    assert_eq!(e.rows(), [row(DAY, "journal/2025-01-02.md")]);
}

/// What every path here must end in: the journal days and the dated note in `folder`, which the
/// setting names, through a day made later and two more opens, and no record deleted.
fn settles(e: &mut Env, notes: &NotesService, note: &str, folder: &str) {
    reopen(e);
    assert_eq!(stored(&e.vault)["journalFolder"], folder);
    make_day(notes, e, "2025-01-06");
    assert!(e.vault.join(format!("{folder}/2025-01-06.md")).exists());
    std::thread::sleep(QUIET);
    e.drain();
    reopen(e);
    reopen(e);
    let rows = e.rows();
    for (id, name) in [(DAY, "2025-01-02.md"), (note, "2025-01-05.md")] {
        assert!(
            rows.contains(&row(id, &format!("{folder}/{name}"))),
            "{rows:?}"
        );
        assert!(!outbox(e, id).contains(&"delete".to_owned()), "{id}");
    }
}

/// The folder stays moved with its rows behind: an outside edit of a file it carried shows the
/// watcher a file no row names, which is the moved note's (its move's record names it), never a
/// new note or day.
fn edited_outside(e: &mut Env) {
    quiet(e);
    e.write("Diary/2025-01-05.md", "Edited outside\n");
    quiet(e);
}

/// Step 3 fails and the old folder cannot be saved again: the folder stays where the saved
/// setting reads it, its files the app's own until the next open finishes the move as days and
/// the dated note as that note.
#[cfg(unix)]
#[test]
fn a_journal_folder_whose_setting_cannot_go_back_stays_moved() {
    use std::os::unix::fs::PermissionsExt as _;

    let (mut e, notes) = journal_vault(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let note = dated_note(&notes, &mut e);
    let open = e.session.current().unwrap();
    let memry = e.vault.join(".memry");
    let heard: Mutex<Option<VaultConfig>> = Mutex::default();
    let failed = notes.rename_folder_checked(
        &open,
        "journal",
        "Diary",
        |settings| *heard.lock().unwrap() = Some(settings.clone()),
        &mut |_| Ok(()),
        &mut || {
            fs::set_permissions(&memry, fs::Permissions::from_mode(0o555)).unwrap();
            Err(NotesError::Io(io::Error::other("injected")))
        },
    );
    fs::set_permissions(&memry, fs::Permissions::from_mode(0o755)).unwrap();
    drop(open);

    assert!(matches!(failed, Err(NotesError::Io(_))), "{failed:?}");
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    assert_eq!(heard.into_inner().unwrap().unwrap().journal_folder, "Diary");
    assert!(e.vault.join("Diary/2025-01-02.md").exists());
    edited_outside(&mut e);
    settles(&mut e, &notes, &note, "Diary");
}

/// Step 3 fails and the folder cannot go back: the setting follows it again, and its files are
/// the app's own until the next open finishes the move.
#[test]
fn a_journal_folder_that_cannot_go_back_keeps_the_followed_setting() {
    let (mut e, notes) = journal_vault(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let note = dated_note(&notes, &mut e);
    let open = e.session.current().unwrap();
    let mut wholes = 0;
    let mut second_held = |step: Step<'_>| match step {
        Step::Whole { .. } => {
            wholes += 1;
            if wholes == 2 {
                Err(simulated_hold())
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    };
    let heard: Mutex<Option<VaultConfig>> = Mutex::default();
    let failed = notes.rename_folder_checked(
        &open,
        "journal",
        "Diary",
        |settings| *heard.lock().unwrap() = Some(settings.clone()),
        &mut second_held,
        &mut || Err(NotesError::Io(io::Error::other("injected"))),
    );
    drop(open);

    assert!(matches!(failed, Err(NotesError::Io(_))), "{failed:?}");
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    assert_eq!(heard.into_inner().unwrap().unwrap().journal_folder, "Diary");
    assert!(e.vault.join("Diary/2025-01-02.md").exists());
    edited_outside(&mut e);
    settles(&mut e, &notes, &note, "Diary");
}

/// Settings that cannot be read do not say where the journal is (here `Diary`, not the
/// default), so no folder moves, the journal folder or any other.
#[test]
fn no_folder_moves_while_the_settings_are_unread() {
    let (e, notes) = journal_vault(
        daily("Diary"),
        &[
            ("Diary/2025-01-02.md", "A day\n"),
            ("Notes/Idea.md", "An idea\n"),
        ],
    );
    fs::write(config_path(&e.vault), "{").unwrap();
    let open = e.session.current().unwrap();
    for (from, to) in [("Diary", "Old"), ("Notes", "Other")] {
        let refused = notes.rename_folder(&open, from, to, |_| panic!("announced"));
        assert!(
            matches!(refused, Err(NotesError::SettingsUnreadable(_))),
            "{from}: {refused:?}"
        );
        assert!(e.vault.join(from).exists());
    }
}

/// The setting is read as the days are: `/Personal/journal/` names `Personal/journal`, and
/// follows its folder.
#[test]
fn a_journal_folder_stored_unnormalized_takes_the_setting_along() {
    let (mut e, notes) = journal_vault(
        daily("/Personal/journal/"),
        &[("Personal/journal/2025-01-02.md", "A day\n")],
    );
    let open = e.session.current().unwrap();
    notes
        .rename_folder(&open, "Personal", "Archive", |_| {})
        .unwrap();
    drop(open);

    assert_eq!(stored(&e.vault)["journalFolder"], "Archive/journal");
    quiet(&mut e);
    reopen(&mut e);
    assert_eq!(e.rows(), [row(DAY, "Archive/journal/2025-01-02.md")]);
    assert!(!outbox(&e, DAY).contains(&"delete".to_owned()));
}

/// The state a crash after the journal folder moved on disk leaves, before its notes followed:
/// the folder's and each note's record, the folder at `Diary`, the setting at `config`.
fn crashed_after_disk(e: &mut Env, store: &Arc<dyn SecureStore>, note: &str, config: &str) {
    let writer = e.core().notes_writer(store.clone()).unwrap();
    let moved = |old_path, new_path| AppMoved {
        old_path,
        new_path,
        title: None,
        keeps_kind: true,
    };
    let moves = [
        (DAY, moved("journal/2025-01-02.md", "Diary/2025-01-02.md")),
        (note, moved("journal/2025-01-05.md", "Diary/2025-01-05.md")),
    ];
    writer
        .begin_folder_move("journal", "Diary", &moves)
        .unwrap();
    drop(writer);
    e.close();
    fs::rename(e.vault.join("journal"), e.vault.join("Diary")).unwrap();
    fs::write(config_path(&e.vault), daily(config).to_string()).unwrap();
    e.drain();
}

/// A crash after the journal folder moved on disk, before its notes followed, with the setting
/// saved or not yet: the next open has the setting follow the folder before it finishes the
/// move, so each day finishes as a day and the dated note as that note.
#[test]
fn a_journal_folder_move_a_crash_cut_short_keeps_its_days() {
    for config in ["journal", "Diary"] {
        let (mut e, store) =
            opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
        let notes = NotesService::new(e.tier.clone(), store.clone());
        let note = dated_note(&notes, &mut e);
        crashed_after_disk(&mut e, &store, &note, config);

        e.open();
        let facts = e.facts_until(indexed);
        assert!(!crossed(&facts), "{config}: {facts:?}");
        quiet(&mut e);
        settles(&mut e, &notes, &note, "Diary");
    }
}

/// The same crash, and the next open cannot read the settings: the folder's move waits, with
/// its notes' records, for an open that can, which finishes it as above.
#[test]
fn a_journal_folder_move_a_crash_cut_short_waits_for_readable_settings() {
    for config in ["journal", "Diary"] {
        let (mut e, store) =
            opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
        let notes = NotesService::new(e.tier.clone(), store.clone());
        let note = dated_note(&notes, &mut e);
        crashed_after_disk(&mut e, &store, &note, config);
        fs::write(config_path(&e.vault), "{").unwrap();

        e.open();
        let facts = e.facts_until(indexed);
        assert!(!crossed(&facts), "{config}: {facts:?}");
        quiet(&mut e);
        // Named under the defaults, the day would sit in `journal/`, which the setting may not
        // read once it does.
        let refused = try_day(&notes, &e, "2025-01-06");
        assert!(
            matches!(refused, Err(NotesError::SettingsUnreadable(_))),
            "{config}: {refused:?}"
        );
        assert!(!e.vault.join("journal").exists());
        fs::write(config_path(&e.vault), daily(config).to_string()).unwrap();
        settles(&mut e, &notes, &note, "Diary");
    }
}

/// The same, and the settings read again before the next open: a day made then has the setting
/// follow the folder first, so it lands beside the other days, never in `journal/` again.
#[test]
fn a_journal_folder_move_a_crash_cut_short_lands_a_later_day_beside_its_days() {
    for config in ["journal", "Diary"] {
        let (mut e, store) =
            opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
        let notes = NotesService::new(e.tier.clone(), store.clone());
        let note = dated_note(&notes, &mut e);
        crashed_after_disk(&mut e, &store, &note, config);
        fs::write(config_path(&e.vault), "{").unwrap();
        e.open();
        e.facts_until(indexed);
        quiet(&mut e);
        fs::write(config_path(&e.vault), daily(config).to_string()).unwrap();

        make_day(&notes, &e, "2025-01-07");
        assert_eq!(stored(&e.vault)["journalFolder"], "Diary", "{config}");
        assert!(e.vault.join("Diary/2025-01-07.md").exists(), "{config}");
        assert!(!e.vault.join("journal").exists(), "{config}");
        std::thread::sleep(QUIET);
        e.drain();
        settles(&mut e, &notes, &note, "Diary");
    }
}

/// A crash before the setting followed, and a folder made where the journal was before the next
/// open: the folder still moved (its notes are at their new paths), so the open finishes it.
/// Forgotten, each day would settle alone under the old setting and cross into a note.
#[test]
fn a_journal_folder_move_a_crash_cut_short_with_a_folder_made_where_it_was_still_finishes() {
    let (mut e, store) = opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let note = dated_note(&notes, &mut e);
    crashed_after_disk(&mut e, &store, &note, "journal");
    fs::create_dir(e.vault.join("journal")).unwrap();

    e.open();
    let facts = e.facts_until(indexed);
    assert!(!crossed(&facts), "{facts:?}");
    quiet(&mut e);
    settles(&mut e, &notes, &note, "Diary");
}

/// A folder the app moved, then moved by hand: nothing of the app's move is left to claim the
/// files, so each hand move pairs as a move of the same notes. `Notes` to `Other` in the app
/// and back and forth by hand (R6); and the app's move undone after its rows did not follow,
/// then made by hand (R5).
#[test]
fn a_folder_moved_by_hand_after_an_app_move_keeps_its_notes() {
    for undone in [false, true] {
        let (mut e, notes) = journal_vault(
            daily("journal"),
            &[("Notes/A.md", "Note A\n"), ("Notes/B.md", "Note B\n")],
        );
        let ids: Vec<String> = e.rows().into_iter().map(|(id, _)| id).collect();
        let open = e.session.current().unwrap();
        let moved = notes.rename_folder_checked(
            &open,
            "Notes",
            "Other",
            |_| panic!("announced"),
            &mut |_| Ok(()),
            &mut || match undone {
                true => Err(NotesError::Io(io::Error::other("injected"))),
                false => Ok(()),
            },
        );
        drop(open);
        assert_eq!(moved.is_err(), undone);
        quiet(&mut e);
        let hops = if undone {
            ["Notes", "Other"].as_slice()
        } else {
            ["Other", "Notes", "Other"].as_slice()
        };
        for pair in hops.windows(2) {
            fs::rename(e.vault.join(pair[0]), e.vault.join(pair[1])).unwrap();
            quiet(&mut e);
        }
        reopen(&mut e);
        let rows = e.rows();
        for (id, name) in ids.iter().zip(["A.md", "B.md"]) {
            assert!(
                rows.contains(&row(id, &format!("Other/{name}"))),
                "{rows:?}"
            );
            assert!(!outbox(&e, id).contains(&"delete".to_owned()), "{id}");
        }
    }
}
