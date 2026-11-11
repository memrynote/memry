//! The vault settings through `vault:get-config` and `vault:update-config`'s owner
//! (`vault::config::settings`), on a real `config.json` of an open vault: Electron's
//! `getConfig` and `updateConfig`. A date format change renames the day files first and keeps
//! each day (a folder change: `journal_change`; an exclude pattern change: `vault_exclude`).

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::journal::write::NewDay;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::settings::{
    SettingsError, update_vault_settings, update_vault_settings_checked, vault_settings,
};
use memry_desktop::vault::config::{VaultConfig, VaultConfigPatch, config_path};
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::journal_rename::ChangeStep;
use memry_desktop::vault::notices::VaultNotices;
use serde_json::{Value, json};
use vault_env::{Env, QUIET, env, indexed};

/// An open vault, its journal days made by the app's identity, whose config is `config` and
/// which holds `files`.
pub(crate) fn opened(config: Value, files: &[(&str, &str)]) -> Env {
    opened_keeping(config, files).0
}

/// [`opened`], with the store a `NotesService` of it needs.
pub(crate) fn opened_keeping(config: Value, files: &[(&str, &str)]) -> (Env, Arc<dyn SecureStore>) {
    let (e, store, _) = opened_noticing(config, files);
    (e, store)
}

/// [`opened_keeping`], with the vault's notices board the identity raises them on.
pub(crate) fn opened_noticing(
    config: Value,
    files: &[(&str, &str)],
) -> (Env, Arc<dyn SecureStore>, Arc<VaultNotices>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let notices = VaultNotices::new();
    let board = notices.clone();
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::noticing(store, board))
    });
    notices.register(&e.session);
    fs::create_dir_all(e.vault.join(".memry")).unwrap();
    fs::write(
        config_path(&e.vault),
        serde_json::to_vec_pretty(&config).unwrap(),
    )
    .unwrap();
    for (path, text) in files {
        e.write(path, text);
    }
    e.open();
    e.facts_until(indexed);
    (e, kept.expect("the store"), notices)
}

pub(crate) fn update(
    e: &Env,
    patch: VaultConfigPatch,
    announce: impl FnOnce(&VaultConfig),
) -> Result<VaultConfig, SettingsError> {
    let core = e.core();
    update_vault_settings(&e.vault, Some((&core, &e.tier)), patch, announce)
}

pub(crate) fn stored(vault: &Path) -> Value {
    serde_json::from_slice(&fs::read(config_path(vault)).unwrap()).unwrap()
}

fn format(to: &str) -> VaultConfigPatch {
    VaultConfigPatch {
        journal_date_format: Some(to.to_owned()),
        ..VaultConfigPatch::default()
    }
}

#[test]
fn a_read_gives_the_journal_settings_in_their_canonical_form() {
    let e = opened(
        json!({
            "journalFolder": "/Daily Notes/",
            "journalDateFormat": " YYYY\\YYYY-MM-DD ",
            "journalShowInSidebar": "yes"
        }),
        &[],
    );
    let settings = vault_settings(Some(&e.vault));
    assert_eq!(settings.journal_folder, "Daily Notes");
    assert_eq!(settings.journal_date_format, "YYYY/YYYY-MM-DD");
    assert!(!settings.journal_show_in_sidebar);
    assert_eq!(settings.attachments_folder, "attachments");
}

/// With no vault open Electron answers a fallback whose exclude patterns are empty, unlike a
/// new vault's.
#[test]
fn with_no_vault_open_the_fallback_has_no_exclude_patterns() {
    let settings = vault_settings(None);
    assert_eq!(
        settings,
        VaultConfig {
            exclude_patterns: Vec::new(),
            ..VaultConfig::default()
        }
    );
}

