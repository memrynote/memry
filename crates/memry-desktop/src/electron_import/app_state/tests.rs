//! The app-state phase over a copy of the captured macOS profile, extended in each test with the
//! files the capture lacks (telemetry, models, OCR data, the sandbox vault, updater markers).

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use serde_json::{Value, json};
use tempfile::TempDir;

use super::*;
use crate::electron_import::progress::ProgressRecorder;
use crate::electron_import::tests::{Fixture, macos_fixture, tree_snapshot};

const INSTALL_ID: &str = "4b1f0c84-8d9a-4a43-9a51-1c2c7e3b2f10";

#[derive(Default)]
struct RecordingSpell(Mutex<Vec<String>>);

impl SpellBackend for RecordingSpell {
    fn check(&self, _: &str) -> bool {
        false
    }
    fn suggest(&self, _: &str, _: usize) -> Vec<String> {
        Vec::new()
    }
    fn add(&self, word: &str) -> bool {
        self.0.lock().unwrap().push(word.to_owned());
        true
    }
}

struct Tauri {
    dir: TempDir,
    config: AppConfig,
    spell: RecordingSpell,
    progress: ProgressRecorder,
}

impl Tauri {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig::load(dir.path().join("memry-config.json"));
        Self {
            dir,
            config,
            spell: RecordingSpell::default(),
            progress: ProgressRecorder::default(),
        }
    }

    fn data(&self) -> &Path {
        self.dir.path()
    }

    fn run(&self, f: &Fixture) -> Result<AppStateReport, ImportError> {
        import_app_state(&AppStateInput {
            profile: &f.profile,
            scratch: &f.scratch,
            tauri_data_dir: self.data(),
            config: &self.config,
            spell: Some(&self.spell),
            progress: &self.progress,
        })
    }

    fn json(&self, name: &str) -> Value {
        serde_json::from_slice(&fs::read(self.data().join(name)).unwrap()).unwrap()
    }
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn edit_config(f: &Fixture, edit: impl FnOnce(&mut Value)) {
    let path = f.profile.config_path();
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    edit(&mut config);
    fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
}

/// The captured profile plus every Electron userData file this phase carries or must not carry.
fn full_profile() -> Fixture {
    let f = macos_fixture("new");
    let dir = f.profile.dir.clone();
    let sandbox = dir.join("Sandbox");
    write(&sandbox.join("Welcome.md"), b"# sandbox");
    edit_config(&f, |config| {
        config["crdtStore"] = json!({ "legacyStoreClaimedBy": "x" });
        config["currentVault"] = json!(sandbox.to_str().unwrap());
        let vaults = config["vaults"].as_array_mut().unwrap();
        vaults[0]["futureVaultField"] = json!({ "k": 1 });
        vaults.push(json!({ "path": sandbox.to_str().unwrap(), "name": "Sandbox" }));
    });
    write(
        &dir.join("telemetry.json"),
        json!({ "installId": INSTALL_ID, "enabled": false, "lastRunVersion": "2026.1.1" })
            .to_string()
            .as_bytes(),
    );
    write(
        &dir.join("models/transformers/org/model/onnx/model.onnx"),
        &[7; 3000],
    );
    write(
        &dir.join("models/transformers/org/model/config.json"),
        b"{}",
    );
    write(
        &dir.join("models/voice-transcription/whisper-small.json"),
        b"{}",
    );
    write(&dir.join("ocr-languages/deu.traineddata"), &[9; 500]);
    write(&dir.join("sync-packs/pack-1.bin"), b"pack");
    for marker in [
        "update-install-attempt.json",
        "update-install-health.json",
        "pending-update-install.json",
    ] {
        write(&dir.join(marker), b"{}");
    }
    f
}

