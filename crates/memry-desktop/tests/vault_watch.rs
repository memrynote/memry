//! The vault watcher on a real folder, with the real OS watcher and a real `note_files`
//! table. Each test names an invariant of 12d: an outside edit is never lost, the app's own
//! write never hides one, a rename is not a delete plus a new file, and every queue and walk
//! is bounded.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::note_files::NoteFiles;
use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::storage::OpenOptions;
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::watch::reconcile::Reconciler;
use memry_desktop::vault::watch::{EchoGuard, EventSink, VaultEvent, VaultWatcher};

const WAIT: Duration = Duration::from_secs(25);
const QUIET: Duration = Duration::from_millis(2500);

type Log = Arc<Mutex<Vec<VaultEvent>>>;

struct Env {
    _dir: tempfile::TempDir,
    root: PathBuf,
    vault: Vault,
    log: Log,
    echo: Arc<EchoGuard>,
    watcher: Option<VaultWatcher>,
}

fn sink(log: &Log) -> EventSink {
    let log = log.clone();
    Arc::new(move |event| log.lock().unwrap().push(event))
}

fn open_vault(root: &Path) -> Vault {
    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap()
}

fn env() -> Env {
    let mut e = env_unwatched();
    e.start();
    e
}

fn env_unwatched() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir_all(&root).unwrap();
    let vault = open_vault(&root);
    Env {
        _dir: dir,
        root,
        vault,
        log: Log::default(),
        echo: Arc::new(EchoGuard::default()),
        watcher: None,
    }
}

impl Env {
    fn start(&mut self) {
        self.watcher = Some(
            VaultWatcher::start(
                self.root.clone(),
                vec!["node_modules".into()],
                self.vault.note_files(),
                self.echo.clone(),
                sink(&self.log),
            )
            .unwrap(),
        );
        // Give the OS watcher a moment to be armed before the first write.
        std::thread::sleep(Duration::from_millis(300));
    }

    fn files(&self) -> NoteFiles {
        self.vault.note_files()
    }

