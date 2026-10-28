//! The watcher never contradicts itself (12d review): once it has reported a rename, a
//! removal, a change or an addition, every later removal, rescan and pairing reads that
//! report before the `note_files` row, which no consumer has updated yet. Driven through the
//! reconciler with no OS watcher, so each step is deterministic.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::note_files::NoteFiles;
use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::storage::OpenOptions;
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::watch::reconcile::Reconciler;
use memry_desktop::vault::watch::{EchoGuard, EventSink, VaultEvent};

type Log = Arc<Mutex<Vec<VaultEvent>>>;

/// A folder where `Note.md` and `note.md` are two names. The temp dir of macOS and Windows is
/// not one (APFS and NTFS fold case by default), so macOS mounts a case-sensitive APFS image;
/// Linux temp dirs already are.
struct CaseSensitiveVolume {
    _dir: tempfile::TempDir,
    mount: Option<PathBuf>,
}

// Only the non-Windows tests build one: NTFS folds case.
#[cfg_attr(windows, allow(dead_code))]
impl CaseSensitiveVolume {
    fn new() -> (Self, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        if !cfg!(target_os = "macos") {
            let root = dir.path().to_path_buf();
            return (
                Self {
                    _dir: dir,
                    mount: None,
                },
                root,
            );
        }
        let image = dir.path().join("volume");
        let mount = dir.path().join("mount");
        fs::create_dir_all(&mount).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("hdiutil")
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "hdiutil {args:?}: {out:?}");
        };
        run(&[
            "create",
            "-size",
            "40m",
            "-fs",
            "Case-sensitive APFS",
            "-volname",
            "memry",
            "-type",
            "SPARSE",
            image.to_str().unwrap(),
        ]);
        run(&[
            "attach",
            &format!("{}.sparseimage", image.display()),
            "-mountpoint",
            mount.to_str().unwrap(),
            "-nobrowse",
        ]);
        (
            Self {
                _dir: dir,
                mount: Some(mount.clone()),
            },
            mount,
        )
    }
}

impl Drop for CaseSensitiveVolume {
    fn drop(&mut self) {
        if let Some(mount) = &self.mount {
            let _ = std::process::Command::new("hdiutil")
                .args(["detach", "-force", mount.to_str().unwrap()])
                .output();
        }
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    _volume: Option<CaseSensitiveVolume>,
    root: PathBuf,
    vault: Vault,
    log: Log,
    echo: Arc<EchoGuard>,
    t0: Instant,
}

fn fixture() -> Fixture {
    fixture_in(None)
}

fn fixture_in(volume: Option<(CaseSensitiveVolume, PathBuf)>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let (volume, base) = match volume {
        Some((volume, base)) => (Some(volume), base),
        None => (None, dir.path().to_path_buf()),
    };
    let root = base.join("vault");
    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    Fixture {
        _dir: dir,
        _volume: volume,
        root,
        vault,
        log: Log::default(),
        echo: Arc::new(EchoGuard::default()),
        t0: Instant::now(),
    }
}

impl Fixture {
    fn files(&self) -> NoteFiles {
        self.vault.note_files()
    }

    fn reconciler(&self) -> Reconciler {
        let log = self.log.clone();
        let sink: EventSink = Arc::new(move |event| log.lock().unwrap().push(event));
        Reconciler::new(
            self.root.clone(),
            vec![],
            self.files(),
            self.echo.clone(),
            sink,
        )
    }

    fn write(&self, rel: &str, text: &str) {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn index(&self, id: &str, rel: &str, text: &str) {
        self.index_as(id, rel, "markdown", text.len(), Some(content_hash(text)));
    }

    fn index_as(&self, id: &str, rel: &str, kind: &str, size: usize, hash: Option<String>) {
        self.files()
            .upsert_stat(NoteFileStat {
                note_id: id.into(),
                path: rel.into(),
                file_type: kind.into(),
                mime_type: None,
                file_size: Some(size as i64),
                content_hash: hash,
                indexed_at: i64::MAX / 2,
            })
            .unwrap();
    }

    fn take(&self) -> Vec<VaultEvent> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }

    /// One debounced batch, then the grace and the rename window run out.
    fn touch(&self, r: &mut Reconciler, rels: &[&str], step: u64) {
        let at = self.t0 + Duration::from_secs(step * 10);
        r.batch(rels.iter().map(|s| (*s).to_owned()).collect(), at);
        r.settle_expired(at + Duration::from_secs(2));
    }

    fn settle(&self, r: &mut Reconciler, step: u64) {
        r.settle_expired(self.t0 + Duration::from_secs(step * 10 + 2));
    }

