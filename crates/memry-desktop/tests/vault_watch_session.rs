//! The watcher is scoped to one vault session, and every lost-event path ends in a rescan
//! (12d review): the own-write record does not outlive a session, a stopped watcher reports
//! nothing, and an edit no OS event announced is found by the safety-net rescan.

mod device_key;

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::storage::OpenOptions;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::VaultTier;
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::watch::reconcile::Reconciler;
use memry_desktop::vault::watch::{
    EchoGuard, EventSink, NewFiles, Tuning, VaultEvent, VaultWatcher,
};

type Log = Arc<Mutex<Vec<VaultEvent>>>;

fn sink(log: &Log) -> EventSink {
    let log = log.clone();
    Arc::new(move |event| log.lock().unwrap().push(event))
}

#[test]
fn the_own_write_record_does_not_outlive_the_vault_session() {
    let dir = tempfile::tempdir().unwrap();
    let (vault_a, vault_b) = (dir.path().join("a"), dir.path().join("b"));
    fs::create_dir_all(&vault_a).unwrap();
    fs::create_dir_all(&vault_b).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(
        dir.path().join("app/memry-config.json"),
    )));
    let session = Session::new(registry);
    let tier = VaultTier::new(device_key::with_device_key());
    tier.register(&session);

    let opened = session.open(&vault_a, OpenSource::Select).unwrap();
    tier.echo().will_remove("shared.md");
    tier.echo().will_write("note.md", &content_hash(""));
    drop(opened);
    session.close();
    let opened = session.open(&vault_b, OpenSource::Select).unwrap();
    let echo = tier.echo();
    assert!(
        !echo.absorbs_removal("shared.md"),
        "a delete in vault B swallowed by vault A's record"
    );
    assert!(
        !echo.absorbs_write("note.md", &content_hash("")),
        "an empty file in vault B absorbed by vault A's record"
    );
    drop(opened);
}

#[test]
fn a_stopped_reconciler_reports_nothing_more_from_a_folder_it_was_walking() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    for n in 0..50 {
        fs::create_dir_all(root.join("big")).unwrap();
        fs::write(root.join(format!("big/n{n}.md")), format!("body {n}")).unwrap();
    }
    let log = Log::default();
    let stop = Arc::new(AtomicBool::new(false));
    let mut r = Reconciler::new(
        root,
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink(&log),
    )
    .with_stop(stop.clone());
    stop.store(true, Ordering::Relaxed);
    let t0 = Instant::now();
    r.batch(vec!["big".into()], t0);
    r.settle_expired(t0 + Duration::from_secs(5));
    assert!(log.lock().unwrap().is_empty(), "{:?}", log.lock().unwrap());
}

#[test]
fn an_edit_no_os_event_announced_is_found_by_the_safety_net_rescan() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    // Edited while no watcher was looking, so no event will ever name it.
    fs::write(root.join("a.md"), "edited behind the watcher's back").unwrap();
    vault
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: "n1".into(),
            path: "a.md".into(),
            file_type: "markdown".into(),
            mime_type: None,
            file_size: Some(4),
            content_hash: Some(content_hash("base")),
            indexed_at: 1,
        })
        .unwrap();
    let log = Log::default();
    let tuning = Tuning {
        periodic: Some(Duration::from_millis(600)),
        burst: None,
        rearm: false,
    };
    let _watcher = VaultWatcher::start_with(
        root,
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink(&log),
        tuning,
        NewFiles::Report,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let found = log
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, VaultEvent::Changed { note_id, .. } if note_id == "n1"));
        if found {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "no Changed from the safety net: {:?}",
            log.lock().unwrap()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn no_event_leaves_a_watcher_once_its_stop_has_begun_even_while_its_thread_is_mid_step() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    let log = Log::default();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let (events, gate) = (log.clone(), release.clone());
    // The first `Added` blocks inside the sink, so the worker is stopped in the middle of the
    // step that reports three files in a row.
    let slow: EventSink = Arc::new(move |event| {
        let first = {
            let mut seen = events.lock().unwrap();
            let is_added = matches!(event, VaultEvent::Added { .. });
            let first_added =
                is_added && !seen.iter().any(|e| matches!(e, VaultEvent::Added { .. }));
            seen.push(event);
            first_added
        };
        if first {
            entered_tx.send(()).unwrap();
            let (held, wake) = &*gate;
            let mut open = held.lock().unwrap();
            while !*open {
                open = wake.wait(open).unwrap();
            }
        }
    });
    let watcher = VaultWatcher::start(
        root.clone(),
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        slow,
        NewFiles::Report,
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    for n in 0..3 {
        fs::write(root.join(format!("n{n}.md")), format!("body {n}")).unwrap();
    }
    entered_rx
        .recv_timeout(Duration::from_secs(25))
        .expect("the first Added reached the sink");

    let stopping = std::thread::spawn(move || watcher.stop_and_drop());
    std::thread::sleep(Duration::from_millis(400));
    {
        let (held, wake) = &*release;
        *held.lock().unwrap() = true;
        wake.notify_all();
    }
    stopping.join().unwrap();
    let added = log
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, VaultEvent::Added { .. }))
        .count();
    assert_eq!(
        added,
        1,
        "events left a stopping watcher: {:?}",
        log.lock().unwrap()
    );
}