    fn write(&self, rel: &str, text: &str) {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// A row as the index would have left it after reading `text` at `rel`.
    fn index(&self, id: &str, rel: &str, text: &str) {
        self.files()
            .upsert_stat(NoteFileStat {
                note_id: id.into(),
                path: rel.into(),
                file_type: "markdown".into(),
                mime_type: None,
                file_size: Some(text.len() as i64),
                content_hash: Some(content_hash(text)),
                indexed_at: i64::MAX / 2,
            })
            .unwrap();
    }

    fn mark(&self) -> usize {
        self.log.lock().unwrap().len()
    }

    fn since(&self, mark: usize) -> Vec<VaultEvent> {
        self.log.lock().unwrap()[mark..].to_vec()
    }

    fn wait_for(&self, mark: usize, what: &str, pred: impl Fn(&VaultEvent) -> bool) -> VaultEvent {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(found) = self.since(mark).into_iter().find(&pred) {
                return found;
            }
            assert!(
                Instant::now() < deadline,
                "no event for {what}; saw {:?}",
                self.since(mark)
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn quiet(&self, mark: usize, what: &str, pred: impl Fn(&VaultEvent) -> bool) {
        std::thread::sleep(QUIET);
        let seen: Vec<_> = self.since(mark).into_iter().filter(pred).collect();
        assert!(seen.is_empty(), "unexpected {what}: {seen:?}");
    }
}

fn is_added(path: &'static str) -> impl Fn(&VaultEvent) -> bool {
    move |e| matches!(e, VaultEvent::Added { path: p, .. } if p == path)
}

fn is_changed(path: &'static str) -> impl Fn(&VaultEvent) -> bool {
    move |e| matches!(e, VaultEvent::Changed { path: p, .. } if p == path)
}

fn is_removed(path: &'static str) -> impl Fn(&VaultEvent) -> bool {
    move |e| matches!(e, VaultEvent::Removed { path: p, .. } if p == path)
}

fn any_removed(e: &VaultEvent) -> bool {
    matches!(e, VaultEvent::Removed { .. })
}

#[test]
fn a_new_file_is_reported_with_its_hash_and_noise_is_not() {
    let e = env();
    let mark = e.mark();
    e.write("notes/new.md", "hello");
    e.write(".hidden.md", "x");
    e.write("attachments/p.png", "x");
    e.write("node_modules/p/x.md", "x");
    e.write("docs/readme.xyz", "x");
    let added = e.wait_for(mark, "Added", is_added("notes/new.md"));
    assert!(
        matches!(&added, VaultEvent::Added { file_type: FileType::Markdown, size: 5, content_hash: Some(h), .. }
            if *h == content_hash("hello")),
        "{added:?}"
    );
    e.wait_for(
        mark,
        "Unsupported",
        |ev| matches!(ev, VaultEvent::Unsupported { path } if path == "docs/readme.xyz"),
    );
    e.quiet(mark, "event for an ignored path", |ev| {
        matches!(ev, VaultEvent::Added { path, .. } | VaultEvent::Unsupported { path }
            if path.contains("hidden") || path.starts_with("attachments") || path.starts_with("node_modules"))
    });
}

#[test]
fn an_outside_edit_is_reported_and_a_save_of_the_same_bytes_is_not() {
    let e = env();
    e.write("a.md", "one");
    e.index("n1", "a.md", "one");
    let mark = e.mark();
    e.write("a.md", "one");
    e.quiet(mark, "Changed for equal bytes", is_changed("a.md"));
    let mark = e.mark();
    e.write("a.md", "two");
    let changed = e.wait_for(mark, "Changed", is_changed("a.md"));
    assert!(matches!(
        changed,
        VaultEvent::Changed { note_id, content_hash: Some(h), .. }
            if note_id == "n1" && h == content_hash("two")
    ));
}

#[test]
fn the_own_write_record_absorbs_only_the_content_the_app_wrote() {
    let e = env();
    e.write("a.md", "base");
    e.index("n1", "a.md", "base");

    // The app writes "mine": the echo is absorbed.
    e.echo.will_write("a.md", &content_hash("mine"));
    let mark = e.mark();
    e.write("a.md", "mine");
    e.quiet(mark, "Changed for the app's own write", is_changed("a.md"));

    // An outside edit to other content right after is not swallowed.
    let mark = e.mark();
    e.write("a.md", "theirs");
    e.wait_for(mark, "Changed for the outside edit", is_changed("a.md"));

    // The record is spent by that edit: the app's old text coming back is an edit too.
    let mark = e.mark();
    e.write("a.md", "mine");
    e.wait_for(mark, "Changed for the revert", is_changed("a.md"));
}

#[test]
fn an_own_removal_is_absorbed_and_an_outside_one_is_reported() {
    let e = env();
    e.write("own.md", "x");
    e.write("theirs.md", "y");
    e.index("n1", "own.md", "x");
    e.index("n2", "theirs.md", "y");
    e.echo.will_remove("own.md");
    let mark = e.mark();
    fs::remove_file(e.root.join("own.md")).unwrap();
    fs::remove_file(e.root.join("theirs.md")).unwrap();
    e.wait_for(mark, "Removed theirs", is_removed("theirs.md"));
    assert!(
        !e.since(mark).iter().any(is_removed("own.md")),
        "the app's own removal is not reported"
    );
}

#[test]
fn a_moved_note_keeps_its_id_and_is_not_a_delete_plus_a_new_file() {
    let e = env();
    e.write("a.md", "body");
    e.index("n1", "a.md", "body");
    let mark = e.mark();
    fs::create_dir_all(e.root.join("sub")).unwrap();
    fs::rename(e.root.join("a.md"), e.root.join("sub/b.md")).unwrap();
    let renamed = e.wait_for(mark, "Renamed", |ev| {
        matches!(ev, VaultEvent::Renamed { .. })
    });
    assert!(matches!(
        renamed,
        VaultEvent::Renamed { note_id, old_path, new_path, .. }
            if note_id == "n1" && old_path == "a.md" && new_path == "sub/b.md"
    ));
    e.quiet(mark, "Removed or Added after a rename", |ev| {
        matches!(ev, VaultEvent::Removed { .. })
            || matches!(ev, VaultEvent::Added { path, .. } if path == "sub/b.md")
    });
}

#[test]
fn a_moved_folder_renames_every_note_in_it() {
    let e = env();
    for n in 0..5 {
        let (rel, text) = (format!("old/n{n}.md"), format!("body {n}"));
        e.write(&rel, &text);
        e.index(&format!("id{n}"), &rel, &text);
    }
    let mark = e.mark();
    fs::rename(e.root.join("old"), e.root.join("new")).unwrap();
    let deadline = Instant::now() + WAIT;
    loop {
        let renamed = e
            .since(mark)
            .into_iter()
            .filter(|ev| matches!(ev, VaultEvent::Renamed { .. }))
            .count();
        if renamed == 5 {
            break;
        }
        assert!(Instant::now() < deadline, "saw {:?}", e.since(mark));
        std::thread::sleep(Duration::from_millis(50));
    }
    e.quiet(mark, "Removed after a folder move", any_removed);
}

#[test]
fn a_note_without_a_stored_hash_is_never_paired_with_a_new_file() {
    let e = env();
    e.write("a.md", "body");
    e.files()
        .upsert_stat(NoteFileStat {
            note_id: "n1".into(),
            path: "a.md".into(),
            file_type: "markdown".into(),
            mime_type: None,
            file_size: Some(4),
            content_hash: None,
            indexed_at: 1,
        })
        .unwrap();
    let mark = e.mark();
    fs::rename(e.root.join("a.md"), e.root.join("b.md")).unwrap();
    e.wait_for(mark, "Removed", is_removed("a.md"));
    e.wait_for(mark, "Added", is_added("b.md"));
    assert!(
        !e.since(mark)
            .iter()
            .any(|ev| matches!(ev, VaultEvent::Renamed { .. }))
    );
}

#[test]
fn a_deleted_note_and_a_deleted_folder_are_reported_once_each() {
    let e = env();
    e.write("a.md", "a");
    e.write("dir/b.md", "b");
    e.write("dir/c.md", "c");
    e.index("n1", "a.md", "a");
    e.index("n2", "dir/b.md", "b");
    e.index("n3", "dir/c.md", "c");
    let mark = e.mark();
    fs::remove_file(e.root.join("a.md")).unwrap();
    fs::remove_dir_all(e.root.join("dir")).unwrap();
    for path in ["a.md", "dir/b.md", "dir/c.md"] {
        e.wait_for(
            mark,
            path,
            move |ev| matches!(ev, VaultEvent::Removed { path: p, .. } if p == path),
        );
    }
    std::thread::sleep(Duration::from_millis(800));
    let removed = e.since(mark).iter().filter(|ev| any_removed(ev)).count();
    assert_eq!(removed, 3);
}

#[test]
fn a_flood_of_files_loses_none() {
    let e = env();
    let mark = e.mark();
    let count = 3000;
    for n in 0..count {
        e.write(&format!("flood/{}/n{n}.md", n % 20), "x");
    }
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let added = e
            .since(mark)
            .iter()
            .filter(|ev| matches!(ev, VaultEvent::Added { .. }))
            .count();
        if added >= count {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "only {added} of {count} reported"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
fn a_folder_link_that_points_back_into_the_vault_is_not_followed() {
    #[cfg(unix)]
    {
        let e = env();
        std::os::unix::fs::symlink(&e.root, e.root.join("loop")).unwrap();
        let mark = e.mark();
        e.write("real.md", "x");
        e.wait_for(mark, "Added", is_added("real.md"));
        e.quiet(
            mark,
            "an event through the link",
            |ev| matches!(ev, VaultEvent::Added { path, .. } if path.starts_with("loop")),
        );
    }
}

#[test]
fn a_file_with_a_second_hard_link_is_reported_unreadable_and_left_alone() {
    let e = env();
    e.write("a.md", "one");
    e.index("n1", "a.md", "one");
    fs::hard_link(e.root.join("a.md"), e.root.join("alias.md")).unwrap();
    let mark = e.mark();
    e.write("a.md", "two");
    e.wait_for(
        mark,
        "Unreadable",
        |ev| matches!(ev, VaultEvent::Unreadable { path, .. } if path == "a.md"),
    );
}

#[test]
fn files_removed_while_the_app_was_closed_are_reported_when_the_watcher_starts() {
    let mut e = env_unwatched();
    e.index("gone", "gone.md", "x");
    e.write("kept.md", "y");
    e.index("kept", "kept.md", "y");
    e.start();
    e.wait_for(0, "Removed", is_removed("gone.md"));
    assert!(!e.since(0).iter().any(is_removed("kept.md")));
}

#[test]
fn a_note_moved_while_the_app_was_closed_is_a_rename_not_a_delete() {
    let mut e = env_unwatched();
    e.index("n1", "old.md", "body");
    e.write("moved/new.md", "body");
    e.start();
    let renamed = e.wait_for(0, "Renamed", |ev| matches!(ev, VaultEvent::Renamed { .. }));
    assert!(matches!(
        renamed,
        VaultEvent::Renamed { note_id, new_path, .. } if note_id == "n1" && new_path == "moved/new.md"
    ));
    assert!(!e.since(0).iter().any(any_removed));
}

fn reconciler(e: &Env, limits: memry_desktop::vault::walk::Limits) -> (Reconciler, Log) {
    let log = Log::default();
    let r = Reconciler::new(
        e.root.clone(),
        vec![],
        e.files(),
        Arc::new(EchoGuard::default()),
        sink(&log),
    )
    .with_limits(limits);
    (r, log)
}

/// Runs a rescan and lets the rename window of what it found run out.
fn rescan(r: &mut Reconciler) {
    let stop = AtomicBool::new(false);
    let now = Instant::now();
    assert!(r.rescan(false, now, &stop).unwrap());
    r.settle_expired(now + Duration::from_secs(2));
}

fn rescanned(log: &Log) -> (usize, bool) {
    let events = log.lock().unwrap();
    events
        .iter()
        .find_map(|ev| match ev {
            VaultEvent::Rescanned {
                missing,
                removals_withheld,
                ..
            } => Some((*missing, *removals_withheld)),
            _ => None,
        })
        .expect("a Rescanned event")
}

fn removed_count(log: &Log) -> usize {
    log.lock()
        .unwrap()
        .iter()
        .filter(|ev| any_removed(ev))
        .count()
}

/// `total` indexed notes, of which the last `missing` have no file.
fn vault_with_missing(total: usize, missing: usize) -> Env {
    let e = env_unwatched();
    for n in 0..total {
        let (rel, text) = (format!("n{n}.md"), format!("body {n}"));
        e.index(&format!("id{n}"), &rel, &text);
        if n < total - missing {
            e.write(&rel, &text);
        }
    }
    e
}

#[test]
fn a_rescan_reports_ordinary_removals_and_withholds_a_mass_removal() {
    // (total rows, missing, withheld): the floor is more than 20 and the share more than 25 %.
    for (total, missing, withheld) in [
        (100, 5, false),
        (100, 21, false),
        (100, 25, false),
        (100, 26, true),
        (30, 20, false),
        (30, 21, true),
    ] {
        let e = vault_with_missing(total, missing);
        let (mut r, log) = reconciler(&e, memry_desktop::vault::walk::Limits::DEFAULT);
        rescan(&mut r);
        assert_eq!(rescanned(&log), (missing, withheld), "{total}/{missing}");
        assert_eq!(
            removed_count(&log),
            if withheld { 0 } else { missing },
            "{total}/{missing}"
        );
    }
}

#[test]
fn a_walk_cut_short_never_drives_a_removal() {
    let e = vault_with_missing(10, 3);
    let limits = memry_desktop::vault::walk::Limits {
        max_depth: 256,
        max_entries: 4,
        max_files: 1_000,
    };
    let (mut r, log) = reconciler(&e, limits);
    rescan(&mut r);
    assert_eq!(removed_count(&log), 0);
    assert!(rescanned(&log).1, "removals withheld");
}

#[cfg(unix)]
#[test]
fn a_folder_tree_deeper_than_the_walk_cap_ends_in_a_withheld_rescan_not_a_hang() {
    let e = vault_with_missing(2, 1);
    let mut deep = e.root.clone();
    for _ in 0..40 {
        deep.push("d");
    }
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("deep.md"), "x").unwrap();
    let limits = memry_desktop::vault::walk::Limits {
        max_depth: 8,
        max_entries: 100_000,
        max_files: 100_000,
    };
    let (mut r, log) = reconciler(&e, limits);
    rescan(&mut r);
    assert_eq!(removed_count(&log), 0);
    assert!(rescanned(&log).1);
}

#[cfg(unix)]
#[test]
fn an_unreachable_vault_reports_no_removal_and_a_rescan_follows_its_return() {
    let e = env();
    e.write("a.md", "a");
    e.index("n1", "a.md", "a");
    let core = e.root.join(".memry/core");
    let away = e.root.join(".memry/core.away");
    let mark = e.mark();
    // The database file is what says the vault is there.
    fs::rename(&core, &away).unwrap();
    fs::remove_file(e.root.join("a.md")).unwrap();
    e.wait_for(mark, "Unreachable", |ev| {
        matches!(ev, VaultEvent::Unreachable)
    });
    e.quiet(mark, "Removed while away", any_removed);
    fs::rename(&away, &core).unwrap();
    e.wait_for(mark, "Reachable", |ev| matches!(ev, VaultEvent::Reachable));
    // The file really is gone now: the rescan on return reports it.
    e.wait_for(mark, "Removed after return", is_removed("a.md"));
}

#[test]
fn stopping_joins_the_worker_and_no_event_follows() {
    let mut e = env();
    e.watcher.take().unwrap().stop_and_drop();
    let mark = e.mark();
    e.write("late.md", "x");
    e.quiet(mark, "an event after stop", |_| true);
}

#[test]
fn a_file_reported_once_is_not_reported_again_for_the_same_bytes() {
    let e = env();
    let mark = e.mark();
    e.write("n.md", "text");
    e.wait_for(mark, "Added", is_added("n.md"));
    let mark = e.mark();
    e.write("n.md", "text");
    e.quiet(mark, "a second Added for equal bytes", is_added("n.md"));
    // A real edit afterwards is still reported (as the same path with new content).
    let mark = e.mark();
    e.write("n.md", "text, edited");
    e.wait_for(mark, "the edit", |ev| {
        matches!(ev, VaultEvent::Added { path, content_hash: Some(h), .. }
            if path == "n.md" && *h == content_hash("text, edited"))
    });
}

#[test]
fn an_edit_that_returns_a_file_to_its_indexed_content_is_still_reported() {
    let e = env();
    e.write("a.md", "base");
    e.index("n1", "a.md", "base");
    let mark = e.mark();
    e.write("a.md", "edited");
    e.wait_for(mark, "Changed", is_changed("a.md"));
    // The consumer has not recorded "edited" yet: the row still says "base".
    let mark = e.mark();
    e.write("a.md", "base");
    e.wait_for(mark, "Changed back", |ev| {
        matches!(ev, VaultEvent::Changed { path, content_hash: Some(h), .. }
            if path == "a.md" && *h == content_hash("base"))
    });
}

#[test]
fn a_new_file_seen_before_its_removal_still_pairs_into_one_rename() {
    let e = env_unwatched();
    e.write("a.md", "body");
    e.index("n1", "a.md", "body");
    let (mut r, log) = reconciler(&e, memry_desktop::vault::walk::Limits::DEFAULT);
    fs::rename(e.root.join("a.md"), e.root.join("b.md")).unwrap();
    let t0 = Instant::now();
    // The OS delivered the new name first and the old one 100 ms later.
    r.batch(vec!["b.md".into()], t0);
    r.batch(vec!["a.md".into()], t0 + Duration::from_millis(100));
    r.settle_expired(t0 + Duration::from_millis(200));
    r.settle_expired(t0 + Duration::from_secs(2));
    let events = log.lock().unwrap().clone();
    assert!(
        matches!(events.as_slice(), [VaultEvent::Renamed { note_id, old_path, new_path, .. }]
            if note_id == "n1" && old_path == "a.md" && new_path == "b.md"),
        "{events:?}"
    );
}

#[test]
fn a_new_file_with_no_removal_is_reported_after_the_grace_and_not_before() {
    let e = env_unwatched();
    e.write("a.md", "body");
    let (mut r, log) = reconciler(&e, memry_desktop::vault::walk::Limits::DEFAULT);
    let t0 = Instant::now();
    r.batch(vec!["a.md".into()], t0);
    r.settle_expired(t0 + Duration::from_millis(100));
    assert!(log.lock().unwrap().is_empty(), "still inside the grace");
    r.settle_expired(t0 + Duration::from_secs(1));
    assert!(
        matches!(log.lock().unwrap().as_slice(), [VaultEvent::Added { path, .. }] if path == "a.md")
    );
}

#[test]
fn a_file_created_and_removed_inside_the_grace_is_never_reported() {
    let e = env_unwatched();
    e.write("tmp.md", "x");
    let (mut r, log) = reconciler(&e, memry_desktop::vault::walk::Limits::DEFAULT);
    let t0 = Instant::now();
    r.batch(vec!["tmp.md".into()], t0);
    fs::remove_file(e.root.join("tmp.md")).unwrap();
    r.batch(vec!["tmp.md".into()], t0 + Duration::from_millis(100));
    r.settle_expired(t0 + Duration::from_secs(2));
    assert!(log.lock().unwrap().is_empty(), "{:?}", log.lock().unwrap());
}

#[test]
fn the_session_starts_the_watcher_on_open_and_joins_it_on_close() {
    use memry_desktop::registry::{AppConfig, VaultRegistry};
    use memry_desktop::session::{OpenSource, Session};
    use memry_desktop::vault::watch::VaultTier;

    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(
        dir.path().join("app/memry-config.json"),
    )));
    let session = Session::new(registry);
    let log = Log::default();
    VaultTier::new(sink(&log)).register(&session);

    let opened = session.open(&vault, OpenSource::Select).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    fs::write(vault.join("hello.md"), "hi").unwrap();
    let deadline = Instant::now() + WAIT;
    while !log
        .lock()
        .unwrap()
        .iter()
        .any(|ev| matches!(ev, VaultEvent::Added { path, .. } if path == "hello.md"))
    {
        assert!(
            Instant::now() < deadline,
            "no Added after open: {:?}",
            log.lock().unwrap()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(opened);
    session.close();

    let before = log.lock().unwrap().len();
    fs::write(vault.join("late.md"), "x").unwrap();
    std::thread::sleep(QUIET);
    assert_eq!(
        log.lock().unwrap().len(),
        before,
        "the watcher stopped with the vault"
    );
    // The same session opens again and watches again.
    let reopened = session.open(&vault, OpenSource::Select).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    fs::write(vault.join("again.md"), "y").unwrap();
    let deadline = Instant::now() + WAIT;
    while !log
        .lock()
        .unwrap()
        .iter()
        .any(|ev| matches!(ev, VaultEvent::Added { path, .. } if path == "again.md"))
    {
        assert!(Instant::now() < deadline, "no Added after reopen");
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(reopened);
}

#[test]
fn files_held_for_pairing_are_bounded_and_none_is_lost() {
    use memry_desktop::vault::watch::reconcile::MAX_HELD_ADDS;
    let e = env_unwatched();
    let total = MAX_HELD_ADDS + 50;
    let rels: Vec<String> = (0..total).map(|n| format!("bulk/n{n}.md")).collect();
    for rel in &rels {
        e.write(rel, "x");
    }
    let (mut r, log) = reconciler(&e, memry_desktop::vault::walk::Limits::DEFAULT);
    let t0 = Instant::now();
    r.batch(rels, t0);
    let reported = |log: &Log| {
        log.lock()
            .unwrap()
            .iter()
            .filter(|ev| matches!(ev, VaultEvent::Added { .. }))
            .count()
    };
    assert_eq!(
        reported(&log),
        50,
        "past the bound a file is reported at once"
    );
    // The grace of each file runs from when it was looked at, which a batch this big spreads
    // over seconds in a debug build.
    r.settle_expired(Instant::now() + Duration::from_secs(2));
    assert_eq!(reported(&log), total);
}

#[test]
fn an_outside_edit_back_to_an_earlier_reported_state_is_not_hidden_by_an_own_write_between() {
    let e = env_unwatched();
    e.write("a.md", "base");
    e.index("n1", "a.md", "base");
    let echo = Arc::new(EchoGuard::default());
    let log = Log::default();
    let mut r = Reconciler::new(e.root.clone(), vec![], e.files(), echo.clone(), sink(&log));
    let t0 = Instant::now();
    e.write("a.md", "outside one");
    r.batch(vec!["a.md".into()], t0);
    // The app writes its own text over it; the write is absorbed.
    echo.will_write("a.md", &content_hash("app text"));
    e.write("a.md", "app text");
    r.batch(vec!["a.md".into()], t0);
    // The user puts the first outside text back.
    e.write("a.md", "outside one");
    r.batch(vec!["a.md".into()], t0);
    let changed: Vec<_> = log
        .lock()
        .unwrap()
        .iter()
        .filter_map(|ev| match ev {
            VaultEvent::Changed {
                content_hash: Some(h),
                ..
            } => Some(h.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        changed,
        [content_hash("outside one"), content_hash("outside one")]
    );
}

#[test]
fn files_in_a_folder_that_appeared_are_reported_from_the_walk_unsupported_ones_too() {
    let e = env_unwatched();
    e.write("fresh/a.md", "x");
    e.write("fresh/readme.xyz", "y");
    e.write("fresh/.hidden.md", "z");
    let (mut r, log) = reconciler(&e, memry_desktop::vault::walk::Limits::DEFAULT);
    let t0 = Instant::now();
    r.batch(vec!["fresh".into()], t0);
    r.settle_expired(t0 + Duration::from_secs(1));
    let events = log.lock().unwrap().clone();
    assert!(
        events
            .iter()
            .any(|ev| matches!(ev, VaultEvent::Added { path, .. } if path == "fresh/a.md"))
    );
    assert!(
        events
            .iter()
            .any(|ev| matches!(ev, VaultEvent::Unsupported { path } if path == "fresh/readme.xyz"))
    );
    assert_eq!(events.len(), 2, "{events:?}");
}