    fn rescan(&self, r: &mut Reconciler, with_changes: bool, step: u64) {
        let at = self.t0 + Duration::from_secs(step * 10);
        let stop = AtomicBool::new(false);
        assert!(r.rescan(with_changes, at, &stop).unwrap());
    }

    fn rename(&self, from: &str, to: &str) {
        let target = self.root.join(to);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::rename(self.root.join(from), target).unwrap();
    }
}

fn renamed(id: &str, old: &str, new: &str) -> impl Fn(&VaultEvent) -> bool {
    let (id, old, new) = (id.to_owned(), old.to_owned(), new.to_owned());
    move |e| {
        matches!(e, VaultEvent::Renamed { note_id, old_path, new_path, .. }
            if *note_id == id && *old_path == old && *new_path == new)
    }
}

fn kinds(events: &[VaultEvent]) -> Vec<&'static str> {
    events.iter().map(VaultEvent::kind).collect()
}

fn without_rescanned(events: Vec<VaultEvent>) -> Vec<VaultEvent> {
    events
        .into_iter()
        .filter(|e| !matches!(e, VaultEvent::Rescanned { .. }))
        .collect()
}

/// A note moved A -> B and reported; the table still says A.
fn moved_and_reported(f: &Fixture, r: &mut Reconciler) {
    f.write("a.md", "body");
    f.index("n1", "a.md", "body");
    f.rename("a.md", "b.md");
    f.touch(r, &["a.md", "b.md"], 1);
    assert!(
        f.take().iter().any(renamed("n1", "a.md", "b.md")),
        "the move is reported"
    );
}

#[test]
fn a_rescan_after_a_reported_move_does_not_remove_the_note_that_moved() {
    let f = fixture();
    let mut r = f.reconciler();
    moved_and_reported(&f, &mut r);
    for (step, with_changes) in [(2, false), (3, true)] {
        f.rescan(&mut r, with_changes, step);
        let events = without_rescanned(f.take());
        assert!(events.is_empty(), "contradicts the Renamed: {events:?}");
    }
}

#[test]
fn deleting_a_note_after_a_reported_move_removes_it_at_its_new_path() {
    let f = fixture();
    let mut r = f.reconciler();
    moved_and_reported(&f, &mut r);
    fs::remove_file(f.root.join("b.md")).unwrap();
    f.touch(&mut r, &["b.md"], 2);
    let events = f.take();
    assert!(
        matches!(events.as_slice(), [VaultEvent::Removed { note_id, path }] if note_id == "n1" && path == "b.md"),
        "{events:?}"
    );
}

#[test]
fn moving_a_note_twice_is_two_renames_and_never_a_new_note() {
    let f = fixture();
    let mut r = f.reconciler();
    moved_and_reported(&f, &mut r);
    f.rename("b.md", "c.md");
    f.touch(&mut r, &["b.md", "c.md"], 2);
    let events = f.take();
    assert!(
        matches!(events.as_slice(), [e] if renamed("n1", "b.md", "c.md")(e)),
        "{kinds:?}",
        kinds = kinds(&events)
    );
}

#[test]
fn a_folder_deleted_after_its_notes_moved_into_it_removes_those_notes() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("a.md", "body");
    f.index("n1", "a.md", "body");
    f.rename("a.md", "dir/a.md");
    f.touch(&mut r, &["a.md", "dir"], 1);
    assert!(f.take().iter().any(renamed("n1", "a.md", "dir/a.md")));
    fs::remove_dir_all(f.root.join("dir")).unwrap();
    f.touch(&mut r, &["dir"], 2);
    let events = f.take();
    assert!(
        matches!(events.as_slice(), [VaultEvent::Removed { note_id, path }] if note_id == "n1" && path == "dir/a.md"),
        "{events:?}"
    );
}

#[test]
fn a_removal_is_reported_once_and_a_file_back_at_that_path_is_new() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("a.md", "body");
    f.index("n1", "a.md", "body");
    fs::remove_file(f.root.join("a.md")).unwrap();
    f.touch(&mut r, &["a.md"], 1);
    assert_eq!(kinds(&f.take()), ["removed"]);
    f.rescan(&mut r, true, 2);
    assert!(
        without_rescanned(f.take()).is_empty(),
        "a second Removed for the same note"
    );
    f.write("a.md", "something else");
    f.touch(&mut r, &["a.md"], 3);
    let events = f.take();
    assert!(
        matches!(events.as_slice(), [VaultEvent::Added { path, .. }] if path == "a.md"),
        "a Changed for a note already reported removed: {events:?}"
    );
}

