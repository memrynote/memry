//! The vault settings through `vault:get-config` and `vault:update-config`'s owner
//! (`vault::config::settings`), on a real `config.json` of an open vault: Electron's
//! `getConfig` and `updateConfig`. A date format change renames the day files first and keeps
//! each day; the changes not ported yet (Step 13m-7b) are refused and leave the file as it was.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::Path;
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::config::settings::{
    SettingsError, update_vault_settings, vault_settings,
};
use memry_desktop::vault::config::{VaultConfig, VaultConfigPatch, config_path};
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::journal_rename::JournalVault;
use serde_json::{Value, json};
use vault_env::{Env, QUIET, env, indexed};

/// An open vault, its journal days made by the app's identity, whose config is `config` and
/// which holds `files`.
fn opened(config: Value, files: &[(&str, &str)]) -> Env {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
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
    e
}

fn update(
    e: &Env,
    patch: VaultConfigPatch,
    announce: impl FnOnce(&VaultConfig),
) -> Result<VaultConfig, SettingsError> {
    let core = e.core();
    let at = JournalVault {
        root: &e.vault,
        vault: &core,
        tier: &e.tier,
    };
    update_vault_settings(at, patch, announce)
}

fn stored(vault: &Path) -> Value {
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

/// A change the tier cannot follow yet is refused whole, and the file is left as it was; the
/// current value again (in any spelling that normalizes to it) is no change.
#[test]
fn a_change_of_the_journal_folder_or_the_excludes_is_refused() {
    let e = opened(
        json!({
            "journalFolder": "/diary/",
            "journalDateFormat": "YYYY-MM-DD",
            "excludePatterns": [".git"]
        }),
        &[],
    );
    let before = fs::read(config_path(&e.vault)).unwrap();
    let refused = [
        (
            "journalFolder",
            VaultConfigPatch {
                journal_folder: Some("Diary".to_owned()),
                ..Default::default()
            },
        ),
        (
            "excludePatterns",
            VaultConfigPatch {
                exclude_patterns: Some(vec![]),
                ..Default::default()
            },
        ),
    ];
    for (key, patch) in refused {
        let patch = VaultConfigPatch {
            journal_show_in_sidebar: Some(true),
            journal_date_format: Some("DD-MM-YYYY".to_owned()),
            ..patch
        };
        match update(&e, patch, |_| panic!("{key} announced")) {
            Err(SettingsError::NotPorted(refused)) => assert_eq!(refused, key),
            other => panic!("{key}: {other:?}"),
        }
        assert_eq!(fs::read(config_path(&e.vault)).unwrap(), before, "{key}");
    }

    let same = VaultConfigPatch {
        journal_folder: Some("diary/".to_owned()),
        journal_date_format: Some(" YYYY-MM-DD".to_owned()),
        exclude_patterns: Some(vec![".git".to_owned()]),
        journal_show_in_sidebar: Some(true),
        ..VaultConfigPatch::default()
    };
    let settings = update(&e, same, |_| {}).unwrap();
    assert!(settings.journal_show_in_sidebar);
    assert_eq!(stored(&e.vault)["journalFolder"], "/diary/");
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
