//! `<vault>/.memry/activity.jsonl` is shared with Electron builds. Through the real log on a
//! temp vault, over files Electron's own log read and rewrote (`fixtures/gen-activity-vectors.mjs`):
//! the same entries are listed, the lines this build keeps are kept byte for byte, an entry it
//! writes has Electron's bytes, the settings file keeps what it does not know, a file it cannot
//! read is never rewritten, and a hostile file cannot stall or crash a read.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use memry_desktop::vault::activity::{
    ActivityEntry, ActivityError, ActivityFilter, ActivityInput, ActivityKind, ActivityLog,
    ActivitySource, CHANGED_THROTTLE, COMPACT_SLACK, DiskError, MAX_ENTRIES, MAX_LOG_BYTES,
    MAX_SETTINGS_BYTES, log_path, settings_path, steps,
};
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;
use serde_json::Value;

const VECTORS: &str = include_str!("fixtures/electron-vault/activity-jsonl.json");
const DAY: i64 = 86_400_000;

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn now() -> i64 {
    vectors()["now"].as_i64().unwrap()
}

fn vault() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("memry-activity-")
        .tempdir()
        .unwrap();
    fs::create_dir(dir.path().join(".memry")).unwrap();
    dir
}

fn at(now: i64) -> Arc<ActivityLog> {
    ActivityLog::with_clock(move || now)
}

fn on_disk(root: &Path) -> Option<String> {
    fs::read_to_string(log_path(root)).ok()
}

fn ids(entries: &[ActivityEntry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.id.as_str()).collect()
}

#[test]
fn electron_files_list_as_electron_lists_them_and_keep_their_lines_byte_for_byte() {
    for case in vectors()["reads"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        let dir = vault();
        fs::write(log_path(dir.path()), input).unwrap();
        if let Some(settings) = case["settings"].as_str() {
            fs::write(settings_path(dir.path()), settings).unwrap();
        }
        let log = at(now());
        log.open(dir.path());

        let listed = log.list(100_000, ActivityFilter::All);
        let expected: Vec<ActivityEntry> = serde_json::from_value(case["listed"].clone()).unwrap();
        assert!(listed.available, "{name}");
        assert_eq!(listed.entries, expected, "{name}");
        assert_eq!(
            u64::from(listed.retention_days),
            case["retentionDays"].as_u64().unwrap(),
            "{name}"
        );
        let problems = log.list(100_000, ActivityFilter::Problems);
        let expected: Vec<&str> = case["problems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect();
        assert_eq!(ids(&problems.entries), expected, "{name}");

        log.flush().unwrap();
        let written = on_disk(dir.path()).unwrap();
        let electron = case["electronRewritten"].as_str();
        match case["kept"].as_array() {
            // Every JSON object inside the window, as it was; Electron keeps fewer, rewritten.
            Some(kept) => {
                let kept: String = kept
                    .iter()
                    .map(|line| format!("{}\n", line.as_str().unwrap()))
                    .collect();
                assert_eq!(written, kept, "{name}");
            }
            None => assert_eq!(written, electron.unwrap_or(input), "{name}"),
        }
        if name == "canonical-compaction" {
            assert_eq!(
                Some(written.as_str()),
                electron,
                "{name}: Electron's own bytes"
            );
        }
    }
}

fn input_of(fields: &Value) -> ActivityInput {
    let kind = serde_json::from_value(fields["kind"].clone()).unwrap();
    let source = serde_json::from_value(fields["source"].clone()).unwrap();
    let text = |key: &str| fields[key].as_str().map(str::to_owned);
    let mut input = ActivityInput::new(kind, source);
    input.path = text("path");
    input.old_path = text("oldPath");
    input.reason = text("reason");
    input.message = text("message");
    input.importer = text("importer");
    input.counts = fields["counts"].as_object().map(|counts| {
        counts
            .iter()
            .map(|(name, n)| (name.clone(), n.as_u64().unwrap()))
            .collect()
    });
    input.items = fields["items"].as_array().map(|items| {
        items
            .iter()
            .map(|item| item.as_str().unwrap().to_owned())
            .collect()
    });
    input
}

#[test]
fn an_entry_this_build_writes_has_the_bytes_electron_writes_for_it() {
    let all = vectors();
    for case in all["records"].as_array().unwrap() {
        let input = input_of(&case["input"]);
        let line = input.to_line(case["id"].as_str().unwrap(), case["at"].as_str().unwrap());
        assert_eq!(line, case["line"].as_str().unwrap(), "{}", case["name"]);
    }
    // Electron cuts inside the pair and writes its lone high surrogate; this cuts before it.
    let cut = &all["surrogateCut"];
    let line =
        input_of(&cut["input"]).to_line(cut["id"].as_str().unwrap(), cut["at"].as_str().unwrap());
    assert_eq!(line, cut["line"].as_str().unwrap().replace("\\ud83d…", "…"));
}

#[test]
fn recorded_entries_reach_the_file_and_read_back_in_order() {
    let dir = vault();
    let log = at(now());
    log.open(dir.path());
    assert!(log.record(
        dir.path(),
        ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher).path("a.md")
    ));
    assert!(
        log.record(
            dir.path(),
            ActivityInput::new(ActivityKind::Renamed, ActivitySource::Watcher)
                .path("b.md")
                .old_path("a.md")
        )
    );
    log.flush().unwrap();
    let lines: Vec<Value> = on_disk(dir.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["at"], "2026-10-30T12:00:00.000Z");
    assert_eq!(lines[1]["oldPath"], "a.md");

    let reopened = at(now());
    reopened.open(dir.path());
    let listed = reopened.list(10, ActivityFilter::All).entries;
    assert_eq!(listed[0].kind, ActivityKind::Renamed);
    assert_eq!(listed[1].path.as_deref(), Some("a.md"));
}