#[test]
fn a_note_edited_outside_and_then_moved_keeps_its_id() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("a.md", "base");
    f.index("n1", "a.md", "base");
    f.write("a.md", "edited");
    f.touch(&mut r, &["a.md"], 1);
    assert_eq!(kinds(&f.take()), ["changed"]);
    f.rename("a.md", "b.md");
    f.touch(&mut r, &["a.md", "b.md"], 2);
    let events = f.take();
    assert!(
        matches!(events.as_slice(), [e] if renamed("n1", "a.md", "b.md")(e)),
        "the move of an edited note lost its id: {events:?}"
    );
}

#[test]
fn a_case_only_rename_is_a_rename_not_a_new_note() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("Note.md", "body");
    f.index("n1", "Note.md", "body");
    f.rename("Note.md", "note.md");
    // A case-insensitive volume reports only the new spelling.
    f.touch(&mut r, &["note.md"], 1);
    let events = f.take();
    assert!(
        matches!(events.as_slice(), [e] if renamed("n1", "Note.md", "note.md")(e)),
        "{events:?}"
    );
}

#[test]
fn a_file_renamed_to_another_unicode_spelling_is_a_rename_not_a_new_note() {
    let f = fixture();
    let mut r = f.reconciler();
    let (nfc, nfd) = ("caf\u{e9}.md", "cafe\u{301}.md");
    f.write(nfc, "body");
    f.index("n1", nfc, "body");
    f.rename(nfc, nfd);
    f.touch(&mut r, &[nfd], 1);
    let events = f.take();
    assert!(
        matches!(events.as_slice(), [e] if renamed("n1", nfc, nfd)(e)),
        "{events:?}"
    );
}

#[test]
fn an_own_removal_of_a_file_that_is_not_markdown_is_forgotten_once_the_file_is_back() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("doc.pdf", "pdf bytes");
    f.index_as("n1", "doc.pdf", "pdf", 9, None);
    f.echo.will_remove("doc.pdf");
    fs::remove_file(f.root.join("doc.pdf")).unwrap();
    f.touch(&mut r, &["doc.pdf"], 1);
    assert!(f.take().is_empty(), "the app's own removal");
    f.write("doc.pdf", "pdf bytes");
    f.touch(&mut r, &["doc.pdf"], 2);
    f.take();
    fs::remove_file(f.root.join("doc.pdf")).unwrap();
    f.touch(&mut r, &["doc.pdf"], 3);
    assert_eq!(
        kinds(&f.take()),
        ["removed"],
        "an outside delete swallowed by a spent record"
    );
}

#[test]
fn a_rescan_after_an_overflow_finds_an_edit_that_kept_its_modification_time() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("a.md", "a longer text than the row knows");
    f.index("n1", "a.md", "short");
    f.rescan(&mut r, true, 1);
    let events = without_rescanned(f.take());
    assert!(
        matches!(events.as_slice(), [VaultEvent::Changed { note_id, .. }] if note_id == "n1"),
        "{events:?}"
    );
}

#[cfg(not(windows))]
#[test]
fn a_respell_on_a_case_sensitive_volume_is_one_rename_and_never_also_a_removal() {
    let f = fixture_in(Some(CaseSensitiveVolume::new()));
    let mut r = f.reconciler();
    f.write("Note.md", "body");
    f.index("n1", "Note.md", "body");
    f.rename("Note.md", "note.md");
    // This volume reports both names: one is gone, the other is new.
    f.touch(&mut r, &["Note.md", "note.md"], 1);
    let events = f.take();
    assert!(
        matches!(events.as_slice(), [e] if renamed("n1", "Note.md", "note.md")(e)),
        "a Removed for a note that was only respelled: {events:?}"
    );
}

#[cfg(not(windows))]
#[test]
fn a_respell_seen_before_its_old_name_is_gone_is_not_a_removal_either() {
    let f = fixture_in(Some(CaseSensitiveVolume::new()));
    let mut r = f.reconciler();
    f.write("Note.md", "body");
    f.index("n1", "Note.md", "body");
    f.rename("Note.md", "note.md");
    f.touch(&mut r, &["note.md"], 1);
    f.touch(&mut r, &["Note.md"], 2);
    f.rescan(&mut r, true, 3);
    f.settle(&mut r, 3);
    let events = without_rescanned(f.take());
    assert!(
        matches!(events.as_slice(), [e] if renamed("n1", "Note.md", "note.md")(e)),
        "{events:?}"
    );
}

/// A pass that began long before it looked at the file: its start is older than the window.
fn long_ago() -> Instant {
    Instant::now()
        .checked_sub(Duration::from_secs(2))
        .expect("a clock that has run for two seconds")
}

