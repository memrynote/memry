use super::*;
use crate::vault::activity::{ActivityEntry, ActivityFilter, ActivityKind, ActivitySource};

fn listed(f: &Fixture) -> Vec<(ActivityKind, ActivitySource, String, Option<String>)> {
    let mut entries: Vec<ActivityEntry> = f.applier.activity.list(100, ActivityFilter::All).entries;
    entries.reverse();
    entries
        .into_iter()
        .map(|entry| {
            (
                entry.kind,
                entry.source,
                entry.path.unwrap_or_default(),
                entry.old_path,
            )
        })
        .collect()
}

/// What `watcher.ts` records: a watched add, a rename and a delete, a file of a type the vault
/// does not open, and one it could not read; never a file the open walk found, nor a removal
/// whose note was kept.
#[test]
fn the_watcher_s_facts_reach_the_activity_log_as_electron_records_them() {
    use ActivityKind::{Added, Failed, Removed, Renamed, Skipped};
    use ActivitySource::Watcher;
    let mut f = fixture();
    f.applier.activity.open(&f.root);
    f.write("walked.md", "found by the walk\n");
    f.walked("walked.md");
    f.write("a.md", "x\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.facts();
    f.applier.apply(VaultEvent::Renamed {
        note_id: id.clone(),
        old_path: "a.md".into(),
        new_path: "dir/b.md".into(),
        content_hash: None,
    });
    *f.identity.removal.lock().unwrap() = Removal::Kept;
    let removed = VaultEvent::Removed {
        note_id: id,
        path: "dir/b.md".into(),
    };
    f.applier.apply(removed.clone());
    *f.identity.removal.lock().unwrap() = Removal::Deleted;
    f.applier.apply(removed);
    f.applier.apply(VaultEvent::Unsupported {
        path: "photo.heic".into(),
    });
    for _ in 0..2 {
        f.applier.apply(VaultEvent::Unreadable {
            path: "locked.md".into(),
            reason: "EACCES".into(),
        });
    }

    let at = |kind, path: &str, old: Option<&str>| {
        (kind, Watcher, path.to_owned(), old.map(str::to_owned))
    };
    assert_eq!(
        listed(&f),
        vec![
            at(Added, "a.md", None),
            at(Renamed, "dir/b.md", Some("a.md")),
            at(Removed, "dir/b.md", None),
            at(Skipped, "photo.heic", None),
            at(Failed, "locked.md", None),
        ]
    );
    let failed = &f.applier.activity.list(1, ActivityFilter::All).entries[0];
    assert_eq!(failed.reason.as_deref(), Some("read-failed"));
    assert_eq!(failed.message.as_deref(), Some("EACCES"));
}

/// Electron records an add only when no note claimed the path; a file a note already owns
/// (moved while the app was closed, or one whose seed a crash cut short) is not news.
#[test]
fn a_file_an_existing_note_adopts_is_not_listed_as_added() {
    let f = fixture();
    f.applier.activity.open(&f.root);
    let id = f.note();
    *f.identity.next.lock().unwrap() = Some(Adoption::Existing(id));
    f.write("moved.md", "moved while closed\n");
    f.added("moved.md");
    assert_eq!(listed(&f), vec![]);
}

/// A note no one can read while the guard lives: no permission on unix; on Windows an open
/// handle that shares nothing, as an antivirus scan holds a file. Fails when the file still
/// reads (a test run as root).
#[must_use]
fn lock(f: &Fixture, rel: &str) -> Option<std::fs::File> {
    let path = f.root.join(rel);
    #[cfg(unix)]
    let held = {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        None
    };
    #[cfg(windows)]
    let held = {
        use std::os::windows::fs::OpenOptionsExt as _;
        let open = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path);
        Some(open.unwrap())
    };
    assert!(std::fs::read(&path).is_err(), "{rel} must not be readable");
    held
}

/// The walk is told of a read that failed, a new file's or a known note's whose file changed;
/// a file that is not UTF-8 is read as text, as Electron reads it, and is no failure.
#[test]
fn the_walk_is_told_of_the_reads_that_failed() {
    let f = fixture();
    f.write("known.md", "x\n");
    f.added("known.md");
    f.write("known.md", "edited while closed\n");
    f.write("new.md", "x\n");
    std::fs::write(f.root.join("latin1.md"), b"caf\xe9\n").unwrap();
    let _held = (lock(&f, "known.md"), lock(&f, "new.md"));
    let mut scan = ScanActivity::default();
    for rel in ["known.md", "latin1.md", "new.md"] {
        let meta = std::fs::symlink_metadata(f.root.join(rel)).unwrap();
        f.applier.walked(rel, &meta, &mut scan);
    }
    let failed: Vec<_> = scan
        .failed
        .iter()
        .map(|failure| {
            (
                failure.path.as_str(),
                failure.reason,
                failure.message.is_some(),
            )
        })
        .collect();
    assert_eq!(
        failed,
        [
            ("known.md", "read-failed", true),
            ("new.md", "read-failed", true)
        ]
    );
    assert_eq!(scan.failed_count, 2);
}

/// The walk and the watcher find one unreadable file in one open: one entry, whichever told
/// first.
#[test]
fn a_file_the_walk_and_the_watcher_both_find_unreadable_is_one_entry() {
    for walk_first in [true, false] {
        let f = fixture();
        f.applier.activity.open(&f.root);
        let watcher = || {
            f.applier.apply(VaultEvent::Unreadable {
                path: "locked.md".into(),
                reason: "EACCES".into(),
            })
        };
        let mut scan = ScanActivity::default();
        scan.fail("locked.md", "read-failed", Some("EACCES".into()));
        if !walk_first {
            watcher();
        }
        f.applier.report_scan(&scan);
        watcher();
        let failed: Vec<_> = listed(&f)
            .into_iter()
            .filter(|(kind, ..)| *kind == ActivityKind::Failed)
            .collect();
        assert_eq!(failed.len(), 1, "walk first: {walk_first}");
    }
}
