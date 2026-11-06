//! The journal folder changed in Settings or moved in the app (Step 13m-7b-2, #3530), on an
//! open vault whose days the app's own identity (`NotesIdentity`) names. A day is a day only
//! while its path is in the configured folder and format, so each change moves the days and the
//! setting together, and whatever a crash leaves between the two still pairs as the day.
//!
//! | Test                                                              | Rule                                  |
//! | ----------------------------------------------------------------- | ------------------------------------- |
//! | a journal folder change moves the days and keeps them             | `updateConfig`, days moved here       |
//! | a folder and format change together move each day once            | one pass                              |
//! | a crash mid folder change keeps each day on the next open         | row first, under the saved folder     |
//! | between a day's two moves its file keeps the saved folder         | the order, pinned                     |
//! | a day made during a folder change lands in the new folder         | `DAY_NAMES`                           |
//! | a folder a day cannot move into is refused and every day stays    | every day or none                     |
//! | a folder the config does not take puts the days back              | its new folder goes too               |
//! | a day held open refuses the folder and the others come back       | #3957, Windows holds                  |
//! | a folder the days cannot live in is refused                       | root, hidden, excluded, links, case   |
//! | moving the journal folder takes the setting along                 | `followJournalFolderMove`             |
//! | moving a folder that holds the journal takes the setting along    | `followJournalFolderMove`             |
//! | a journal folder held open is not moved entry by entry            | #3957, whole or not at all            |
//! | a journal folder whose notes cannot follow goes back              | the setting goes back first           |
//! | a journal folder move a crash cut short keeps its days            | before and after the setting's save   |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::domain::notes::app_move::AppMoved;
use memry_desktop::journal::write::NewDay;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::settings::{SettingsError, update_vault_settings_checked};
use memry_desktop::vault::config::{VaultConfig, VaultConfigPatch, config_path};
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::move_dir::{Step, simulated_hold};
use serde_json::{Value, json};
use vault_env::{Env, QUIET, indexed};

use crate::vault_settings::{opened, opened_keeping, stored, update};

const DAY: &str = "j2025-01-02";

fn daily(folder: &str) -> Value {
    json!({
        "journalFolder": folder,
        "journalDateFormat": "YYYY-MM-DD",
        "journalShowInSidebar": true
    })
}

fn folder(to: &str) -> VaultConfigPatch {
    VaultConfigPatch {
        journal_folder: Some(to.to_owned()),
        ..VaultConfigPatch::default()
    }
}

fn row(id: &str, path: &str) -> (String, String) {
    (id.to_owned(), path.to_owned())
}

/// The facts once the watcher is quiet: it made and removed no note.
fn quiet(e: &mut Env) {
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(
        !facts
            .iter()
            .any(|f| matches!(f, Applied::Added { .. } | Applied::Removed { .. })),
        "{facts:?}"
    );
}

fn make_day(notes: &NotesService, e: &Env, date: &str) {
    let open = e.session.current().unwrap();
    let day = NewDay {
        date: date.to_owned(),
        content: "Later".to_owned(),
        ..NewDay::default()
    };
    notes.create_day(&open, day).unwrap();
}

#[test]
fn a_journal_folder_change_moves_the_days_and_keeps_them() {
    let (mut e, store) = opened_keeping(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/Ideas.md", "A note\n"),
        ],
    );
    let ideas = e.rows()[1].0.clone();
    let heard = Mutex::new(None);
    let settings = update(&e, folder("Diary"), |settings| {
        *heard.lock().unwrap() = Some(settings.clone());
    })
    .unwrap();

    assert_eq!(settings.journal_folder, "Diary");
    assert_eq!(heard.into_inner().unwrap(), Some(settings));
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    assert_eq!(e.read("Diary/2025-01-02.md"), "A day\n");
    assert!(!e.vault.join("journal/2025-01-02.md").exists());
    assert_eq!(e.read("journal/Ideas.md"), "A note\n");
    quiet(&mut e);
    assert_eq!(
        e.rows(),
        [
            row(DAY, "Diary/2025-01-02.md"),
            row(&ideas, "journal/Ideas.md")
        ]
    );
    make_day(&NotesService::new(e.tier.clone(), store), &e, "2025-01-06");
    assert!(e.vault.join("Diary/2025-01-06.md").exists());
}