fn rescan_started_at(r: &mut Reconciler, with_changes: bool, started: Instant) {
    let stop = AtomicBool::new(false);
    assert!(r.rescan(with_changes, started, &stop).unwrap());
}

#[test]
fn a_rescan_finds_a_delete_but_reports_it_only_once_it_has_stayed_gone_from_its_own_check() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("a.md", "body");
    f.index("n1", "a.md", "body");
    fs::remove_file(f.root.join("a.md")).unwrap();
    // The pass began 2 s ago (a vault that takes long to walk): a delete timed from that start
    // would be reported on the next tick, without ever having stayed gone.
    rescan_started_at(&mut r, true, long_ago());
    r.settle_expired(Instant::now() + Duration::from_millis(100));
    assert!(
        f.take().is_empty(),
        "reported at once, or its signal came first"
    );

    // The checkout that deleted it puts it back inside the window.
    f.write("a.md", "body");
    r.settle_expired(Instant::now() + Duration::from_millis(700));
    let events = f.take();
    assert_eq!(kinds(&events), ["rescanned"], "{events:?}");
    assert!(matches!(
        events[0],
        VaultEvent::Rescanned {
            missing: 1,
            removed: 0,
            ..
        }
    ));
}

#[test]
fn a_rescan_that_stays_gone_reports_the_removal_and_then_its_signal() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("a.md", "body");
    f.index("n1", "a.md", "body");
    fs::remove_file(f.root.join("a.md")).unwrap();
    rescan_started_at(&mut r, true, long_ago());
    r.settle_expired(Instant::now() + Duration::from_millis(100));
    assert!(f.take().is_empty());
    r.settle_expired(Instant::now() + Duration::from_millis(700));
    let events = f.take();
    assert_eq!(kinds(&events), ["removed", "rescanned"], "{events:?}");
    assert!(matches!(
        events[1],
        VaultEvent::Rescanned {
            missing: 1,
            removed: 1,
            ..
        }
    ));
}

#[test]
fn a_new_file_a_rescan_found_is_reported_before_its_signal_and_not_early() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("a.md", "gone");
    f.index("n1", "a.md", "gone");
    fs::remove_file(f.root.join("a.md")).unwrap();
    f.write("b.md", "something new");
    rescan_started_at(&mut r, true, long_ago());
    r.settle_expired(Instant::now() + Duration::from_millis(100));
    assert!(
        f.take().is_empty(),
        "the grace of a held file starts when it was looked at"
    );
    r.settle_expired(Instant::now() + Duration::from_millis(700));
    assert_eq!(kinds(&f.take()), ["added", "removed", "rescanned"]);
}

#[cfg(not(windows))]
#[test]
fn an_edit_and_a_delete_beside_a_surviving_file_do_not_wipe_its_baseline() {
    // Two files on a case-sensitive volume whose names fold to one key. The removal of
    // `Note.md` forgets that note's report and not the one of `note.md`, which would be
    // reported as edited again.
    let f = fixture_in(Some(CaseSensitiveVolume::new()));
    let mut r = f.reconciler();
    f.write("Note.md", "one");
    f.write("note.md", "two");
    f.index("n1", "Note.md", "one");
    f.index("n2", "note.md", "two");
    f.write("note.md", "two edited");
    f.touch(&mut r, &["note.md"], 1);
    assert_eq!(kinds(&f.take()), ["changed"]);
    fs::remove_file(f.root.join("Note.md")).unwrap();
    f.rescan(&mut r, false, 2);
    f.settle(&mut r, 2);
    let events = without_rescanned(f.take());
    assert!(
        matches!(events.as_slice(), [VaultEvent::Removed { note_id, .. }] if note_id == "n1"),
        "{events:?}"
    );
    f.touch(&mut r, &["note.md"], 3);
    assert!(f.take().is_empty(), "the surviving file was reported again");
}

#[test]
fn a_rescan_after_an_edit_and_a_move_pairs_by_the_reported_content() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("a.md", "base");
    f.index("n1", "a.md", "base");
    f.write("a.md", "edited");
    f.touch(&mut r, &["a.md"], 1);
    assert_eq!(kinds(&f.take()), ["changed"]);
    f.rename("a.md", "b.md");
    f.rescan(&mut r, true, 2);
    f.settle(&mut r, 2);
    let events = without_rescanned(f.take());
    assert!(
        matches!(events.as_slice(), [e] if renamed("n1", "a.md", "b.md")(e)),
        "{events:?}"
    );
}

