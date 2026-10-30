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