#[test]
fn an_update_writes_the_fields_it_names_and_keeps_the_rest_of_the_file() {
    let e = opened(
        json!({
            "journalFolder": "diary",
            "preferences": {"theme": "dark"},
            "newerBuild": [1, 2]
        }),
        &[],
    );
    let patch = VaultConfigPatch {
        default_note_folder: Some("inbox".to_owned()),
        journal_show_in_sidebar: Some(true),
        attachments_folder: Some("files".to_owned()),
        ..VaultConfigPatch::default()
    };
    let settings = update(&e, patch, |_| {}).unwrap();
    assert_eq!(settings.default_note_folder, "inbox");
    assert!(settings.journal_show_in_sidebar);
    assert_eq!(settings.attachments_folder, "files");
    let file = stored(&e.vault);
    assert_eq!(file["journalFolder"], "diary");
    assert_eq!(file["preferences"], json!({"theme": "dark"}));
    assert_eq!(file["newerBuild"], json!([1, 2]));
    assert_eq!(file["defaultNoteFolder"], "inbox");
}

/// The current values again (the journal ones in any spelling that normalizes to them) are no
/// change: nothing is written or announced.
#[test]
fn the_current_settings_again_are_no_change() {
    let e = opened(
        json!({
            "journalFolder": "/diary/",
            "journalDateFormat": "YYYY-MM-DD",
            "excludePatterns": [".git"]
        }),
        &[],
    );
    let before = fs::read(config_path(&e.vault)).unwrap();
    let same = VaultConfigPatch {
        journal_folder: Some("diary/".to_owned()),
        journal_date_format: Some(" YYYY-MM-DD".to_owned()),
        exclude_patterns: Some(vec![".git".to_owned()]),
        ..VaultConfigPatch::default()
    };
    let settings = update(&e, same, |_| panic!("announced")).unwrap();
    assert_eq!(settings.exclude_patterns, [".git"]);
    assert_eq!(fs::read(config_path(&e.vault)).unwrap(), before);
}

/// The input is `UpdateVaultConfigSchema`: every field optional, an unknown key ignored.
#[test]
fn an_update_reads_the_contracts_shape() {
    let patch: VaultConfigPatch =
        serde_json::from_value(json!({"journalShowInSidebar": true, "unknown": 1})).unwrap();
    assert_eq!(
        patch,
        VaultConfigPatch {
            journal_show_in_sidebar: Some(true),
            ..VaultConfigPatch::default()
        }
    );
    assert!(
        serde_json::from_value::<VaultConfigPatch>(json!({"journalShowInSidebar": "yes"})).is_err()
    );
    let wire = serde_json::to_value(VaultConfig::default()).unwrap();
    assert_eq!(
        wire.as_object().unwrap().keys().collect::<Vec<_>>(),
        [
            "excludePatterns",
            "defaultNoteFolder",
            "journalFolder",
            "journalDateFormat",
            "attachmentsFolder",
            "journalShowInSidebar"
        ]
    );
}

/// A patch left empty once the unchanged journal fields are taken out changes nothing: the
/// file is not rewritten and no window hears of it.
#[test]
fn a_patch_of_only_current_values_writes_and_announces_nothing() {
    let e = opened(json!({}), &[]);
    let raw = br#"{"journalFolder":"/diary/"}"#;
    fs::write(config_path(&e.vault), raw).unwrap();
    let patch = VaultConfigPatch {
        journal_folder: Some("diary/".to_owned()),
        journal_date_format: Some("YYYY-MM-DD ".to_owned()),
        ..VaultConfigPatch::default()
    };
    let settings = update(&e, patch, |_| panic!("an empty patch announced")).unwrap();
    assert_eq!(settings.journal_folder, "diary");
    assert_eq!(fs::read(config_path(&e.vault)).unwrap(), raw);
}