fn wait_for(log: &Log, what: &str, found: impl Fn(&[VaultEvent]) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(25);
    while !found(&log.lock().unwrap()) {
        assert!(
            Instant::now() < deadline,
            "{what}: {:?}",
            log.lock().unwrap()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn count(log: &Log, what: impl Fn(&VaultEvent) -> bool) -> usize {
    log.lock().unwrap().iter().filter(|e| what(e)).count()
}

/// A consumer that dropped events asks for a resync: what was reported is forgotten, and a
/// rescan with changes reports again everything the rows do not hold yet. A consumer that
/// could not apply one path asks to forget only that path.
#[test]
fn a_resync_reports_again_what_the_rows_do_not_hold_and_a_forget_only_its_path() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    fs::write(root.join("gone.md"), "base").unwrap();
    vault
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: "n1".into(),
            path: "gone.md".into(),
            file_type: "markdown".into(),
            mime_type: None,
            file_size: Some(4),
            content_hash: Some(content_hash("base")),
            indexed_at: i64::MAX,
        })
        .unwrap();
    let log = Log::default();
    let watcher = VaultWatcher::start(
        root.clone(),
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink(&log),
        NewFiles::Report,
    )
    .unwrap();
    wait_for(&log, "the start pass", |l| {
        l.iter().any(|e| matches!(e, VaultEvent::Rescanned { .. }))
    });
    fs::write(root.join("new.md"), "new").unwrap();
    fs::write(root.join("other.md"), "other").unwrap();
    fs::remove_file(root.join("gone.md")).unwrap();
    let added = |path: &'static str| move |e: &VaultEvent| matches!(e, VaultEvent::Added { path: p, .. } if p == path);
    let removed =
        |e: &VaultEvent| matches!(e, VaultEvent::Removed { note_id, .. } if note_id == "n1");
    wait_for(&log, "the live reports", |l| {
        l.iter().any(added("new.md")) && l.iter().any(added("other.md")) && l.iter().any(removed)
    });

    watcher.handle().forget("new.md".into());
    wait_for(&log, "new.md again", |l| {
        l.iter().filter(|e| added("new.md")(e)).count() == 2
    });
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(
        count(&log, added("other.md")),
        1,
        "a forget reported another path"
    );
    assert_eq!(count(&log, removed), 1);

    watcher.handle().resync();
    wait_for(&log, "the resync", |l| {
        l.iter().filter(|e| added("other.md")(e)).count() == 2
            && l.iter().filter(|e| removed(e)).count() == 2
    });
    watcher.stop_and_drop();
}

/// When nothing adopts new files, a rescan reads a file no row names only when it can be a
/// moved note (its size is that of a missing one), and reports none of the others: a resync
/// after a flood of such files costs no read and no report of them.
#[test]
fn a_rescan_that_adopts_nothing_looks_only_at_files_a_moved_note_can_be() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    let body = "a note that moved";
    fs::write(root.join("moved.md"), body).unwrap();
    for n in 0..5 {
        fs::write(root.join(format!("u{n}.md")), "x".repeat(40 + n)).unwrap();
    }
    vault
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: "n1".into(),
            path: "old.md".into(),
            file_type: "markdown".into(),
            mime_type: None,
            file_size: Some(body.len() as i64),
            content_hash: Some(content_hash(body)),
            indexed_at: i64::MAX,
        })
        .unwrap();
    let log = Log::default();
    let watcher = VaultWatcher::start(
        root.clone(),
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink(&log),
        NewFiles::PairOnly,
    )
    .unwrap();
    let renamed = |e: &VaultEvent| matches!(e, VaultEvent::Renamed { new_path, .. } if new_path == "moved.md");
    let rescanned = |e: &VaultEvent| matches!(e, VaultEvent::Rescanned { .. });
    wait_for(&log, "the start pass", |l| l.iter().any(rescanned));
    // The consumer applied nothing, so the resync finds the move again.
    watcher.handle().resync();
    wait_for(&log, "the resync", |l| {
        l.iter().filter(|e| rescanned(e)).count() == 2
    });
    watcher.stop_and_drop();
    assert_eq!(count(&log, renamed), 2, "{:?}", log.lock().unwrap());
    assert_eq!(
        count(&log, |e| matches!(e, VaultEvent::Added { .. })),
        0,
        "{:?}",
        log.lock().unwrap()
    );
}

/// A note edited and then moved while nothing applied the edit: its row still has the old size,
/// the report has the new one. A rescan that adopts nothing still reads the moved file, since
/// its size is the one last reported, and pairs it.
#[test]
fn a_rescan_that_adopts_nothing_finds_a_note_edited_then_moved() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    fs::write(root.join("a.md"), "base").unwrap();
    vault
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: "n1".into(),
            path: "a.md".into(),
            file_type: "markdown".into(),
            mime_type: None,
            file_size: Some(4),
            content_hash: Some(content_hash("base")),
            indexed_at: i64::MAX,
        })
        .unwrap();
    let log = Log::default();
    let mut r = Reconciler::new(
        root.clone(),
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink(&log),
    )
    .with_new_files(NewFiles::PairOnly);
    fs::write(root.join("a.md"), "edited, and longer than it was").unwrap();
    r.batch(vec!["a.md".into()], Instant::now());
    assert_eq!(
        count(&log, |e| matches!(e, VaultEvent::Changed { .. })),
        1,
        "{:?}",
        log.lock().unwrap()
    );
    fs::rename(root.join("a.md"), root.join("moved.md")).unwrap();
    let stop = AtomicBool::new(false);
    r.rescan(true, Instant::now(), &stop).unwrap();
    r.settle_expired(Instant::now() + Duration::from_secs(2));
    let events = log.lock().unwrap().clone();
    assert!(
        events.iter().any(|e| matches!(
            e,
            VaultEvent::Renamed { note_id, new_path, .. } if note_id == "n1" && new_path == "moved.md"
        )),
        "{events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, VaultEvent::Removed { .. })),
        "{events:?}"
    );
}