#[test]
fn the_profile_state_lands_in_the_tauri_data_dir_and_the_profile_is_untouched() {
    let f = full_profile();
    #[cfg(unix)]
    {
        // The sandbox reached through a link to the profile is still inside it.
        let alias = f._dir.path().join("alias");
        std::os::unix::fs::symlink(&f.profile.dir, &alias).unwrap();
        let path = alias.join("Sandbox");
        edit_config(&f, |c| {
            c["vaults"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "path": path.to_str().unwrap() }));
        });
    }
    let before = tree_snapshot(&f.profile.dir);
    let tauri = Tauri::new();

    let report = tauri.run(&f).unwrap();

    assert_eq!(
        tree_snapshot(&f.profile.dir),
        before,
        "the profile was written"
    );
    let config = tauri.json("memry-config.json");
    assert_eq!(config["futureSetting"], json!({ "kept": true }));
    assert_eq!(config["sync"]["deviceId"], "device-fixture");
    assert_eq!(config["locale"], "tr");
    assert!(config.get("crdtStore").is_none());
    assert!(
        config.get("currentVault").is_none(),
        "the sandbox is never current"
    );
    let vaults = config["vaults"].as_array().unwrap();
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0]["path"], "/Users/fixture/vault");
    assert_eq!(vaults[0]["futureVaultField"], json!({ "k": 1 }));
    let config_report = report.config.as_ref().unwrap();
    assert_eq!(
        config_report.vaults_inside_profile,
        if cfg!(unix) { 2 } else { 1 }
    );
    let dropped: BTreeSet<&str> = config_report
        .dropped_keys
        .iter()
        .map(String::as_str)
        .collect();
    assert_eq!(dropped, BTreeSet::from(["crdtStore", "currentVault"]));

    let telemetry = tauri.json("telemetry.json");
    assert_eq!(telemetry["installId"], INSTALL_ID);
    assert_eq!(telemetry["enabled"], false);
    assert!(telemetry.get("lastRunVersion").is_none());

    let local = tauri.json(LOCAL_STORAGE_FILE);
    let snapshot = LocalStorageSnapshot::read(&f.profile, PACKAGED_ORIGIN, &f.scratch)
        .unwrap()
        .unwrap();
    assert!(!snapshot.entries.is_empty());
    assert_eq!(local["entries"], json!(snapshot.entries));
    assert_eq!(local["pending"], true);
    assert_eq!(local["origin"], "file://");

    let words = CustomDictionary::read(&f.profile).unwrap().unwrap().words;
    assert!(!words.is_empty());
    assert_eq!(*tauri.spell.0.lock().unwrap(), words);

    for rel in [
        "models/transformers/org/model/onnx/model.onnx",
        "models/transformers/org/model/config.json",
        "ocr-languages/deu.traineddata",
    ] {
        assert_eq!(
            fs::read(tauri.data().join(rel)).unwrap(),
            fs::read(f.profile.dir.join(rel)).unwrap(),
            "{rel}"
        );
    }
    assert_eq!(report.models.copied, 2);
    assert_eq!(report.ocr_languages.copied, 1);

    // Nothing else: no sandbox, updater markers, sync packs, voice model, temp file.
    let top: BTreeSet<String> = fs::read_dir(tauri.data())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        top,
        BTreeSet::from(
            [
                "electron-localstorage.json",
                "memry-config.json",
                "models",
                "ocr-languages",
                "telemetry.json"
            ]
            .map(String::from)
        )
    );
    let models: Vec<String> = tree_snapshot(&tauri.data().join("models"))
        .into_iter()
        .map(|(rel, ..)| rel)
        .collect();
    assert!(
        models.iter().all(|rel| rel.starts_with("transformers")),
        "{models:?}"
    );

    let labels: Vec<String> = tauri
        .progress
        .updates()
        .into_iter()
        .map(|u| u.label)
        .collect();
    assert_eq!(labels, STEPS);
}

#[test]
fn a_rerun_after_a_complete_run_changes_nothing() {
    let f = full_profile();
    let tauri = Tauri::new();
    tauri.run(&f).unwrap();
    let first = tree_snapshot(tauri.data());

    let report = tauri.run(&f).unwrap();

    assert_eq!(tree_snapshot(tauri.data()), first);
    assert!(report.config.unwrap().replaced_keys.is_empty());
    assert_eq!(report.models.copied, 0);
    assert_eq!(report.models.already_present, 2);
}

#[test]
fn a_corrupt_profile_fails_with_nothing_written() {
    type Corrupt = fn(&Fixture);
    let cases: [(&str, Corrupt); 3] = [
        ("config", |f| {
            fs::write(f.profile.config_path(), b"{\"vaults\": [").unwrap()
        }),
        ("dictionary", |f| {
            fs::write(f.profile.dictionary_path(), [0xff, 0xfe, b'\n']).unwrap();
        }),
        ("local storage", |f| {
            fs::write(
                f.profile.local_storage_dir().join("CURRENT"),
                b"MANIFEST-999999\n",
            )
            .unwrap();
        }),
    ];
    for (what, corrupt) in cases {
        let f = full_profile();
        corrupt(&f);
        let before = tree_snapshot(&f.profile.dir);
        let tauri = Tauri::new();

        assert!(tauri.run(&f).is_err(), "{what}");

        assert!(
            tree_snapshot(tauri.data()).is_empty(),
            "{what}: Tauri dir written"
        );
        assert_eq!(tree_snapshot(&f.profile.dir), before, "{what}");
        assert!(tauri.spell.0.lock().unwrap().is_empty(), "{what}");
    }
}

