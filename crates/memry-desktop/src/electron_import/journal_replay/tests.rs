use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use memry_test_kit::{assert_steps_at_most, on_small_stack, output_bound, proptest_config};
use proptest::prelude::*;
use serde_json::{Value, json};
use tempfile::TempDir;

use super::*;

const WRITTEN_AT: f64 = 1_700_000_000_000.0;

struct World {
    _dir: TempDir,
    root: PathBuf,
    vault: PathBuf,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_owned();
    let vault = root.join("Vault ğ");
    fs::create_dir_all(vault.join("notes")).unwrap();
    World {
        _dir: dir,
        root,
        vault,
    }
}

fn abs(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

fn write(path: &Path, content: &str) -> Value {
    json!({ "absolutePath": abs(path), "content": content, "sha256": sha256_hex(content.as_bytes()) })
}

fn delete(path: &Path, deferred_at: f64) -> Value {
    json!({ "kind": "delete", "absolutePath": abs(path), "deferredAt": deferred_at })
}

fn journal(entries: Value) -> BulkApplyJournal {
    BulkApplyJournal::parse(
        json!({ "writtenAt": WRITTEN_AT, "entries": entries })
            .to_string()
            .as_bytes(),
    )
    .unwrap()
}

fn put(path: &Path, content: &str, mtime_ms: f64) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(mtime_ms as u64))
        .unwrap();
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

#[test]
fn writes_missing_and_stale_files_and_keeps_landed_and_newer_ones() {
    let w = world();
    let [missing, landed, stale, newer] = ["Missing", "Landed", "Stale", "Newer"]
        .map(|n| w.vault.join("notes").join(format!("{n}.md")));
    put(&landed, "landed body", WRITTEN_AT - 5_000.0);
    put(&stale, "old body", WRITTEN_AT - 1_000.0);
    put(&newer, "edited after the crash", WRITTEN_AT + 1_000.0);
    let j = journal(json!([
        write(&missing, "missing body"),
        write(&landed, "landed body"),
        write(&stale, "new body"),
        write(&newer, "journal body"),
    ]));

    let replay = replay(&j, &w.vault);

    assert_eq!(replay.written, [missing.clone(), stale.clone()]);
    assert_eq!(replay.settled, 1);
    assert_eq!(
        replay.skipped,
        [SkippedEntry {
            index: 3,
            path: abs(&newer),
            reason: EntrySkip::NewerOnDisk
        }]
    );
    assert_eq!(read(&missing), "missing body");
    assert_eq!(read(&stale), "new body");
    assert_eq!(read(&newer), "edited after the crash");
}

#[test]
fn a_bare_array_journal_has_no_written_at_and_overwrites_whatever_differs() {
    let w = world();
    let note = w.vault.join("notes/Newer.md");
    put(&note, "edited", WRITTEN_AT + 1_000.0);
    let bytes = json!([write(&note, "journal body")]).to_string();
    let j = BulkApplyJournal::parse(bytes.as_bytes()).unwrap();
    assert_eq!(j.written_at, 0.0);
    assert_eq!(replay(&j, &w.vault).written, [note.clone()]);
    assert_eq!(read(&note), "journal body");
}

#[test]
fn deletes_only_a_file_not_newer_than_the_delete() {
    let w = world();
    let [due, newer, gone] =
        ["Due", "Newer", "Gone"].map(|n| w.vault.join("notes").join(format!("{n}.md")));
    put(&due, "x", WRITTEN_AT - 1.0);
    put(&newer, "recreated", WRITTEN_AT + 1_000.0);
    let j = journal(json!([
        delete(&due, WRITTEN_AT),
        delete(&newer, WRITTEN_AT),
        delete(&gone, WRITTEN_AT),
    ]));

    let replay = replay(&j, &w.vault);

    assert_eq!(replay.deleted, [due.clone()]);
    assert_eq!(replay.settled, 1);
    assert_eq!(replay.skipped[0].reason, EntrySkip::NewerOnDisk);
    assert!(!due.exists() && newer.exists());
}