#[test]
fn nothing_is_recorded_while_no_vault_is_open() {
    let log = at(now());
    assert!(!log.record(
        Path::new("nowhere"),
        ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher)
    ));
    assert!(!log.list(10, ActivityFilter::All).available);
    assert!(log.prepare_file().is_none());
    log.clear().unwrap();
    log.set_retention(7).unwrap();
}

#[test]
fn an_unsupported_file_is_reported_once_and_canvases_and_lock_files_never() {
    let dir = vault();
    let log = at(now());
    log.open(dir.path());
    assert!(log.record_skipped(dir.path(), "inbox\\Photo.HEIC", ActivitySource::Watcher));
    assert!(!log.record_skipped(dir.path(), "inbox/Photo.HEIC", ActivitySource::Scan));
    assert!(!log.record_skipped(
        dir.path(),
        "canvases/board.excalidraw",
        ActivitySource::Watcher
    ));
    assert!(!log.record_skipped(dir.path(), "~$report.docx", ActivitySource::Watcher));
    let entry = &log.list(10, ActivityFilter::All).entries[0];
    assert_eq!(entry.path.as_deref(), Some("inbox/Photo.HEIC"));
    assert_eq!(entry.message.as_deref(), Some(".heic"));
    log.flush().unwrap();

    // Still reported after a reopen, while its entry is kept; again once it is cleared.
    let reopened = at(now());
    reopened.open(dir.path());
    assert!(!reopened.record_skipped(dir.path(), "inbox/Photo.HEIC", ActivitySource::Scan));
    reopened.clear().unwrap();
    assert!(reopened.record_skipped(dir.path(), "inbox/Photo.HEIC", ActivitySource::Scan));
}

#[test]
fn a_repeat_inside_its_dedupe_window_is_dropped() {
    let dir = vault();
    let clock = Arc::new(std::sync::atomic::AtomicI64::new(now()));
    let time = clock.clone();
    let log = ActivityLog::with_clock(move || time.load(std::sync::atomic::Ordering::SeqCst));
    log.open(dir.path());
    let failed = || {
        ActivityInput::new(ActivityKind::Failed, ActivitySource::Sync)
            .reason("note-too-large")
            .dedupe("k", 1000)
    };
    assert!(log.record(dir.path(), failed()));
    clock.fetch_add(999, std::sync::atomic::Ordering::SeqCst);
    assert!(!log.record(dir.path(), failed()));
    clock.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    assert!(log.record(dir.path(), failed()));
}

#[test]
fn clearing_empties_the_file_and_the_list() {
    let dir = vault();
    let log = at(now());
    log.open(dir.path());
    log.record(
        dir.path(),
        ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher).path("a.md"),
    );
    log.flush().unwrap();
    log.clear().unwrap();
    assert!(log.list(10, ActivityFilter::All).entries.is_empty());
    assert_eq!(on_disk(dir.path()).unwrap(), "");
}