#[cfg(unix)]
#[test]
fn an_unreadable_model_file_fails_before_any_write() {
    use std::os::unix::fs::PermissionsExt;
    let f = full_profile();
    let locked = f
        .profile
        .dir
        .join("models/transformers/org/model/config.json");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let tauri = Tauri::new();

    let result = tauri.run(&f);

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(result, Err(ImportError::Io { .. })), "{result:?}");
    assert!(tree_snapshot(tauri.data()).is_empty());
}

#[test]
fn tauri_state_that_must_survive_does() {
    let f = full_profile();
    fs::write(
        f.profile.dir.join("telemetry.json"),
        json!({ "enabled": true, "installId": "not-a-uuid" }).to_string(),
    )
    .unwrap();
    // Both dictionary files fail Chromium's checksum, so Chromium shows none of these words.
    fs::write(f.profile.dictionary_path(), "alpha\nchecksum_v1 = 00\n").unwrap();
    let _ = fs::remove_file(f.profile.dir.join("Custom Dictionary.txt.backup"));
    let tauri = Tauri::new();
    let mine = json!({ "path": "/elsewhere/mine", "name": "mine", "tauriOnly": true });
    write(
        &tauri.data().join("memry-config.json"),
        json!({ "locale": "en", "vaults": [mine.clone()] })
            .to_string()
            .as_bytes(),
    );
    let tauri = Tauri {
        config: AppConfig::load(tauri.data().join("memry-config.json")),
        ..tauri
    };
    write(
        &tauri.data().join("telemetry.json"),
        json!({ "enabled": false, "installId": INSTALL_ID })
            .to_string()
            .as_bytes(),
    );
    let own_model = tauri
        .data()
        .join("models/transformers/org/model/config.json");
    write(&own_model, b"{\"tauri\":true}");
    let applied = json!({ "version": 1, "pending": false, "entries": {} }).to_string();
    write(&tauri.data().join(LOCAL_STORAGE_FILE), applied.as_bytes());

    let report = tauri.run(&f).unwrap();

    let config = tauri.json("memry-config.json");
    assert_eq!(config["locale"], "tr", "Electron's value wins");
    assert_eq!(config["vaults"][0], mine);
    assert_eq!(config["vaults"][1]["path"], "/Users/fixture/vault");
    let config_report = report.config.unwrap();
    assert!(config_report.replaced_keys.contains(&"locale".to_owned()));
    assert_eq!(config_report.vaults_carried, 1);
    let telemetry = tauri.json("telemetry.json");
    assert_eq!(telemetry["enabled"], false, "an opt-out is never undone");
    assert_eq!(telemetry["installId"], INSTALL_ID);
    assert_eq!(fs::read(&own_model).unwrap(), b"{\"tauri\":true}");
    assert_eq!(report.models.kept_existing, 1);
    assert_eq!(
        fs::read_to_string(tauri.data().join(LOCAL_STORAGE_FILE)).unwrap(),
        applied
    );
    assert!(report.local_storage.unwrap().already_applied);
    let dictionary = report.dictionary.unwrap();
    assert!(!dictionary.checksum_ok);
    assert_eq!(dictionary.added, 0);
    assert!(tauri.spell.0.lock().unwrap().is_empty());
}

#[test]
fn a_profile_with_only_a_config_carries_the_config() {
    let f = macos_fixture("new");
    for name in [
        "Local Storage",
        "Custom Dictionary.txt",
        "Custom Dictionary.txt.backup",
    ] {
        let path = f.profile.dir.join(name);
        if path.is_dir() {
            fs::remove_dir_all(path).unwrap();
        } else {
            fs::remove_file(path).unwrap();
        }
    }
    let profile =
        crate::electron_import::profile::locate_profile(&crate::electron_import::ProfileEnv {
            app_data: f._dir.path().to_owned(),
            override_dir: Some(f.profile.dir.clone()),
            host: crate::electron_import::HostOs::MacOs,
        })
        .unwrap()
        .unwrap();
    let f = Fixture { profile, ..f };
    let tauri = Tauri::new();

    let report = tauri.run(&f).unwrap();

    assert!(report.local_storage.is_none());
    assert!(report.dictionary.is_none());
    assert!(!report.telemetry.found);
    assert_eq!(report.models.files, 0);
    assert_eq!(
        tauri.json("memry-config.json")["sync"]["deviceId"],
        "device-fixture"
    );
    assert!(!tauri.data().join(LOCAL_STORAGE_FILE).exists());
}