#[test]
fn a_folder_and_format_change_together_move_each_day_once() {
    let mut e = opened(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let patch = VaultConfigPatch {
        journal_date_format: Some("YYYY/YYYY-MM-DD dddd".to_owned()),
        ..folder("Archive/Diary")
    };
    update(&e, patch, |_| {}).unwrap();

    let moved = "Archive/Diary/2025/2025-01-02 Thursday.md";
    assert_eq!(e.read(moved), "A day\n");
    quiet(&mut e);
    assert_eq!(e.rows(), [row(DAY, moved)]);
}

/// What a crash in the middle of a folder change leaves: a day whose row took its path in the
/// new folder while the file and the saved config are still in the old one. The next open pairs
/// the two as a move to a path the saved folder reads as that day, so the day keeps its id and
/// record, and the change run again moves it. Left the other way (the file in the new folder,
/// the row and the config in the old), the next open would cross the day out of the journal.
#[test]
fn a_crash_mid_folder_change_keeps_each_day_on_the_next_open() {
    let mut e = opened(daily("Diary"), &[("Diary/2025-01-02.md", "A day\n")]);
    assert_eq!(e.rows(), [row(DAY, "Diary/2025-01-02.md")]);
    e.close();
    fs::write(config_path(&e.vault), daily("journal").to_string()).unwrap();
    fs::create_dir(e.vault.join("journal")).unwrap();
    fs::rename(
        e.vault.join("Diary/2025-01-02.md"),
        e.vault.join("journal/2025-01-02.md"),
    )
    .unwrap();
    e.drain();

    e.open();
    let facts = e.facts_until(indexed);
    assert!(
        !facts
            .iter()
            .any(|f| matches!(f, Applied::Added { .. } | Applied::Removed { .. })),
        "{facts:?}"
    );
    quiet(&mut e);
    assert_eq!(e.rows(), [row(DAY, "journal/2025-01-02.md")]);
    update(&e, folder("Diary"), |_| {}).unwrap();
    assert_eq!(e.rows(), [row(DAY, "Diary/2025-01-02.md")]);
}

/// Each day's row takes its new path before its file does, the state the crash test above
/// reopens as the day.
#[test]
fn between_a_days_two_moves_its_file_keeps_the_saved_folder() {
    let e = opened(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let core = e.core();
    let mut seen = Vec::new();
    update_vault_settings_checked(
        &e.vault,
        Some((&core, &e.tier)),
        folder("Diary"),
        |_| {},
        &mut || {
            seen.push((
                e.vault.join("journal/2025-01-02.md").exists(),
                e.vault.join("Diary/2025-01-02.md").exists(),
                e.rows(),
            ));
        },
    )
    .unwrap();

    let moved = row(DAY, "Diary/2025-01-02.md");
    assert_eq!(seen, [(true, false, vec![moved.clone()])]);
    assert_eq!(e.rows(), [moved]);
}

/// A day made while a folder change moves the days waits for it and lands in the new folder:
/// made in the old one after it was listed, it would be a note once the new folder is saved.
#[test]
fn a_day_made_during_a_folder_change_lands_in_the_new_folder() {
    let (e, store) = opened_keeping(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/2025-01-03.md", "Another day\n"),
        ],
    );
    let notes = NotesService::new(e.tier.clone(), store);
    let core = e.core();
    std::thread::scope(|scope| {
        let mut maker = None;
        update_vault_settings_checked(
            &e.vault,
            Some((&core, &e.tier)),
            folder("Diary"),
            |_| {},
            &mut || {
                if maker.is_none() {
                    let (notes, e) = (&notes, &e);
                    maker = Some(scope.spawn(move || make_day(notes, e, "2025-01-06")));
                    // timing-bound: the create gets this long to queue for the rows' lane, which
                    // the pass lets go of before its next day. Held off by the folder change, it
                    // waits whatever the time.
                    std::thread::sleep(Duration::from_millis(300));
                }
            },
        )
        .unwrap();
        maker.unwrap().join().unwrap();
    });

    assert!(e.vault.join("Diary/2025-01-06.md").exists());
    assert!(!e.vault.join("journal/2025-01-06.md").exists());
}

/// A day whose path in the new folder is taken (a note holds it) refuses the folder: saved, it
/// would leave that day behind at a path no setting reads. The days already moved come back.
#[test]
fn a_folder_a_day_cannot_move_into_is_refused_and_every_day_stays() {
    let mut e = opened(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/2025-01-03.md", "Another day\n"),
            ("Diary/2025-01-03.md", "A note\n"),
        ],
    );
    let rows = e.rows();

    let refused = update(&e, folder("Diary"), |_| panic!("announced"));

    assert!(
        matches!(refused, Err(SettingsError::DaysNotRenamed { left: 1 })),
        "{refused:?}"
    );
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    assert!(e.vault.join("journal/2025-01-02.md").exists());
    assert!(!e.vault.join("Diary/2025-01-02.md").exists());
    assert_eq!(e.read("Diary/2025-01-03.md"), "A note\n");
    quiet(&mut e);
    assert_eq!(e.rows(), rows);
}