#[test]
fn a_stopped_reconciler_tracks_no_removal_that_could_settle_later() {
    let f = fixture();
    f.write("a.md", "body");
    f.index("n1", "a.md", "body");
    let stop = Arc::new(AtomicBool::new(false));
    let mut r = f.reconciler().with_stop(stop.clone());
    fs::remove_file(f.root.join("a.md")).unwrap();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    f.touch(&mut r, &["a.md"], 1);
    assert!(f.take().is_empty());
}

#[test]
fn every_rescan_ends_with_its_signal() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("a.md", "body");
    f.index("n1", "a.md", "body");
    f.rescan(&mut r, false, 1);
    assert_eq!(
        kinds(&f.take()),
        ["rescanned"],
        "even when nothing is missing"
    );
}

// A pass's `Rescanned` waits for what the pass found, and only for that: the consumer starts
// its open walk on it (12e), so a file a writer keeps rewriting must not hold it back, and two
// passes report in the order they ran.

#[test]
fn a_new_file_alone_holds_the_signal_of_the_pass_that_found_it_until_it_is_reported() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("b.md", "new");
    let t0 = Instant::now();
    rescan_started_at(&mut r, true, t0);
    r.settle_expired(t0 + Duration::from_millis(100));
    assert!(
        f.take().is_empty(),
        "the signal came before the file it found"
    );
    r.settle_expired(t0 + Duration::from_millis(700));
    assert_eq!(kinds(&f.take()), ["added", "rescanned"]);
}

#[test]
fn a_file_rewritten_in_bursts_does_not_hold_back_the_signal_of_the_pass_that_found_it() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("burst.md", "0");
    let t0 = Instant::now();
    rescan_started_at(&mut r, true, t0);
    // A writer rewrites it every 200 ms for 10 s, and each write holds it again.
    let mut signal_at = None;
    for step in 1..=50u64 {
        let at = t0 + Duration::from_millis(200 * step);
        f.write("burst.md", &step.to_string());
        r.batch(vec!["burst.md".to_owned()], at);
        r.settle_expired(at);
        let rescanned = f
            .take()
            .iter()
            .any(|e| matches!(e, VaultEvent::Rescanned { .. }));
        if rescanned && signal_at.is_none() {
            signal_at = Some(step);
        }
    }
    let step = signal_at.expect("no Rescanned while the writer ran");
    assert!(
        step <= 2,
        "held back until step {step}: the pass waited on a hold it did not make"
    );
}

#[test]
fn two_passes_report_their_signals_in_the_order_they_ran() {
    let f = fixture();
    let mut r = f.reconciler();
    f.write("b.md", "new");
    let t0 = Instant::now();
    // The first pass holds the new file; the second, right after, finds nothing missing and
    // has nothing to wait for.
    rescan_started_at(&mut r, true, t0);
    rescan_started_at(&mut r, false, t0);
    r.settle_expired(t0 + Duration::from_millis(700));
    let events = f.take();
    assert_eq!(
        kinds(&events),
        ["added", "rescanned", "rescanned"],
        "the second pass's signal overtook the first's: {events:?}"
    );
}

#[cfg(not(windows))]
#[test]
fn an_unlinked_name_beside_its_other_case_is_that_note_and_a_copy_of_the_other_is_new() {
    // `Note.md` (n1) and `note.md` (n2) are two files. Unlinking `Note.md` is n1's delete,
    // never a delete of n2 that a copy of `note.md` could then claim as a move.
    let f = fixture_in(Some(CaseSensitiveVolume::new()));
    let mut r = f.reconciler();
    f.write("Note.md", "one");
    f.write("note.md", "two");
    f.index("n1", "Note.md", "one");
    f.index("n2", "note.md", "two");
    f.write("note.md", "two edited");
    f.touch(&mut r, &["note.md"], 1);
    assert_eq!(kinds(&f.take()), ["changed"]);

    fs::remove_file(f.root.join("Note.md")).unwrap();
    fs::copy(f.root.join("note.md"), f.root.join("copy.md")).unwrap();
    let at = f.t0 + Duration::from_secs(20);
    r.batch(vec!["Note.md".to_owned()], at);
    r.batch(vec!["copy.md".to_owned()], at + Duration::from_millis(100));
    r.settle_expired(at + Duration::from_secs(2));
    let events = f.take();
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, VaultEvent::Renamed { .. })),
        "n2 moved away from a file that is still there: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, VaultEvent::Removed { note_id, .. } if note_id == "n1")),
        "{events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, VaultEvent::Added { path, .. } if path == "copy.md")),
        "{events:?}"
    );
}