#[test]
fn a_shorter_retention_is_saved_and_drops_older_entries_from_the_file() {
    let dir = vault();
    let lines = [8, 2].map(|age| {
        let at =
            memry_core::storage::repositories::instants::to_iso8601(now() - age * DAY).unwrap();
        format!(r#"{{"v":1,"id":"d{age}","at":"{at}","kind":"added","source":"watcher"}}"#)
    });
    fs::write(
        log_path(dir.path()),
        format!("{}\n{}\n", lines[0], lines[1]),
    )
    .unwrap();
    let log = at(now());
    log.open(dir.path());
    log.set_retention(7).unwrap();
    assert_eq!(ids(&log.list(10, ActivityFilter::All).entries), ["d2"]);
    assert_eq!(log.list(10, ActivityFilter::All).retention_days, 7);
    log.flush().unwrap();
    assert_eq!(on_disk(dir.path()).unwrap(), format!("{}\n", lines[1]));
    assert!(matches!(
        log.set_retention(14),
        Err(ActivityError::InvalidRetention(14))
    ));
}

#[test]
fn the_settings_file_has_electron_s_bytes_and_keeps_keys_it_does_not_know() {
    for case in vectors()["settings"].as_array().unwrap() {
        let days = u32::try_from(case["days"].as_u64().unwrap()).unwrap();
        let written = case["written"].as_str().unwrap();
        for before in [None, Some("{\n  \"retentionDays\": 30\n}\n")] {
            let dir = vault();
            if let Some(before) = before {
                fs::write(settings_path(dir.path()), before).unwrap();
            }
            let log = at(now());
            log.open(dir.path());
            log.set_retention(days).unwrap();
            assert_eq!(
                fs::read_to_string(settings_path(dir.path())).unwrap(),
                written
            );
        }
    }

    let dir = vault();
    fs::write(
        settings_path(dir.path()),
        r#"{"device":"x","retentionDays":30,"n":[1]}"#,
    )
    .unwrap();
    let log = at(now());
    log.open(dir.path());
    log.set_retention(7).unwrap();
    assert_eq!(
        fs::read_to_string(settings_path(dir.path())).unwrap(),
        "{\n  \"device\": \"x\",\n  \"retentionDays\": 7,\n  \"n\": [\n    1\n  ]\n}\n"
    );
}

#[test]
fn a_settings_file_that_is_not_a_json_object_is_left_as_it_is() {
    for garbage in ["not json", "[30]", "\u{feff}{\"retentionDays\":30}"] {
        let dir = vault();
        fs::write(settings_path(dir.path()), garbage).unwrap();
        let log = at(now());
        log.open(dir.path());
        let refused = log.set_retention(7);
        assert!(
            matches!(
                refused,
                Err(ActivityError::Disk(DiskError::Unreadable { .. }))
            ),
            "{garbage}: {refused:?}"
        );
        assert_eq!(
            fs::read_to_string(settings_path(dir.path())).unwrap(),
            garbage
        );
        assert_eq!(log.list(1, ActivityFilter::All).retention_days, 30);
    }
}

/// A settings file past [`MAX_SETTINGS_BYTES`] is not read, whatever it holds: its retention
/// is unknown, so no entry goes for its age, and it is never replaced.
#[test]
fn a_settings_file_past_its_cap_is_neither_read_nor_replaced() {
    let dir = vault();
    let settings = format!(
        r#"{{"retentionDays":7,"pad":"{}"}}"#,
        "x".repeat(MAX_SETTINGS_BYTES as usize)
    );
    let at_ms = memry_core::storage::repositories::instants::to_iso8601(now() - 10 * DAY).unwrap();
    let line = format!(r#"{{"v":1,"id":"old","at":"{at_ms}","kind":"added","source":"watcher"}}"#);
    fs::write(log_path(dir.path()), format!("{line}\n")).unwrap();
    fs::write(settings_path(dir.path()), &settings).unwrap();
    let log = at(now());
    log.open(dir.path());
    let listed = log.list(10, ActivityFilter::All);
    assert_eq!(
        ids(&listed.entries),
        ["old"],
        "the 7 days past the cap were read"
    );
    assert_eq!(listed.retention_days, 30);
    let refused = log.set_retention(30);
    assert!(
        matches!(
            refused,
            Err(ActivityError::Disk(DiskError::Unreadable { .. }))
        ),
        "{refused:?}"
    );
    assert_eq!(
        fs::read_to_string(settings_path(dir.path())).unwrap(),
        settings
    );
}

/// Electron prunes by 30 days under a retention it does not know; a newer build may have set
/// one longer than any this build knows, so nothing goes for its age, only past the cap.
#[test]
fn a_retention_this_build_does_not_know_drops_no_entry_for_its_age() {
    for settings in [r#"{"retentionDays":365}"#, "not json", "[30]"] {
        let dir = vault();
        let old =
            memry_core::storage::repositories::instants::to_iso8601(now() - 200 * DAY).unwrap();
        let line =
            format!(r#"{{"v":1,"id":"old","at":"{old}","kind":"added","source":"watcher"}}"#);
        fs::write(log_path(dir.path()), format!("{line}\n")).unwrap();
        fs::write(settings_path(dir.path()), settings).unwrap();
        let log = at(now());
        log.open(dir.path());
        let listed = log.list(10, ActivityFilter::All);
        assert_eq!(ids(&listed.entries), ["old"], "{settings}");
        assert_eq!(listed.retention_days, 30, "{settings}");
        log.flush().unwrap();
        assert_eq!(
            on_disk(dir.path()).unwrap(),
            format!("{line}\n"),
            "{settings}"
        );
    }
}

#[test]
fn a_log_file_too_large_to_read_is_appended_to_and_never_rewritten() {
    let dir = vault();
    let file = fs::File::create(log_path(dir.path())).unwrap();
    file.set_len(MAX_LOG_BYTES + 1).unwrap();
    drop(file);
    let log = at(now());
    log.open(dir.path());
    assert!(log.list(10, ActivityFilter::All).entries.is_empty());
    for n in 0..=MAX_ENTRIES + 600 {
        log.record(
            dir.path(),
            ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher)
                .path(format!("{n}.md")),
        );
    }
    assert!(matches!(log.clear(), Err(ActivityError::Unreadable)));
    log.flush().unwrap();
    let bytes = fs::read(log_path(dir.path())).unwrap();
    let (head, tail) = bytes.split_at(usize::try_from(MAX_LOG_BYTES + 1).unwrap());
    assert!(
        head.iter().all(|byte| *byte == 0),
        "the unread bytes are untouched"
    );
    let appended = String::from_utf8(tail.to_vec()).unwrap();
    assert!(appended.ends_with(&format!("\"path\":\"{}.md\"}}\n", MAX_ENTRIES + 600)));
}

/// A FIFO would block the open hook, and a link out of the vault (to `/dev/zero`) would be
/// read without end: neither is read, waited on, or written.
#[cfg(unix)]
#[test]
fn a_fifo_log_or_a_settings_link_out_of_the_vault_is_neither_read_nor_waited_on() {
    use std::os::unix::ffi::OsStrExt;
    let dir = vault();
    let fifo = std::ffi::CString::new(log_path(dir.path()).as_os_str().as_bytes()).unwrap();
    // SAFETY: a NUL-terminated path that lives across the call.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    std::os::unix::fs::symlink("/dev/zero", settings_path(dir.path())).unwrap();
    let log = at(now());
    let (done, opened) = std::sync::mpsc::channel();
    let (root, opener) = (dir.path().to_owned(), log.clone());
    std::thread::spawn(move || {
        opener.open(&root);
        let _ = done.send(opener.list(10, ActivityFilter::All));
    });
    // timing-bound: an open that blocks on the FIFO or reads `/dev/zero` never returns.
    let listed = opened
        .recv_timeout(Duration::from_secs(30))
        .expect("the open blocked");
    assert!(listed.available && listed.entries.is_empty());
    assert_eq!(listed.retention_days, 30);
    log.record(
        dir.path(),
        ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher).path("a.md"),
    );
    assert!(log.flush().is_err(), "wrote into the FIFO");
    assert!(matches!(
        log.set_retention(7),
        Err(ActivityError::Disk(DiskError::Unreadable { .. }))
    ));
    assert!(
        fs::symlink_metadata(settings_path(dir.path()))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(log.list(10, ActivityFilter::All).entries.len(), 1);
}

#[test]
fn a_vault_that_is_away_is_not_recreated_and_gets_its_entries_once_back() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("vault");
    fs::create_dir_all(root.join(".memry")).unwrap();
    let log = at(now());
    log.open(&root);
    fs::remove_dir_all(&root).unwrap();
    log.record(
        &root,
        ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher).path("a.md"),
    );
    assert!(log.flush().is_err());
    assert!(
        !root.exists(),
        "the vault root came back as an empty folder"
    );
    fs::create_dir(&root).unwrap();
    log.flush().unwrap();
    assert!(on_disk(&root).unwrap().contains("\"path\":\"a.md\""));
}

