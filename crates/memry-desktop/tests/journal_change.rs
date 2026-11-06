//! The journal folder changed in Settings (Step 13m-7b-2b, #3530), on an open vault whose days
//! the app's own identity (`NotesIdentity`) names. A day is a day only while its path is in the
//! configured folder and format, so the change moves the days first and saves the folder last,
//! every day or none; a note at a day's path stays a note where it is. Crashes:
//! `journal_change_crash`.
//!
//! | Test                                                              | Rule                                  |
//! | ----------------------------------------------------------------- | ------------------------------------- |
//! | a journal folder change moves the days and keeps them             | `updateConfig`, days moved here       |
//! | a journal folder change leaves a note at a day's path a note      | days only (P3a)                       |
//! | a folder and format change together move each day once            | one pass                              |
//! | between a day's two moves its file keeps the saved folder         | the order, pinned                     |
//! | a day made during a folder change lands in the new folder         | `DAY_NAMES`                           |
//! | a folder a day cannot move into is refused and every day stays    | every day or none                     |
//! | a folder the config does not take puts the days back              | its new folder goes too               |
//! | a day held open refuses the folder and the others come back       | #3957, Windows holds                  |
//! | a folder the days cannot live in is refused                       | root, hidden, excluded, links, `D:`   |
//! | a respelling of the journal folder in case only is refused        | the sidebar renames in case           |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::sync::Mutex;
use std::time::Duration;

use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::VaultConfigPatch;
use memry_desktop::vault::config::settings::{SettingsError, update_vault_settings_checked};
use memry_desktop::vault::journal_rename::ChangeStep;
use serde_json::json;

use crate::journal_folder::{DAY, daily, dated_note, make_day, outbox, quiet, row};
use crate::vault_settings::{opened, opened_keeping, stored, update};

pub(crate) fn folder(to: &str) -> VaultConfigPatch {
    VaultConfigPatch {
        journal_folder: Some(to.to_owned()),
        ..VaultConfigPatch::default()
    }
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
    let synced = outbox(&e, DAY);
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
    // A day's path is never synced: its move queues nothing.
    assert_eq!(outbox(&e, DAY), synced);
}

/// A note whose title is a date sits at a day's path in the journal folder. The change moves
/// the days only: moved, the note's row would name the new folder while its record names the
/// old one, and the note would take the day's path there.
#[test]
fn a_journal_folder_change_leaves_a_note_at_a_days_path_a_note() {
    let (mut e, store) = opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    let note = dated_note(&notes, &mut e);
    update(&e, folder("Diary"), |_| {}).unwrap();

    quiet(&mut e);
    let rows = e.rows();
    assert!(rows.contains(&row(DAY, "Diary/2025-01-02.md")), "{rows:?}");
    assert!(
        rows.contains(&row(&note, "journal/2025-01-05.md")),
        "{rows:?}"
    );
    // The day the note's title names is free in the new folder.
    make_day(&notes, &e, "2025-01-05");
    assert!(e.vault.join("Diary/2025-01-05.md").exists());
    assert!(!outbox(&e, &note).contains(&"delete".to_owned()));
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

/// Each day's row takes its new path before its file does: the state a crash there leaves,
/// which the next open puts back (`journal_change_crash`).
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
        &mut |step| {
            if step == ChangeStep::Between {
                seen.push((
                    e.vault.join("journal/2025-01-02.md").exists(),
                    e.vault.join("Diary/2025-01-02.md").exists(),
                    e.rows(),
                ));
            }
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
            &mut |step| {
                if maker.is_none() && step == ChangeStep::Between {
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
/// the vault root, a hidden or excluded folder, the tree's own folders, a respelling of a folder
/// already there, a folder reached through a link, and a drive (`D:\Diary`, which Windows does
/// not join under the vault).
#[test]
fn a_folder_the_days_cannot_live_in_is_refused() {
    let mut config = daily("journal");
    config["excludePatterns"] = json!(["Archive"]);
    let e = opened(config, &[("journal/2025-01-02.md", "A day\n")]);
    fs::create_dir(e.vault.join("Diary")).unwrap();
    let refused = [
        "",
        " / ",
        ".hidden",
        "Archive/Days",
        "attachments/Days",
        "diary",
        "D:\\Diary",
        "Days/C:",
    ];
    #[cfg(unix)]
    let refused = {
        let elsewhere = e._dir.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, e.vault.join("Linked")).unwrap();
        [refused.as_slice(), &["Linked/Days"]].concat()
    };
    for to in refused {
        let answer = update(&e, folder(to), |_| panic!("{to:?} announced"));
        assert!(
            matches!(answer, Err(SettingsError::InvalidJournalFolder)),
            "{to:?}: {answer:?}"
        );
        assert_eq!(stored(&e.vault)["journalFolder"], "journal", "{to:?}");
        assert!(e.vault.join("journal/2025-01-02.md").exists(), "{to:?}");
    }
    // Listed, not joined: on Windows `vault.join("D:")` is the drive itself.
    let names: Vec<String> = fs::read_dir(&e.vault)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        !names.iter().any(|name| name.starts_with("D:")),
        "{names:?}"
    );
}

/// The journal folder respelled in case only is refused with its own reason, whether or not
/// the folder is on disk (no sibling check catches it then): the days would move file by file
/// within one folder on a volume that folds case. The sidebar rename respells it whole.
#[test]
fn a_respelling_of_the_journal_folder_in_case_only_is_refused() {
    let e = opened(daily("journal"), &[]);
    fs::create_dir_all(e.vault.join("journal")).unwrap();
    for on_disk in [true, false] {
        if !on_disk {
            fs::remove_dir_all(e.vault.join("journal")).unwrap();
        }
        let answer = update(&e, folder("Journal"), |_| panic!("announced"));
        assert!(
            matches!(answer, Err(SettingsError::RespelledJournalFolder)),
            "{on_disk}: {answer:?}"
        );
        assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    }
}