/// Two windows saving at once: each window hears the settings in the order the writes land, so
/// the last announcement is what the file holds (Electron runs them one at a time on its main
/// thread). A is held inside its announcement while B tries to write.
#[test]
fn overlapping_writes_announce_in_the_order_they_land() {
    let e = opened(json!({}), &[]);
    let announced: Mutex<Vec<VaultConfig>> = Mutex::default();
    let (a_announcing, a_is_announcing) = mpsc::channel();
    let (b_finished, b_has_finished) = mpsc::channel::<()>();

    let (e, announced) = (&e, &announced);
    std::thread::scope(|scope| {
        let a = scope.spawn(move || {
            let patch = VaultConfigPatch {
                journal_show_in_sidebar: Some(true),
                ..VaultConfigPatch::default()
            };
            update(e, patch, |settings| {
                a_announcing.send(()).unwrap();
                // timing-bound: B gets this long to overtake A's announcement. Held off by the
                // settings lock it cannot, and the wait runs out.
                let _ = b_has_finished.recv_timeout(Duration::from_millis(300));
                announced.lock().unwrap().push(settings.clone());
            })
            .unwrap();
        });
        a_is_announcing.recv().unwrap();
        let b = scope.spawn(move || {
            let patch = VaultConfigPatch {
                default_note_folder: Some("inbox".to_owned()),
                ..VaultConfigPatch::default()
            };
            update(e, patch, |settings| {
                announced.lock().unwrap().push(settings.clone());
            })
            .unwrap();
            let _ = b_finished.send(());
        });
        a.join().unwrap();
        b.join().unwrap();
    });

    let announced = announced.lock().unwrap();
    assert_eq!(announced.len(), 2);
    assert_eq!(announced[0].default_note_folder, "");
    assert_eq!(announced[1], vault_settings(Some(&e.vault)));
    assert!(announced[1].journal_show_in_sidebar);
}

/// Electron's `updateConfig`: the day files take their names in the new format before the
/// format is saved, so each stays its day (`renameJournalsForFormatChange`). Here a day keeps
/// its id and record at its new name, and the watcher reports no note made or removed.
#[test]
fn a_date_format_change_renames_the_days_and_keeps_them() {
    let mut e = opened(
        json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" }),
        &[("journal/2025-01-02.md", "A day\n")],
    );
    assert_eq!(
        e.rows(),
        vec![("j2025-01-02".to_owned(), "journal/2025-01-02.md".to_owned())]
    );
    let heard = Mutex::new(None);
    let settings = update(&e, format("YYYY-MM-DD dddd"), |settings| {
        *heard.lock().unwrap() = Some(settings.clone());
    })
    .unwrap();

    assert_eq!(settings.journal_date_format, "YYYY-MM-DD dddd");
    assert_eq!(heard.into_inner().unwrap(), Some(settings));
    assert_eq!(stored(&e.vault)["journalDateFormat"], "YYYY-MM-DD dddd");
    assert!(!e.vault.join("journal/2025-01-02.md").exists());
    assert_eq!(
        fs::read_to_string(e.vault.join("journal/2025-01-02 Thursday.md")).unwrap(),
        "A day\n"
    );
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(
        !facts
            .iter()
            .any(|f| matches!(f, Applied::Added { .. } | Applied::Removed { .. })),
        "{facts:?}"
    );
    assert_eq!(
        e.rows(),
        vec![(
            "j2025-01-02".to_owned(),
            "journal/2025-01-02 Thursday.md".to_owned()
        )]
    );
}