#[test]
fn the_last_entry_per_path_wins_in_the_order_last_seen() {
    let w = world();
    let [one, two, three] =
        ["One", "Two", "Three"].map(|n| w.vault.join("notes").join(format!("{n}.md")));
    let j = journal(json!([
        write(&one, "first"),
        write(&two, "two"),
        write(&three, "three"),
        write(&one, "second"),
        delete(&three, WRITTEN_AT),
    ]));
    let order: Vec<_> = j.entries.iter().map(|e| e.index).collect();
    assert_eq!(order, [1, 3, 4]);

    let replay = replay(&j, &w.vault);

    assert_eq!(replay.written, [two, one.clone()]);
    assert_eq!(read(&one), "second");
    assert!(!three.exists());
}

#[test]
fn a_write_whose_sha256_is_not_its_contents_is_listed_not_written() {
    let w = world();
    let [torn, null_sha, number_sha] =
        ["Torn", "Null", "Number"].map(|n| w.vault.join("notes").join(format!("{n}.md")));
    let j = journal(json!([
        { "absolutePath": abs(&torn), "content": "half", "sha256": sha256_hex(b"whole") },
        { "absolutePath": abs(&null_sha), "content": "body", "sha256": null },
        { "absolutePath": abs(&number_sha), "content": "body", "sha256": 7 },
    ]));

    let replay = replay(&j, &w.vault);

    assert_eq!(replay.written, [null_sha]);
    let reasons: Vec<_> = replay
        .skipped
        .iter()
        .map(|s| (s.index, s.reason.clone()))
        .collect();
    assert_eq!(
        reasons,
        [(0, EntrySkip::ShaMismatch), (2, EntrySkip::ShaMismatch)]
    );
    assert!(!torn.exists() && !number_sha.exists());
}

#[test]
fn entries_of_unknown_shape_are_listed() {
    let w = world();
    let p = abs(&w.vault.join("notes/x.md"));
    let j = journal(json!([
        { "absolutePath": p, "kind": "rename" },
        { "content": "no path" },
        5,
        { "absolutePath": p, "kind": "delete" },
        { "absolutePath": p, "kind": "delete", "deferredAt": "soon" },
        write(&w.vault.join("notes/ok.md"), "ok"),
    ]));
    assert_eq!(j.unknown, [0, 1, 2, 3, 4]);
    assert_eq!(j.entries.len(), 1);
}

#[test]
fn only_files_inside_the_vault_are_touched() {
    let w = world();
    let other = w.root.join("Other vault");
    let outside_note = other.join("notes/a.md");
    let j = journal(json!([
        write(&outside_note, "another vault's"),
        { "absolutePath": "notes/relative.md", "content": "x" },
        write(&w.vault.join("notes/../../escaped.md"), "x"),
        write(&w.vault.join(".memry/data.db"), "x"),
        write(&w.vault, "x"),
    ]));

    let replay = replay(&j, &w.vault);

    assert_eq!(replay.other_vault, 1);
    assert!(replay.written.is_empty());
    let unsafe_count = replay
        .skipped
        .iter()
        .filter(|s| s.reason == EntrySkip::UnsafePath)
        .count();
    assert_eq!(unsafe_count, 4);
    assert!(!outside_note.exists() && !w.root.join("escaped.md").exists());
    assert!(!w.vault.join(".memry").exists());
}

#[cfg(unix)]
#[test]
fn a_symlinked_folder_inside_the_vault_is_refused() {
    let w = world();
    let elsewhere = w.root.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, w.vault.join("linked")).unwrap();
    let j = journal(json!([write(&w.vault.join("linked/a.md"), "x")]));

    let replay = replay(&j, &w.vault);

    assert_eq!(replay.skipped[0].reason, EntrySkip::UnsafePath);
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
}

#[test]
fn a_second_replay_changes_nothing() {
    let w = world();
    let [a, b] = ["A", "B"].map(|n| w.vault.join("notes").join(format!("{n}.md")));
    put(&b, "x", WRITTEN_AT - 1.0);
    let j = journal(json!([write(&a, "a body"), delete(&b, WRITTEN_AT)]));
    assert_eq!(replay(&j, &w.vault).written.len(), 1);

    let again = replay(&j, &w.vault);

    assert!(again.written.is_empty() && again.deleted.is_empty() && again.skipped.is_empty());
    assert_eq!(again.settled, 2);
}