fn added(n: usize) -> ActivityInput {
    ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher).path(format!("{n}.md"))
}

/// The cap plus the slack stays in the file; one more compacts it to the newest cap entries.
#[test]
fn the_file_is_compacted_to_the_newest_entries_past_the_cap_and_its_slack() {
    for (extra, lines) in [
        (COMPACT_SLACK, MAX_ENTRIES + COMPACT_SLACK),
        (COMPACT_SLACK + 1, MAX_ENTRIES),
    ] {
        let dir = vault();
        let log = at(now());
        log.open(dir.path());
        for n in 0..MAX_ENTRIES {
            log.record(dir.path(), added(n));
        }
        log.flush().unwrap();
        for n in MAX_ENTRIES..MAX_ENTRIES + extra {
            log.record(dir.path(), added(n));
        }
        log.flush().unwrap();
        let text = on_disk(dir.path()).unwrap();
        let written: Vec<&str> = text.lines().collect();
        assert_eq!(written.len(), lines, "{extra} past the cap");
        let first = MAX_ENTRIES + extra - lines;
        assert!(
            written[0].contains(&format!("\"path\":\"{first}.md\"")),
            "{extra} past the cap"
        );
        assert!(
            written[lines - 1].contains(&format!("\"path\":\"{}.md\"", MAX_ENTRIES + extra - 1))
        );
    }
}

