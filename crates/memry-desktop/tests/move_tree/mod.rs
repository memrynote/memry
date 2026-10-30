//! Folder trees for the `vault::move_dir` and `vault::move_journal` tests.
#![allow(dead_code)] // each test binary uses its own share

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use memry_desktop::vault::move_dir::{Step, simulated_hold};

pub type Tree = BTreeMap<String, Option<Vec<u8>>>;

/// Every file and folder under `root`, by path relative to it: a file with its bytes, a folder
/// with `None`.
pub fn tree(root: &Path) -> Tree {
    let mut found = BTreeMap::new();
    let mut folders = vec![root.to_owned()];
    while let Some(folder) = folders.pop() {
        for entry in fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if rel == ".memry" {
                continue; // the app's own folder: the move journal
            }
            let meta = fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                found.insert(rel, None);
                folders.push(path);
            } else if meta.is_file() {
                found.insert(rel, Some(fs::read(&path).unwrap()));
            } else {
                found.insert(rel, Some(b"<link>".to_vec()));
            }
        }
    }
    found
}

/// A vault with `notes/` holding files at three depths and an empty folder.
pub fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (rel, text) in [
        ("notes/a.md", "a"),
        ("notes/b.md", "b"),
        ("notes/sub/c.md", "c"),
        ("notes/sub/deep/d.md", "d"),
        ("notes/held/e.md", "e"),
    ] {
        let path = dir.path().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fs::create_dir_all(dir.path().join("notes/empty")).unwrap();
    dir
}

/// The tree of `notes/` as it would be under `to/`.
pub fn moved(before: &Tree, to: &str) -> Tree {
    before
        .iter()
        .map(|(rel, bytes)| (rel.replacen("notes", to, 1), bytes.clone()))
        .collect()
}

pub const KEPT: &str = "notes (incomplete move)";

/// Nothing hidden is left, every file of `before` is back at its path or at the same path
/// under the visible folder [`KEPT`], and nothing else is there.
pub fn back_or_kept(before: &Tree, after: &Tree) {
    let hidden: Vec<_> = after.keys().filter(|rel| rel.starts_with('.')).collect();
    assert!(hidden.is_empty(), "{hidden:?}");
    for (rel, bytes) in before.iter().filter(|(_, bytes)| bytes.is_some()) {
        let kept = rel.replacen("notes", KEPT, 1);
        assert!(
            after.get(rel) == Some(bytes) || after.get(&kept) == Some(bytes),
            "{rel} lost: {after:?}"
        );
    }
    for rel in after.keys() {
        let source = rel.replacen(KEPT, "notes", 1);
        assert!(before.contains_key(&source), "{rel} is new: {after:?}");
    }
}

pub fn is_staging(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with(".memry-move-"))
}

/// Refuses the whole folder's rename and the rename of the folder `held` whole, as Windows
/// refuses a folder something beneath holds: the move goes entry by entry, and `held` is made
/// again. Every step is recorded.
pub fn as_windows_holds<'a>(
    steps: &'a mut Vec<String>,
) -> impl FnMut(Step<'_>) -> io::Result<()> + 'a {
    move |step| {
        steps.push(format!("{step:?}"));
        match step {
            Step::Whole { .. } => Err(simulated_hold()),
            Step::Entry { from, .. } if from.ends_with("held") => Err(simulated_hold()),
            _ => Ok(()),
        }
    }
}