/// A new format the config could not save puts the day files back under the names the old one
/// reads, as Electron's `revertJournalRenames` does, and answers the failure.
#[cfg(unix)]
#[test]
fn a_format_the_config_does_not_take_puts_the_days_back() {
    use std::os::unix::fs::PermissionsExt as _;

    let e = opened(
        json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" }),
        &[("journal/2025-01-02.md", "A day\n")],
    );
    let memry = e.vault.join(".memry");
    fs::set_permissions(&memry, fs::Permissions::from_mode(0o555)).unwrap();
    let refused = update(&e, format("YYYY-MM-DD dddd"), |_| panic!("announced"));
    fs::set_permissions(&memry, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(
        matches!(refused, Err(SettingsError::Config(_))),
        "{refused:?}"
    );
    assert_eq!(stored(&e.vault)["journalDateFormat"], "YYYY-MM-DD");
    assert!(e.vault.join("journal/2025-01-02.md").exists());
    assert!(!e.vault.join("journal/2025-01-02 Thursday.md").exists());
    assert_eq!(
        e.rows(),
        vec![("j2025-01-02".to_owned(), "journal/2025-01-02.md".to_owned())]
    );
}

/// What a crash in the middle of a date format change leaves: a day whose row took its name in
/// the new format while the file and the saved config are still in the old one. The next open
/// pairs the two as a move to a name the saved format reads as that day, so the day keeps its
/// id and record, and a change run again renames it.
#[test]
fn a_crash_mid_format_change_keeps_each_day_on_the_next_open() {
    let mut e = opened(
        json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD dddd" }),
        &[("journal/2025-01-02 Thursday.md", "A day\n")],
    );
    let renamed = "journal/2025-01-02 Thursday.md";
    assert_eq!(
        e.rows(),
        vec![("j2025-01-02".to_owned(), renamed.to_owned())]
    );
    e.close();
    let daily = json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" });
    fs::write(config_path(&e.vault), serde_json::to_vec(&daily).unwrap()).unwrap();
    fs::rename(e.vault.join(renamed), e.vault.join("journal/2025-01-02.md")).unwrap();
    e.drain();

    e.open();
    let facts = e.facts_until(indexed);
    std::thread::sleep(QUIET);
    let facts = [facts, e.drain()].concat();

    assert!(
        !facts
            .iter()
            .any(|f| matches!(f, Applied::Added { .. } | Applied::Removed { .. })),
        "{facts:?}"
    );
    assert_eq!(
        e.rows(),
        vec![("j2025-01-02".to_owned(), "journal/2025-01-02.md".to_owned())]
    );
    update(&e, format("YYYY-MM-DD dddd"), |_| {}).unwrap();
    assert_eq!(
        e.rows(),
        vec![("j2025-01-02".to_owned(), renamed.to_owned())]
    );
}

/// A day that cannot take its name in the new format, here because a note holds it, refuses the
/// format: saved, it would leave that day a note under it. The days already renamed go back.
#[test]
fn a_format_a_day_cannot_take_is_refused_and_every_day_keeps_its_name() {
    let mut e = opened(
        json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" }),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/2025-01-03.md", "Another day\n"),
            ("journal/2025-01-03 Friday.md", "A note\n"),
        ],
    );
    let rows = e.rows();

    let refused = update(&e, format("YYYY-MM-DD dddd"), |_| panic!("announced"));

    assert!(
        matches!(refused, Err(SettingsError::DaysNotRenamed { left: 1 })),
        "{refused:?}"
    );
    assert_eq!(stored(&e.vault)["journalDateFormat"], "YYYY-MM-DD");
    assert!(e.vault.join("journal/2025-01-02.md").exists());
    assert!(!e.vault.join("journal/2025-01-02 Thursday.md").exists());
    std::thread::sleep(QUIET);
    e.drain();
    assert_eq!(e.rows(), rows);
}

/// A format that cannot name every date renames no day and is not saved.
#[test]
fn a_format_that_cannot_name_every_date_is_refused() {
    let e = opened(
        json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" }),
        &[("journal/2025-01-02.md", "A day\n")],
    );
    let refused = update(&e, format("YYYY-MM"), |_| panic!("announced"));
    assert!(
        matches!(refused, Err(SettingsError::IncompleteFormat)),
        "{refused:?}"
    );
    assert_eq!(stored(&e.vault)["journalDateFormat"], "YYYY-MM-DD");
    assert!(e.vault.join("journal/2025-01-02.md").exists());
}

/// A config that cannot be read names no format or folder to rename from: the update is
/// refused before any day moves, not run from the defaults standing in for it.
#[test]
fn an_unreadable_config_moves_no_day() {
    let mut e = opened(
        json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" }),
        &[("journal/2025-01-02.md", "A day\n")],
    );
    fs::write(config_path(&e.vault), b"{ not json").unwrap();
    e.drain();

    let refused = update(&e, format("YYYY-MM-DD dddd"), |_| panic!("announced"));

    assert!(
        matches!(refused, Err(SettingsError::Config(_))),
        "{refused:?}"
    );
    assert!(
        !e.drain()
            .iter()
            .any(|f| matches!(f, Applied::Renamed { .. })),
        "a day moved"
    );
    assert!(e.vault.join("journal/2025-01-02.md").exists());
}