#[test]
fn a_last_line_without_its_newline_is_rewritten_before_anything_is_appended() {
    let dir = vault();
    let kept =
        r#"{"v":1,"id":"t","at":"2026-10-30T11:00:00.000Z","kind":"added","source":"watcher"}"#;
    fs::write(log_path(dir.path()), kept).unwrap();
    let log = at(now());
    log.open(dir.path());
    log.record(
        dir.path(),
        ActivityInput::new(ActivityKind::Removed, ActivitySource::Watcher).path("b.md"),
    );
    log.flush().unwrap();
    let text = on_disk(dir.path()).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], kept);
    assert!(lines[1].contains("\"path\":\"b.md\""));
}

/// A clear whose rewrite fails is still owed: the next write rewrites the file, so the
/// cleared entries do not come back at the next open.
#[cfg(unix)]
#[test]
fn a_clear_whose_rewrite_fails_is_rewritten_by_the_next_write() {
    use std::os::unix::fs::PermissionsExt;
    let dir = vault();
    let cleared = r#"{"v":1,"id":"cleared","at":"2026-10-30T11:00:00.000Z","kind":"added","source":"watcher"}"#;
    fs::write(log_path(dir.path()), format!("{cleared}\n")).unwrap();
    let memry = dir.path().join(".memry");
    fs::set_permissions(&memry, fs::Permissions::from_mode(0o555)).unwrap();
    let log = at(now());
    log.open(dir.path());
    let refused = log.clear();
    fs::set_permissions(&memry, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        refused.is_err(),
        "the clear was written into a read-only .memry"
    );
    log.record(
        dir.path(),
        ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher).path("new.md"),
    );
    log.flush().unwrap();
    let text = on_disk(dir.path()).unwrap();
    assert_eq!(text.lines().count(), 1, "{text:?}");
    assert!(text.contains("\"path\":\"new.md\""), "{text:?}");
    log.close(dir.path());
    let reopened = at(now());
    reopened.open(dir.path());
    let listed = reopened.list(10, ActivityFilter::All).entries;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path.as_deref(), Some("new.md"));
}

