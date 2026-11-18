//! The Electron profile fixture of the first-launch migration (Step 37, #3554): one profile and
//! its one vault, captured by `scripts/electron-fixtures/capture-profile.mjs` from Electron 43.1.1
//! (secrets, localStorage, dictionary) and the desktop app's own code (databases, CRDT stores).
//!
//! [`ElectronProfileFixture::install`] lays a copy out the way an installed app has it:
//! `<tmp>/Application Support/memrynote` and a vault elsewhere, with the absolute paths Electron
//! records pointing at the copy. [`ElectronSnapshot`] is the "Electron data untouched" check.

#![allow(dead_code, reason = "each test uses a part of it")]

use std::collections::BTreeMap;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use memry_desktop::electron_import::secrets::FixedKeySource;
use memry_desktop::electron_import::{HostOs, ProfileEnv};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/electron-profile"
);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRow {
    pub id: String,
    pub path: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watermark {
    pub applied_sequence: u64,
    pub snapshot_revision: String,
}

/// `expected.json`: what the capture wrote, minus the key material (that is in the secret store).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub macos_password: String,
    pub profile_placeholder: String,
    pub vault_placeholder: String,
    pub plaintexts: Value,
    pub vault_uuid: String,
    pub device_id: String,
    pub account_key_verifier: String,
    pub notes: Vec<NoteRow>,
    pub offline_doc_id: String,
    pub watermark: Watermark,
    pub deleted_doc_id: String,
    pub legacy_doc_id: String,
    pub journal_doc_id: String,
    pub unattributable_doc_id: String,
}

pub struct ElectronProfileFixture {
    dir: TempDir,
    /// The Electron userData directory, `<app data>/memrynote`.
    pub profile: PathBuf,
    /// The vault, outside the profile, with a non-ASCII name.
    pub vault: PathBuf,
    pub expected: Expected,
}

impl ElectronProfileFixture {
    pub fn install() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("Application Support").join("memrynote");
        let vault = dir.path().join("Documents").join("Fixture Vault ğ");
        copy_dir(&Path::new(FIXTURE).join("profile"), &profile);
        copy_dir(&Path::new(FIXTURE).join("vault"), &vault);
        for db in ["data.db", "index.db"] {
            let packed = vault.join(".memry").join(format!("{db}.gz"));
            let mut bytes = Vec::new();
            GzDecoder::new(fs::File::open(&packed).unwrap())
                .read_to_end(&mut bytes)
                .unwrap();
            fs::write(vault.join(".memry").join(db), bytes).unwrap();
            fs::remove_file(packed).unwrap();
        }
        let expected: Expected =
            serde_json::from_slice(&fs::read(Path::new(FIXTURE).join("expected.json")).unwrap())
                .unwrap();
        let fixture = Self {
            dir,
            profile,
            vault,
            expected,
        };
        fixture.point_paths_at_the_copy();
        fixture
    }

    /// The paths Electron recorded (config `vaults[]`, `currentVault`, bulk-apply journal
    /// entries) name the capture's placeholders; point them at this copy.
    fn point_paths_at_the_copy(&self) {
        let config = self.profile.join("memry-config.json");
        let mut text = fs::read_to_string(&config).unwrap();
        for (placeholder, real) in [
            (&self.expected.vault_placeholder, &self.vault),
            (&self.expected.profile_placeholder, &self.profile),
        ] {
            let from = serde_json::to_string(placeholder).unwrap();
            let to = serde_json::to_string(&real.to_string_lossy()).unwrap();
            text = text.replace(&from, &to);
        }
        fs::write(&config, text).unwrap();

        let journal = self.profile.join("sync-bulk-apply-journal.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
        let prefix = format!("{}/", self.expected.vault_placeholder);
        for entry in value["entries"].as_array_mut().unwrap() {
            let recorded = entry["absolutePath"].as_str().unwrap();
            let rel = recorded.strip_prefix(&prefix).unwrap();
            let path = rel
                .split('/')
                .fold(self.vault.clone(), |p, part| p.join(part));
            entry["absolutePath"] = Value::String(path.to_string_lossy().into_owned());
        }
        fs::write(&journal, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }

    /// The host's application data directory: `locate_profile` finds `memrynote` in it, as on
    /// a real first launch. The ciphertexts are macOS ones (`v10`, mock keychain), so the host
    /// is macOS on every OS the test runs on.
    pub fn profile_env(&self) -> ProfileEnv {
        ProfileEnv {
            app_data: self.profile.parent().unwrap().to_owned(),
            override_dir: None,
            host: HostOs::MacOs,
        }
    }

    /// The Safe Storage password Chromium's mock keychain uses, under both app names.
    pub fn key_source(&self) -> FixedKeySource {
        let mut keys = FixedKeySource::default();
        for name in ["memrynote", "@memry/desktop"] {
            keys.passwords.insert(
                name.to_owned(),
                self.expected.macos_password.clone().into_bytes(),
            );
        }
        keys
    }

    /// A scratch directory next to the fixture, outside the profile and the vault.
    pub fn scratch_root(&self) -> PathBuf {
        self.dir.path().join("scratch")
    }

    pub fn data_db(&self) -> PathBuf {
        self.vault.join(".memry").join("data.db")
    }

    pub fn index_db(&self) -> PathBuf {
        self.vault.join(".memry").join("index.db")
    }

    pub fn snapshot(&self) -> ElectronSnapshot {
        ElectronSnapshot {
            profile: tree_hash(&self.profile),
            data_db: file_hash(&self.data_db()),
            index_db: file_hash(&self.index_db()),
        }
    }
}

/// Everything the migration must leave as it found it: the whole profile tree and the vault's
/// Electron databases. Equal before and after means untouched.
#[derive(Debug, PartialEq, Eq)]
pub struct ElectronSnapshot {
    pub profile: BTreeMap<String, (u64, String)>,
    pub data_db: (u64, String),
    pub index_db: (u64, String),
}

/// `relative path -> (size, sha256)` of every file under `root`; a directory is an entry with
/// size 0 and no hash, so an added empty directory counts as a change.
pub fn tree_hash(root: &Path) -> BTreeMap<String, (u64, String)> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_owned()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                out.insert(format!("{rel}/"), (0, String::new()));
                stack.push(path);
            } else {
                out.insert(rel, file_hash(&path));
            }
        }
    }
    out
}

fn file_hash(path: &Path) -> (u64, String) {
    let bytes = fs::read(path).unwrap();
    (bytes.len() as u64, hex::encode(Sha256::digest(&bytes)))
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let target = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}