#[test]
fn a_journal_that_is_not_one_is_an_error_not_an_empty_replay() {
    assert!(matches!(
        BulkApplyJournal::parse(b"{\"entries\": [ {"),
        Err(ImportError::Parse { .. })
    ));
    for bytes in [&b"5"[..], b"{\"writtenAt\": 1}", b"{\"entries\": {}}"] {
        assert!(matches!(
            BulkApplyJournal::parse(bytes),
            Err(ImportError::UnsupportedLayout(_))
        ));
    }
}

/// `serde_json`'s recursion limit (128) is the guard; this pins that nothing re-parses an
/// entry with a deeper reader.
#[test]
fn deep_json_fails_the_parse_on_a_small_stack() {
    let err = on_small_stack(|| {
        let depth = 100_000;
        let bytes = format!(
            "{{\"entries\": [{}{}]}}",
            "[".repeat(depth),
            "]".repeat(depth)
        );
        BulkApplyJournal::parse(bytes.as_bytes()).unwrap_err()
    });
    assert!(matches!(err, ImportError::Parse { .. }));
}

/// Red without the cap: drop the length check in `read_capped` and the file parses.
#[test]
fn a_journal_past_the_cap_is_refused_before_it_is_parsed() {
    let w = world();
    let path = w.root.join(JOURNAL_FILE);
    let bytes = json!([write(&w.vault.join("notes/a.md"), "body")]).to_string();
    fs::write(&path, &bytes).unwrap();
    let len = bytes.len() as u64;
    assert!(BulkApplyJournal::read_capped(&path, len).unwrap().is_some());
    assert!(matches!(
        BulkApplyJournal::read_capped(&path, len - 1),
        Err(ImportError::UnsupportedLayout(_))
    ));
    assert!(
        BulkApplyJournal::read_capped(&w.root.join("absent"), len)
            .unwrap()
            .is_none()
    );
}

/// Red with a scan per entry (`latestOpPerPath`'s map turned into a list search).
#[test]
fn parse_and_replay_visit_each_entry_a_bounded_number_of_times() {
    let w = world();
    let n = 20_000;
    let note = w.vault.join("notes/same.md");
    let entries: Vec<Value> = (0..n).map(|i| write(&note, &format!("v{i}"))).collect();
    let bytes = json!({ "writtenAt": WRITTEN_AT, "entries": entries }).to_string();
    assert_steps_at_most("journal parse and replay", steps, 2 * n + 10, || {
        let j = BulkApplyJournal::parse(bytes.as_bytes()).unwrap();
        assert_eq!(replay(&j, &w.vault).written, [note.clone()]);
    });
}

fn segment() -> impl Strategy<Value = &'static str> {
    prop::sample::select(vec!["a.md", "b.md", "sub", "..", ".", ".memry", "deep"])
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn replay_writes_nothing_outside_the_vault_and_no_more_than_it_read(
        entries in prop::collection::vec(
            (any::<bool>(), prop::collection::vec(segment(), 1..5), 0u8..4, "[a-z]{0,40}"),
            0..24,
        )
    ) {
        let w = world();
        let sibling = w.root.join("sibling");
        fs::create_dir_all(&sibling).unwrap();
        let raw: Vec<Value> = entries
            .iter()
            .map(|(in_vault, parts, kind, content)| {
                let base = if *in_vault { &w.vault } else { &sibling };
                let path = parts.iter().fold(base.clone(), |p, s| p.join(s));
                match kind {
                    0 => delete(&path, WRITTEN_AT),
                    1 => json!({ "absolutePath": abs(&path), "content": content, "sha256": "bad" }),
                    _ => write(&path, content),
                }
            })
            .collect();
        let bytes = json!({ "writtenAt": WRITTEN_AT, "entries": raw }).to_string();
        let j = BulkApplyJournal::parse(bytes.as_bytes()).unwrap();

        let replay = replay(&j, &w.vault);

        let written: usize = replay.written.iter().map(|p| fs::metadata(p).map_or(0, |m| m.len() as usize)).sum();
        prop_assert!(written <= output_bound(bytes.len()));
        for path in replay.written.iter().chain(&replay.deleted) {
            prop_assert!(path.starts_with(&w.vault));
            prop_assert!(!path.starts_with(w.vault.join(".memry")));
        }
        prop_assert_eq!(fs::read_dir(&sibling).unwrap().count(), 0);
        prop_assert!(!w.root.join("a.md").exists() && !w.root.join("b.md").exists());
    }
}