/// A folder the config could not save puts the days back, and the folders the move made for
/// them go again.
#[cfg(unix)]
#[test]
fn a_folder_the_config_does_not_take_puts_the_days_back() {
    use std::os::unix::fs::PermissionsExt as _;

    let mut e = opened(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let memry = e.vault.join(".memry");
    fs::set_permissions(&memry, fs::Permissions::from_mode(0o555)).unwrap();
    let refused = update(&e, folder("Archive/Diary"), |_| panic!("announced"));
    fs::set_permissions(&memry, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(
        matches!(refused, Err(SettingsError::Config(_))),
        "{refused:?}"
    );
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    assert!(e.vault.join("journal/2025-01-02.md").exists());
    assert!(!e.vault.join("Archive").exists());
    quiet(&mut e);
    assert_eq!(e.rows(), [row(DAY, "journal/2025-01-02.md")]);
}

/// A day another program holds (Windows: open without delete sharing, #3957; macOS: the
/// immutable flag) cannot move, so the folder is refused, the day moved before it comes back,
/// and the new folder goes again: every day is where the saved folder reads it.
#[cfg(any(target_os = "macos", windows))]
#[test]
fn a_day_held_open_refuses_the_folder_and_the_others_come_back() {
    let mut e = opened(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/2025-01-03.md", "A held day\n"),
        ],
    );
    let rows = e.rows();
    let pinned = crate::journal_rename::Pinned::new(&e.vault.join("journal/2025-01-03.md"));
    let refused = update(&e, folder("Diary"), |_| panic!("announced"));
    drop(pinned);

    assert!(
        matches!(refused, Err(SettingsError::DaysNotRenamed { left: 1 })),
        "{refused:?}"
    );
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    assert!(e.vault.join("journal/2025-01-02.md").exists());
    assert!(!e.vault.join("Diary").exists());
    quiet(&mut e);
    assert_eq!(e.rows(), rows);
}

/// A folder the next open would not find the days in under their paths, or that names no day:
/// the vault root, a hidden or excluded folder, the tree's own folders, a respelling of the
/// journal folder or of a folder already there, and a folder reached through a link.
#[test]
fn a_folder_the_days_cannot_live_in_is_refused() {
    let mut config = daily("journal");
    config["excludePatterns"] = json!(["Archive"]);
    let e = opened(config, &[("journal/2025-01-02.md", "A day\n")]);
    fs::create_dir(e.vault.join("Diary")).unwrap();
    let mut refused = vec![
        "",
        " / ",
        ".hidden",
        "Archive/Days",
        "attachments/Days",
        "Journal",
        "diary",
    ];
    #[cfg(unix)]
    {
        let elsewhere = e._dir.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, e.vault.join("Linked")).unwrap();
        refused.push("Linked/Days");
    }
    for to in refused {
        let answer = update(&e, folder(to), |_| panic!("{to:?} announced"));
        assert!(
            matches!(answer, Err(SettingsError::InvalidJournalFolder)),
            "{to:?}: {answer:?}"
        );
        assert_eq!(stored(&e.vault)["journalFolder"], "journal", "{to:?}");
        assert!(e.vault.join("journal/2025-01-02.md").exists(), "{to:?}");
    }
}

fn journal_vault(config: Value, files: &[(&str, &str)]) -> (Env, Arc<NotesService>) {
    let (e, store) = opened_keeping(config, files);
    let notes = NotesService::new(e.tier.clone(), store);
    (e, notes)
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

#[test]
fn a_journal_folder_whose_notes_cannot_follow_goes_back() {
    let (mut e, notes) = journal_vault(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
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

/// A crash after the journal folder moved on disk, before its notes followed: with the setting
/// not saved yet the days at the new folder are a journal folder moved whole, held as days;
/// saved, the next open finishes their moves as days. Neither deletes a day.
#[test]
fn a_journal_folder_move_a_crash_cut_short_keeps_its_days() {
    for saved in [false, true] {
        let (mut e, store) =
            opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
        let writer = e.core().notes_writer(store).unwrap();
        let moved = AppMoved {
            old_path: "journal/2025-01-02.md",
            new_path: "Diary/2025-01-02.md",
            title: None,
            keeps_kind: true,
        };
        writer
            .begin_folder_move("journal", "Diary", &[(DAY, moved)])
            .unwrap();
        drop(writer);
        e.close();
        fs::rename(e.vault.join("journal"), e.vault.join("Diary")).unwrap();
        if saved {
            fs::write(config_path(&e.vault), daily("Diary").to_string()).unwrap();
        }
        e.drain();

        e.open();
        let facts = e.facts_until(indexed);
        assert!(
            !facts
                .iter()
                .any(|f| matches!(f, Applied::Added { .. } | Applied::Removed { .. })),
            "saved {saved}: {facts:?}"
        );
        quiet(&mut e);
        assert_eq!(e.rows(), [row(DAY, "Diary/2025-01-02.md")], "saved {saved}");
    }
}