/// A `.memry` that takes no new file fails every rewrite, while the log in it still takes
/// appends: the entries a failed rewrite held are appended on the retry, ahead of the ones
/// recorded since, instead of waiting for a rewrite that never succeeds.
#[cfg(unix)]
#[test]
fn a_rewrite_that_fails_is_retried_as_an_append_of_its_new_lines() {
    use std::os::unix::fs::PermissionsExt;
    let dir = vault();
    let kept =
        r#"{"v":1,"id":"t","at":"2026-10-30T11:00:00.000Z","kind":"added","source":"watcher"}"#;
    fs::write(log_path(dir.path()), kept).unwrap();
    let memry = dir.path().join(".memry");
    fs::set_permissions(&memry, fs::Permissions::from_mode(0o555)).unwrap();
    let log = at(now());
    log.open(dir.path());
    let removed =
        |path: &str| ActivityInput::new(ActivityKind::Removed, ActivitySource::Watcher).path(path);
    log.record(dir.path(), removed("b.md"));
    // Fails as a rewrite unless the log's own thread got there first; either way `c.md` is
    // recorded while `b.md` waits for its retry.
    let _ = log.flush();
    log.record(dir.path(), removed("c.md"));
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut text = on_disk(dir.path()).unwrap();
    while text.lines().count() < 3 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        text = on_disk(dir.path()).unwrap();
    }
    fs::set_permissions(&memry, fs::Permissions::from_mode(0o755)).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(
        lines.len(),
        3,
        "the new entries were not appended: {text:?}"
    );
    assert_eq!(lines[0], kept);
    assert!(lines[1].contains("\"path\":\"b.md\""), "{text:?}");
    assert!(lines[2].contains("\"path\":\"c.md\""), "{text:?}");
}

#[test]
fn a_valid_entry_whose_time_this_build_cannot_read_is_kept_by_the_retention() {
    let dir = vault();
    let line = r#"{"v":1,"id":"w","at":"Tue Mar 01 2022","kind":"added","source":"watcher"}"#;
    fs::write(log_path(dir.path()), format!("{line}\n")).unwrap();
    let log = at(now());
    log.open(dir.path());
    assert_eq!(ids(&log.list(10, ActivityFilter::All).entries), ["w"]);
}

#[test]
fn switching_vaults_keeps_their_entries_apart_and_a_late_close_leaves_the_open_one() {
    let (a, b) = (vault(), vault());
    let log = at(now());
    log.open(a.path());
    log.record(
        a.path(),
        ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher).path("in-a.md"),
    );
    log.open(b.path());
    assert!(log.list(10, ActivityFilter::All).entries.is_empty());
    assert!(
        !log.record(
            a.path(),
            ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher)
        ),
        "a late report about A landed in B's log"
    );
    assert!(
        on_disk(a.path()).unwrap().contains("in-a.md"),
        "the switch wrote A's entries"
    );
    log.close(a.path());
    assert!(
        log.list(10, ActivityFilter::All).available,
        "A's late close closed B"
    );
    log.record(
        b.path(),
        ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher).path("in-b.md"),
    );
    log.close(b.path());
    assert!(!log.list(10, ActivityFilter::All).available);
    assert!(
        on_disk(b.path()).unwrap().contains("in-b.md"),
        "the close wrote B's entries"
    );
}

#[test]
fn a_change_is_told_once_per_throttle_window_and_at_once_on_open_and_close() {
    let dir = vault();
    let log = at(now());
    let mut changed = log.subscribe();
    log.open(dir.path());
    assert!(changed.try_recv().is_ok(), "the open was not told at once");
    let recorded = std::time::Instant::now();
    for path in ["a.md", "b.md", "c.md"] {
        log.record(
            dir.path(),
            ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher).path(path),
        );
    }
    let deadline = recorded + Duration::from_secs(10);
    let mut told = changed.try_recv().is_ok();
    while !told && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
        told = changed.try_recv().is_ok();
    }
    assert!(told, "no change notice");
    assert!(
        recorded.elapsed() >= CHANGED_THROTTLE,
        "told before the throttle window ended"
    );
    std::thread::sleep(Duration::from_millis(800));
    assert!(
        changed.try_recv().is_err(),
        "three entries in one window told twice"
    );
    log.close(dir.path());
    assert!(changed.try_recv().is_ok(), "the close was not told at once");
}

