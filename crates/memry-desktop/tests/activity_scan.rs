//! What the open walk found reaches the activity log as Electron's `indexVault` records it
//! (`recordScanActivity`): through the real log, the lines Electron appends for given walk
//! results (`fixtures/gen-activity-vectors.mjs`); and through a real session, tier and walk, a
//! first open's one "index built" summary, a later open's entries for the files that came while
//! the app was closed, and nothing at all in an Electron vault this app did not import.

mod device_key;
mod vault_env;

use std::fs;
use std::path::PathBuf;

use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::activity::{
    ActivityEntry, ActivityFilter, ActivityKind, ActivityLog, ActivitySource, SCAN_COLLECT_LIMIT,
    ScanActivity, ScanFailure, ScanMode, log_path,
};
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::watch::VaultEvent;
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
                reason: match failure["reason"].as_str().unwrap() {
                    "read-failed" => "read-failed",
                    "index-failed" => "index-failed",
                    other => panic!("a reason Electron does not write: {other}"),
                },
                message: failure["message"].as_str().map(str::to_owned),
            })
            .collect(),
        failed_count: count(&fields["failedCount"]),
        unsupported: strings(&fields["unsupported"]),
        unsupported_count: count(&fields["unsupportedCount"]),
        known: 0,
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

/// Each list keeps Electron's `SCAN_COLLECT_LIMIT` paths; past it a file is only counted, so a
/// walk over a vault of millions holds ten thousand paths, not millions.
#[test]
fn a_walk_keeps_ten_thousand_paths_of_each_list_and_counts_the_rest() {
    assert_eq!(SCAN_COLLECT_LIMIT, 10_000);
    let mut scan = ScanActivity::default();
    for n in 0..=SCAN_COLLECT_LIMIT {
        scan.add(&format!("{n}.md"));
        scan.fail(&format!("{n}.md"), "read-failed", None);
    }
    assert_eq!((scan.added.len(), scan.added_count), (10_000, 10_001));
    assert_eq!((scan.failed.len(), scan.failed_count), (10_000, 10_001));
    assert_eq!(scan.added.last().map(String::as_str), Some("9999.md"));
}

/// Every entry, oldest first.
fn listed(e: &Env) -> Vec<ActivityEntry> {
    let mut entries = e.tier.activity().list(5000, ActivityFilter::All).entries;
    entries.reverse();
    entries
}

/// The scan's entries, oldest first.
fn scanned(e: &Env) -> Vec<ActivityEntry> {
    let mut entries = listed(e);
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

/// A note no one may read: `None` where nothing keeps it from being read (another OS, or run
/// as root).
fn locked(e: &Env, rel: &str) -> Option<PathBuf> {
    let path = e.vault.join(rel);
    fs::write(&path, "# locked\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    }
    fs::read(&path).is_err().then_some(path)
}

/// The walk's failed read is retried: the watcher looks at the file again and reports it
/// unreadable once more.
fn retried(e: &mut Env, rel: &str) {
    e.facts_until(
        |fact| matches!(fact, Applied::Vault(VaultEvent::Unreadable { path, .. }) if path == rel),
    );
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

/// Files that came while the app was closed: each new note's file is `added` and an
/// unsupported one `skipped`, from the scan. A file the vault knew already, and one reported
/// before, are not news; nor is a markdown file that is not UTF-8, which Electron reads as
/// text. A note that cannot be read is one `failed` entry for the open, though the watcher and
/// the walk both find it, and the retry finds it again.
#[test]
fn a_later_open_records_the_files_that_came_while_closed() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write("known.md", "# known\n");
    e.write("photo.heic", "not an image");
    open_walked(&mut e);
    let first = listed(&e).len();
    e.close();

    e.write("new/one.md", "# one\n");
    e.write("two.md", "# two\n");
    e.write("tool.bin", "bytes");
    fs::write(e.vault.join("latin1.md"), b"caf\xe9\n").unwrap();
    let locked = locked(&e, "locked.md");
    open_walked(&mut e);
    if locked.is_some() {
        retried(&mut e, "locked.md");
    }

    let entries = listed(&e).split_off(first);
    let failed: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind == ActivityKind::Failed)
        .collect();
    assert_eq!(
        failed
            .iter()
            .map(|entry| summary(entry))
            .collect::<Vec<_>>(),
        locked
            .iter()
            .map(|_| (ActivityKind::Failed, Some("locked.md"), Some("read-failed")))
            .collect::<Vec<_>>()
    );
    assert!(failed.iter().all(|entry| entry.message.is_some()));
    let others: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind != ActivityKind::Failed)
        .map(|entry| (entry.source, summary(entry)))
        .collect();
    let scan = ActivitySource::Scan;
    // Electron's order: the added files in the walk's (sorted) order, then the skips.
    assert_eq!(
        others,
        [
            (scan, (ActivityKind::Added, Some("new/one.md"), None)),
            (scan, (ActivityKind::Added, Some("two.md"), None)),
            (
                scan,
                (
                    ActivityKind::Skipped,
                    Some("tool.bin"),
                    Some("unsupported-type")
                )
            ),
        ]
    );
    e.close();
}

/// An open that finds only a new unsupported file, beside a note and an image it knew, is no
/// build of the index: the skip is the one entry.
#[test]
fn a_later_open_that_finds_only_an_unsupported_file_records_its_skip_alone() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write("known.md", "# known\n");
    e.write("photo.png", "not an image");
    open_walked(&mut e);
    let first = listed(&e).len();
    e.close();

    e.write("tool.bin", "bytes");
    open_walked(&mut e);
    let later: Vec<_> = listed(&e).split_off(first);
    assert_eq!(
        later.iter().map(summary).collect::<Vec<_>>(),
        [(
            ActivityKind::Skipped,
            Some("tool.bin"),
            Some("unsupported-type")
        )]
    );
    e.close();
}

/// A vault of this app whose every file waits (an image is no note) still has its problems
/// told: the unsupported file, and the note that cannot be read.
#[test]
fn a_vault_whose_files_all_wait_still_records_its_problems() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write("photo.png", "not an image");
    e.write("tool.bin", "bytes");
    let locked = locked(&e, "locked.md");
    open_walked(&mut e);
    if locked.is_some() {
        retried(&mut e, "locked.md");
    }
    let entries = listed(&e);
    let failed = (ActivityKind::Failed, Some("locked.md"), Some("read-failed"));
    let skipped = (
        ActivityKind::Skipped,
        Some("tool.bin"),
        Some("unsupported-type"),
    );
    // The watcher's start rescan finds the note unreadable before the walk begins.
    let expected: Vec<_> = locked.iter().map(|_| failed).chain([skipped]).collect();
    assert_eq!(entries.iter().map(summary).collect::<Vec<_>>(), expected);
    e.close();
}

/// An Electron vault this app did not import is left as it was, its activity log included:
/// neither the walk nor the watcher records its unsupported or unreadable files.
#[test]
fn an_electron_vault_not_imported_gets_no_activity_entry() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write(".memry/data.db", "");
    e.write("tool.bin", "bytes");
    let locked = locked(&e, "locked.md");
    open_walked(&mut e);
    if locked.is_some() {
        retried(&mut e, "locked.md");
    }
    e.write("later.heic", "not an image");
    e.facts_until(|fact| {
        matches!(fact, Applied::Vault(VaultEvent::Unsupported { path }) if path == "later.heic")
    });
    assert_eq!(listed(&e).len(), 0);
    e.close();
    assert!(!e.vault.join(".memry/activity.jsonl").exists());
}