/// A journal folder that cannot be listed renames nothing, and the format is not saved.
#[cfg(unix)]
#[test]
fn a_journal_folder_that_cannot_be_listed_refuses_the_format() {
    use std::os::unix::fs::PermissionsExt as _;

    let e = opened(
        json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" }),
        &[("journal/2025-01-02.md", "A day\n")],
    );
    let journal = e.vault.join("journal");
    fs::set_permissions(&journal, fs::Permissions::from_mode(0o000)).unwrap();
    let refused = update(&e, format("YYYY-MM-DD dddd"), |_| panic!("announced"));
    fs::set_permissions(&journal, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(
        matches!(refused, Err(SettingsError::JournalUnlisted(_))),
        "{refused:?}"
    );
    assert_eq!(stored(&e.vault)["journalDateFormat"], "YYYY-MM-DD");
}

/// A vault whose tier did not start still takes every change but a date format, which needs it
/// to move the days.
#[test]
fn without_a_tier_only_a_format_change_is_refused() {
    let e = opened(json!({ "journalDateFormat": "YYYY-MM-DD" }), &[]);
    let sidebar = VaultConfigPatch {
        journal_show_in_sidebar: Some(true),
        ..VaultConfigPatch::default()
    };
    let settings = update_vault_settings(&e.vault, None, sidebar, |_| {}).unwrap();
    assert!(settings.journal_show_in_sidebar);
    let refused = update_vault_settings(&e.vault, None, format("YYYY-MM-DD dddd"), |_| {});
    assert!(matches!(refused, Err(SettingsError::NoTier)), "{refused:?}");
}

/// Each day's row takes its new name before its file does, so a crash between the two leaves
/// the file at the name the saved (old) format reads and the row at the new one, the state
/// `a_crash_mid_format_change_keeps_each_day_on_the_next_open` reopens as the day. Moved the
/// other way, the file would sit at a name the old format does not read, and the next open
/// would delete the day.
#[test]
fn between_a_days_two_moves_its_file_keeps_the_saved_formats_name() {
    let e = opened(
        json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" }),
        &[("journal/2025-01-02.md", "A day\n")],
    );
    let core = e.core();
    let mut seen = Vec::new();
    update_vault_settings_checked(
        &e.vault,
        Some((&core, &e.tier)),
        format("YYYY-MM-DD dddd"),
        |_| {},
        &mut |step| {
            if step != ChangeStep::Between {
                return;
            }
            seen.push((
                e.vault.join("journal/2025-01-02.md").exists(),
                e.vault.join("journal/2025-01-02 Thursday.md").exists(),
                e.rows(),
            ));
        },
    )
    .unwrap();

    let row = (
        "j2025-01-02".to_owned(),
        "journal/2025-01-02 Thursday.md".to_owned(),
    );
    assert_eq!(seen, [(true, false, vec![row.clone()])]);
    assert_eq!(e.rows(), [row]);
}

/// A day made while a format change renames the days waits for it and is named in the new
/// format: named in the old one after the folder was listed, it would be a note once the new
/// format is saved, deleted as a day by its next move.
#[test]
fn a_day_made_during_a_format_change_takes_the_new_formats_name() {
    let (e, store) = opened_keeping(
        json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" }),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/2025-01-03.md", "Another day\n"),
        ],
    );
    let notes = NotesService::new(e.tier.clone(), store);
    let open = e.session.current().unwrap();
    let core = e.core();
    let made = std::thread::scope(|scope| {
        let mut maker = None;
        update_vault_settings_checked(
            &e.vault,
            Some((&core, &e.tier)),
            format("YYYY-MM-DD dddd"),
            |_| {},
            &mut |step| {
                if maker.is_some() || step != ChangeStep::Between {
                    return;
                }
                let new_day = NewDay {
                    date: "2025-01-06".to_owned(),
                    content: "Typed during the change".to_owned(),
                    ..NewDay::default()
                };
                let (notes, open) = (&notes, &open);
                maker = Some(scope.spawn(move || notes.create_day(open, new_day)));
                // timing-bound: the create gets this long to queue for the rows' lane, which
                // the pass lets go of before its next day. Held off by the format change, it
                // waits whatever the time.
                std::thread::sleep(Duration::from_millis(300));
            },
        )
        .unwrap();
        maker.unwrap().join().unwrap()
    });

    made.unwrap();
    assert!(e.vault.join("journal/2025-01-06 Monday.md").exists());
    assert!(!e.vault.join("journal/2025-01-06.md").exists());
}