#[test]
fn reveal_creates_the_file_without_recreating_the_vault() {
    let dir = vault();
    let log = at(now());
    log.open(dir.path());
    let path = log.prepare_file().unwrap();
    assert_eq!(path, log_path(dir.path()));
    assert_eq!(fs::read(&path).unwrap(), b"");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

// Untrusted input: the log is a file anyone can edit.

/// Nested past serde_json's depth limit: the line is dropped, the others are listed.
#[test]
fn a_deeply_nested_line_is_dropped_without_overflowing_a_small_stack() {
    let dir = vault();
    let deep = format!("{{\"x\":{}{}}}", "[".repeat(1 << 20), "]".repeat(1 << 20));
    let good =
        r#"{"v":1,"id":"g","at":"2026-10-30T11:00:00.000Z","kind":"added","source":"watcher"}"#;
    fs::write(log_path(dir.path()), format!("{deep}\n{good}\n")).unwrap();
    let root = dir.path().to_owned();
    let listed = on_small_stack(move || {
        let log = at(now());
        log.open(&root);
        log.list(10, ActivityFilter::All).entries
    });
    assert_eq!(ids(&listed), ["g"]);
}

/// Lone surrogate escapes make a line parse twice, never more: reading is linear in the file.
#[test]
fn reading_a_hostile_file_costs_steps_linear_in_its_size() {
    let dir = vault();
    let line = format!(
        r#"{{"v":1,"id":"s","at":"x","kind":"added","source":"watcher","path":"{}"}}"#,
        "\\ud800".repeat(2000)
    );
    let text = format!("{line}\n").repeat(200);
    fs::write(log_path(dir.path()), &text).unwrap();
    let root = dir.path().to_owned();
    let log = at(now());
    assert_steps_at_most("the activity log reader", steps, 2 * text.len(), || {
        log.open(&root)
    });
    assert_eq!(log.list(1000, ActivityFilter::All).entries.len(), 200);
}

fn soup() -> impl Strategy<Value = Vec<String>> {
    let entry = (
        0..60i64,
        prop::sample::select(vec!["added", "moved", "scan"]),
        any::<bool>(),
    )
        .prop_map(|(age, kind, extra)| {
            let at =
                memry_core::storage::repositories::instants::to_iso8601(now() - age * DAY).unwrap();
            let extra = if extra { r#","device":"x""# } else { "" };
            format!(
                r#"{{"v":1,"id":"i{age}","at":"{at}","kind":"{kind}","source":"watcher"{extra}}}"#
            )
        });
    let garbage = prop::sample::select(vec![
        "{",
        "[]",
        "1",
        "\"s\"",
        "null",
        "{\"v\":1",
        "\u{feff}{}",
    ])
    .prop_map(str::to_owned);
    prop::collection::vec(
        prop_oneof![3 => entry, 1 => garbage, 1 => Just("{}".to_owned())],
        0..40,
    )
}

proptest! {
    #![proptest_config(proptest_config(256))]

    /// Every JSON object inside the window is kept as it was, in order; everything else goes.
    /// A second open of the rewrite changes nothing.
    #[test]
    fn a_rewrite_keeps_every_object_in_the_window_verbatim(lines in soup()) {
        let dir = vault();
        let input: String = lines.iter().map(|line| format!("{line}\n")).collect();
        fs::write(log_path(dir.path()), &input).unwrap();
        let log = at(now());
        log.open(dir.path());
        log.flush().unwrap();
        let cutoff = now() - 30 * DAY;
        let kept: String = lines
            .iter()
            .filter(|line| match serde_json::from_str::<Value>(line) {
                Ok(Value::Object(object)) => object
                    .get("at")
                    .and_then(Value::as_str)
                    .and_then(memry_core::storage::repositories::instants::to_epoch_ms)
                    .is_none_or(|at| at >= cutoff),
                _ => false,
            })
            .map(|line| format!("{line}\n"))
            .collect();
        let written = on_disk(dir.path()).unwrap();
        prop_assert_eq!(&written, &kept);
        prop_assert!(written.len() <= input.len());

        let again = at(now());
        again.open(dir.path());
        again.flush().unwrap();
        prop_assert_eq!(on_disk(dir.path()).unwrap(), written);
    }
}
