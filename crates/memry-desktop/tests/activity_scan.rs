//! What the open walk found reaches the activity log as Electron's `indexVault` records it
//! (`recordScanActivity`): through the real log, the lines Electron appends for given walk
//! results (`fixtures/gen-activity-vectors.mjs`); and through a real session, tier and walk, a
//! first open's one "index built" summary and a later open's entries for the files that came
//! while the app was closed.

mod device_key;
mod vault_env;

use std::fs;

use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::activity::{
    ActivityEntry, ActivityFilter, ActivityKind, ActivityLog, ActivitySource, ScanActivity,
    ScanFailure, ScanMode, log_path,
};
use serde_json::Value;
use vault_env::{Env, env, indexed};

const VECTORS: &str = include_str!("fixtures/electron-vault/activity-jsonl.json");

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

fn count(value: &Value) -> usize {
    usize::try_from(value.as_u64().unwrap()).unwrap()
}

fn scan_of(fields: &Value) -> ScanActivity {
    ScanActivity {
        added: strings(&fields["added"]),
        added_count: count(&fields["addedCount"]),
        failed: fields["failed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|failure| ScanFailure {
                path: failure["path"].as_str().unwrap().to_owned(),
                reason: failure["reason"].as_str().unwrap().to_owned(),
                message: failure["message"].as_str().map(str::to_owned),
            })
            .collect(),
        failed_count: count(&fields["failedCount"]),
        unsupported: strings(&fields["unsupported"]),
        unsupported_count: count(&fields["unsupportedCount"]),
        known: 0,
        deferred: 0,
    }
}

/// The line with Electron's id in place of this build's, which is random on both sides.
fn with_id(line: &str, id: &str) -> String {
    let ours: Value = serde_json::from_str(line).unwrap();
    line.replacen(ours["id"].as_str().unwrap(), id, 1)
}

#[test]
fn a_walk_s_activity_has_the_lines_electron_appends_for_it() {
    let vectors: Value = serde_json::from_str(VECTORS).unwrap();
    let now = vectors["now"].as_i64().unwrap();
    for case in vectors["scans"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".memry")).unwrap();
        let before = strings(&case["before"]);
        if !before.is_empty() {
            fs::write(log_path(dir.path()), format!("{}\n", before.join("\n"))).unwrap();
        }
        let log = ActivityLog::with_clock(move || now);
        log.open(dir.path());
        let mode = match case["mode"].as_str().unwrap() {
            "scan" => ScanMode::Scan,
            _ => ScanMode::Rebuild,
        };
        log.record_scan(dir.path(), &scan_of(&case["scan"]), mode);
        log.flush().unwrap();
        let written = fs::read_to_string(log_path(dir.path())).unwrap();
        let ours: Vec<&str> = written.lines().skip(before.len()).collect();
        let electron = strings(&case["lines"]);
        assert_eq!(ours.len(), electron.len(), "{name}");
        for (line, expected) in ours.iter().zip(&electron) {
            let id: Value = serde_json::from_str(expected).unwrap();
            assert_eq!(
                with_id(line, id["id"].as_str().unwrap()),
                *expected,
                "{name}"
            );
        }
        log.close(dir.path());
    }
}

/// The scan's entries, oldest first.
fn scanned(e: &Env) -> Vec<ActivityEntry> {
    let mut entries = e.tier.activity().list(5000, ActivityFilter::All).entries;
    entries.reverse();
    entries.retain(|entry| entry.source == ActivitySource::Scan);
    entries
}

fn summary(entry: &ActivityEntry) -> (ActivityKind, Option<&str>, Option<&str>) {
    (entry.kind, entry.path.as_deref(), entry.reason.as_deref())
}

fn open_walked(e: &mut Env) {
    e.drain();
    e.open();
    e.facts_until(indexed);
}

/// A first open finds every file new: one summary says the index was built, and no file is
/// listed as added, which would claim the user just put it there. Its unsupported file is
/// reported, once.
#[test]
fn a_first_open_records_one_index_built_summary() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    for name in ["a.md", "b.md", "c/d.md"] {
        e.write(name, "# a note\n");
    }
    e.write("photo.heic", "not an image");
    open_walked(&mut e);

    let entries = scanned(&e);
    let found: Vec<_> = entries.iter().map(summary).collect();
    assert_eq!(
        found,
        [
            (
                ActivityKind::Skipped,
                Some("photo.heic"),
                Some("unsupported-type")
            ),
            (ActivityKind::Scan, None, Some("index-rebuilt")),
        ]
    );
    let counts = entries[1].counts.clone().unwrap();
    assert_eq!(
        counts.into_iter().collect::<Vec<_>>(),
        [("added".into(), 3.0)]
    );
    assert_eq!(entries[1].items, None);
    e.close();
}

/// Files that came while the app was closed: each new note's file is `added`, one whose read
/// failed is `failed`, an unsupported one is `skipped`, all from the scan. A file the vault knew
/// already, and one reported before, are not news; nor is a markdown file that is not UTF-8,
/// which Electron reads as text.
#[test]
fn a_later_open_records_the_files_that_came_while_closed() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write("known.md", "# known\n");
    e.write("photo.heic", "not an image");
    open_walked(&mut e);
    let first = scanned(&e).len();
    e.close();

    e.write("new/one.md", "# one\n");
    e.write("two.md", "# two\n");
    e.write("tool.bin", "bytes");
    fs::write(e.vault.join("latin1.md"), b"caf\xe9\n").unwrap();
    #[cfg(not(unix))]
    let locked: Option<std::path::PathBuf> = None;
    #[cfg(unix)]
    let locked = {
        use std::os::unix::fs::PermissionsExt as _;
        let path = e.vault.join("locked.md");
        fs::write(&path, "# locked\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        // Run as root, no permission keeps it from being read.
        fs::read(&path).is_err().then_some(path)
    };
    open_walked(&mut e);

    let entries = scanned(&e);
    let found: Vec<_> = entries[first..].iter().map(summary).collect();
    let failed = (ActivityKind::Failed, Some("locked.md"), Some("read-failed"));
    let expected: Vec<_> = [
        (ActivityKind::Added, Some("new/one.md"), None),
        (ActivityKind::Added, Some("two.md"), None),
    ]
    .into_iter()
    .chain(locked.is_some().then_some(failed))
    .chain([(
        ActivityKind::Skipped,
        Some("tool.bin"),
        Some("unsupported-type"),
    )])
    .collect();
    // Electron's order: the added files in the walk's (sorted) order, the failures, the skips.
    assert_eq!(found, expected);
    #[cfg(unix)]
    if let Some(path) = locked {
        use std::os::unix::fs::PermissionsExt as _;
        let failed = entries
            .iter()
            .find(|entry| entry.kind == ActivityKind::Failed);
        assert!(failed.and_then(|entry| entry.message.as_deref()).is_some());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    }
    e.close();
}
