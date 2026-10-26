//! Cross-reader tests over the fixtures captured from real Electron 43.1.1 by
//! `scripts/electron-fixtures/capture.mjs`, plus the read-only invariant and performance checks.

mod perf;
mod read_only;

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use tempfile::TempDir;

use super::profile::{ElectronProfile, HostOs, ProfileEnv, locate_profile};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Expected {
    pub plaintexts: Value,
    pub docs: Vec<String>,
    pub note_id: String,
    pub journal_id: String,
    pub unicode_id: String,
    pub flushed_id: String,
    pub vault_uuid: String,
    pub macos_password: Option<String>,
}

pub(crate) fn fixture_root(os: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/electron")
        .join(os)
}

pub(crate) fn copy_dir(src: &Path, dst: &Path) {
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

/// A scratch copy of one captured profile (`new` or `legacy`), located through the override.
pub(crate) struct Fixture {
    pub _dir: TempDir,
    pub profile: ElectronProfile,
    pub expected: Expected,
}

pub(crate) fn fixture(os: &str, slug: &str, host: HostOs) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("profile");
    copy_dir(&fixture_root(os).join(slug), &root);
    let expected: Expected =
        serde_json::from_slice(&fs::read(fixture_root(os).join(format!("{slug}.json"))).unwrap())
            .unwrap();
    let env = ProfileEnv {
        app_data: dir.path().to_owned(),
        override_dir: Some(root),
        host,
    };
    let profile = locate_profile(&env).unwrap().expect("fixture is a profile");
    Fixture {
        _dir: dir,
        profile,
        expected,
    }
}

pub(crate) fn macos_fixture(slug: &str) -> Fixture {
    fixture("macos", slug, HostOs::MacOs)
}

/// A y-leveldb layout store written with rusty-leveldb, for scale tests the captured fixtures
/// are too small for. Keys follow `keyEncoding` in y-leveldb exactly.
pub(crate) mod synthetic {
    use std::path::Path;

    use rusty_leveldb::{DB, Options};

    fn string_key(out: &mut Vec<u8>, s: &str) {
        out.push(0);
        let mut len = s.len();
        while len > 0x7f {
            out.push(0x80 | (len & 0x7f) as u8);
            len >>= 7;
        }
        out.push(len as u8);
        out.extend(s.as_bytes());
    }

    pub fn update_key(doc: &str, clock: u32) -> Vec<u8> {
        let mut key = Vec::new();
        string_key(&mut key, "v1");
        string_key(&mut key, doc);
        string_key(&mut key, "update");
        key.push(1);
        key.extend(clock.to_be_bytes());
        key
    }

    pub fn write_store(dir: &Path, docs: usize, updates_per_doc: u32) {
        std::fs::create_dir_all(dir).unwrap();
        let mut db = DB::open(dir, Options::default()).unwrap();
        for d in 0..docs {
            let name = format!("doc-{d:05}");
            for clock in 0..updates_per_doc {
                db.put(&update_key(&name, clock), &[clock as u8; 64])
                    .unwrap();
            }
        }
        db.flush().unwrap();
    }
}

/// `(relative path, size, sha256)` of every file under `root`, directories included as entries.
pub(crate) fn tree_snapshot(root: &Path) -> Vec<(String, u64, String)> {
    use sha2::{Digest, Sha256};
    let mut out = Vec::new();
    let mut stack = vec![root.to_owned()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            if path.is_dir() {
                out.push((format!("{rel}/"), 0, String::new()));
                stack.push(path);
            } else {
                let bytes = fs::read(&path).unwrap();
                out.push((rel, bytes.len() as u64, hex::encode(Sha256::digest(&bytes))));
            }
        }
    }
    out.sort();
    out
}
