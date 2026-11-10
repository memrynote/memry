use std::sync::Mutex;

use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::storage::OpenOptions;

use super::*;
use crate::vault::hash::content_hash;

#[test]
fn a_closed_gate_lets_no_event_through() {
    let seen = Arc::new(Mutex::new(0));
    let counter = seen.clone();
    let gate = Gate::open();
    let sink = gate.wrap(Arc::new(move |_| *counter.lock().unwrap() += 1));
    sink(VaultEvent::Reachable);
    gate.close();
    sink(VaultEvent::Reachable);
    assert_eq!(*seen.lock().unwrap(), 1);
}

/// A backend error is the OS watcher saying it may have lost events and may be blind to
/// part of the vault: a rescan follows, and finds the edit no event announced.
#[test]
fn a_backend_error_ends_in_a_rescan_that_finds_what_no_event_announced() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    std::fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    std::fs::write(root.join("a.md"), "edited behind the watcher's back").unwrap();
    vault
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: "n1".into(),
            path: "a.md".into(),
            file_type: "markdown".into(),
            mime_type: None,
            file_size: Some(4),
            content_hash: Some(content_hash("base")),
            file_hash: Some(content_hash("base")),
            indexed_at: 1,
        })
        .unwrap();
    let log: Arc<Mutex<Vec<VaultEvent>>> = Arc::default();
    let events = log.clone();
    let sink: EventSink = Arc::new(move |event| events.lock().unwrap().push(event));
    let stop = Arc::new(AtomicBool::new(false));
    let reconciler = Reconciler::new(
        root.clone(),
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink.clone(),
    );
    let (tx, rx) = sync_channel(8);
    let mut worker = Worker::new(
        reconciler,
        root,
        sink,
        Tuning::none(),
        (tx.clone(), rx),
        Arc::default(),
        stop.clone(),
    );
    tx.send(Msg::Error(notify::Error::generic("inotify said no")))
        .unwrap();
    let thread = std::thread::spawn(move || worker.work());

    let deadline = Instant::now() + Duration::from_secs(20);
    let changed = |log: &Mutex<Vec<VaultEvent>>| {
        log.lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, VaultEvent::Changed { note_id, .. } if note_id == "n1"))
    };
    while !changed(&log) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    stop.store(true, Ordering::Relaxed);
    thread.join().unwrap();
    let events = log.lock().unwrap().clone();
    assert!(changed(&log), "no rescan after the error: {events:?}");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, VaultEvent::WatchFailed { .. })),
        "the failure is reported too: {events:?}"
    );
}

/// The inotify limit error names every folder it could not watch; the log keeps the kind.
#[test]
fn a_watcher_error_is_logged_without_its_paths() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    std::fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    let log: Arc<Mutex<Vec<VaultEvent>>> = Arc::default();
    let events = log.clone();
    let sink: EventSink = Arc::new(move |event| events.lock().unwrap().push(event));
    let reconciler = Reconciler::new(
        root.clone(),
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink.clone(),
    );
    let (tx, rx) = sync_channel(8);
    let mut worker = Worker::new(
        reconciler,
        root.clone(),
        sink,
        Tuning::none(),
        (tx, rx),
        Arc::default(),
        Arc::default(),
    );
    let error =
        notify::Error::new(notify::ErrorKind::MaxFilesWatch).add_path(root.join("Private diary"));
    let written = Arc::new(Mutex::new(Vec::<u8>::new()));
    let subscriber = tracing_subscriber::fmt()
        .with_writer(Mutex::new(Capture(written.clone())))
        .with_ansi(false)
        .finish();
    tracing::subscriber::with_default(subscriber, || worker.report(&error, Instant::now()));

    let line = String::from_utf8(written.lock().unwrap().clone()).unwrap();
    assert!(line.contains("max_files_watch"), "{line}");
    assert!(
        !line.contains("Private diary"),
        "a path reached the log: {line}"
    );
    assert!(
        log.lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, VaultEvent::WatchFailed { limit: true, .. }))
    );
}

struct Capture(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A re-arm that fails (the folder is momentarily gone, the OS is out of watches) keeps the
/// watch that still works: dropping it first would leave the vault unwatched.
#[test]
fn a_failed_re_arm_keeps_the_old_watch() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    std::fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    let log: Arc<Mutex<Vec<VaultEvent>>> = Arc::default();
    let events = log.clone();
    let sink: EventSink = Arc::new(move |event| events.lock().unwrap().push(event));
    let reconciler = Reconciler::new(
        root.clone(),
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink.clone(),
    );
    let (tx, rx) = sync_channel(8);
    let lost = Arc::<Lost>::default();
    let mut worker = Worker::new(
        reconciler,
        root.clone(),
        sink,
        Tuning::windows(),
        (tx.clone(), rx),
        lost.clone(),
        Arc::default(),
    );
    worker.watcher = Some(watch(&root, &tx, &lost).unwrap());

    worker.root = dir.path().join("not-there");
    worker.rearm(Instant::now());
    assert!(worker.watcher.is_some(), "the old watch was dropped");
    assert!(
        log.lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, VaultEvent::WatchFailed { .. })),
        "the failure is reported"
    );

    worker.root = root.clone();
    worker.rearm(Instant::now());
    assert!(worker.watcher.is_some());
}

type Log = Arc<Mutex<Vec<VaultEvent>>>;

/// A worker on an empty vault under `dir`, and the log of what it reports.
fn worker_on(
    dir: &Path,
    tx: SyncSender<Msg>,
    rx: Receiver<Msg>,
    lost: Arc<Lost>,
) -> (Worker, Log, Vault) {
    let root = dir.join("vault");
    let core = root.join(".memry/core");
    std::fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    let log: Log = Arc::default();
    let events = log.clone();
    let sink: EventSink = Arc::new(move |event| events.lock().unwrap().push(event));
    let reconciler = Reconciler::new(
        root.clone(),
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink.clone(),
    );
    let worker = Worker::new(
        reconciler,
        root,
        sink,
        Tuning::none(),
        (tx, rx),
        lost,
        Arc::default(),
    );
    (worker, log, vault)
}

/// The inotify limit is hit while the channel is full (a flood at the open of a big vault):
/// the notice still reaches the app, it is not lost with the messages that did not fit.
#[test]
fn a_watch_limit_hit_while_the_channel_is_full_is_still_reported() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = sync_channel(1);
    let lost = Arc::<Lost>::default();
    let (mut worker, log, _vault) = worker_on(dir.path(), tx.clone(), rx, lost.clone());
    tx.send(Msg::Rescan).unwrap();
    hit_watch_limit(&worker.root);
    worker.watcher = Some(watch(&worker.root, &tx, &lost).unwrap());
    let stop = worker.stop.clone();
    let thread = std::thread::spawn(move || worker.work());

    let limited = |log: &Log| {
        log.lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, VaultEvent::WatchFailed { limit: true, .. }))
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    while !limited(&log) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    stop.store(true, Ordering::Relaxed);
    thread.join().unwrap();
    assert!(limited(&log), "no limit notice: {:?}", log.lock().unwrap());
}

/// A folder created at the limit fails again each time: the log keeps one line per report, not
/// one per failure.
#[test]
fn a_burst_of_watcher_errors_logs_one_line() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = sync_channel(8);
    let (mut worker, _log, _vault) = worker_on(dir.path(), tx, rx, Arc::default());
    let written = Arc::new(Mutex::new(Vec::<u8>::new()));
    let subscriber = tracing_subscriber::fmt()
        .with_writer(Mutex::new(Capture(written.clone())))
        .with_ansi(false)
        .finish();
    let error = notify::Error::new(notify::ErrorKind::MaxFilesWatch);
    let now = Instant::now();
    tracing::subscriber::with_default(subscriber, || {
        worker.report(&error, now);
        worker.report(&error, now + Duration::from_secs(1));
    });

    let lines = String::from_utf8(written.lock().unwrap().clone()).unwrap();
    assert_eq!(
        lines.matches("the OS watcher reported an error").count(),
        1,
        "{lines}"
    );
}

/// Where inotify's limit counts every watch, the vault's return stops the old watch before it
/// arms the new one: arming first could hit the limit only because both are up. A drop only asks
/// notify's loop to remove the watches, later; at the arm the old watch must already be blind.
#[test]
fn the_vault_return_stops_the_old_watch_before_arming_a_new_one() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = sync_channel(8);
    let lost = Arc::<Lost>::default();
    let (mut worker, _log, _vault) = worker_on(dir.path(), tx, rx, lost.clone());
    worker.stop_before_rewatch = true;
    let (old_tx, old_rx) = sync_channel(CHANNEL_CAPACITY);
    let old = watch(&worker.root, &old_tx, &lost).unwrap();
    let probe = worker.root.join("probe.txt");
    let (seen, seen_by_old) = std::sync::mpsc::channel();
    *old.stop_hold.lock().unwrap() = Some(Box::new(move || {
        while old_rx.try_recv().is_ok() {}
        std::fs::write(&probe, "written after the old watch stopped").unwrap();
        let delivered = old_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        seen.send(delivered).unwrap();
    }));
    worker.watcher = Some(old);

    worker.try_return();

    assert!(
        !seen_by_old.recv_timeout(Duration::from_secs(10)).unwrap(),
        "the old watch still delivered when the new one was armed"
    );
    assert!(worker.watcher.is_some(), "the vault is watched again");
}

/// Another OS error reported in the same tick (or the minute before) does not hide the limit
/// notice: each has its own throttle.
#[test]
fn a_watch_limit_after_another_error_is_still_reported() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = sync_channel(8);
    let lost = Arc::<Lost>::default();
    let (mut worker, log, _vault) = worker_on(dir.path(), tx.clone(), rx, lost.clone());
    tx.send(Msg::Error(notify::Error::generic("inotify said no")))
        .unwrap();
    lost.limit.store(true, Ordering::Relaxed);
    let stop = worker.stop.clone();
    let thread = std::thread::spawn(move || worker.work());

    let limited = |log: &Log| {
        log.lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, VaultEvent::WatchFailed { limit: true, .. }))
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !limited(&log) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    stop.store(true, Ordering::Relaxed);
    thread.join().unwrap();
    let events = log.lock().unwrap().clone();
    assert!(limited(&log), "no limit notice: {events:?}");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, VaultEvent::WatchFailed { limit: false, .. })),
        "the other error is reported too: {events:?}"
    );
}

/// The OS callback turns inotify's limit error into the flag, never into a queued message a full
/// channel could drop.
#[test]
fn the_callback_flags_the_watch_limit_instead_of_queueing_it() {
    let (tx, rx) = sync_channel(8);
    let lost = Lost::default();
    queue_event(
        Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch)),
        &tx,
        &lost,
    );
    assert!(
        lost.limit.load(Ordering::Relaxed),
        "the limit is not flagged"
    );
    assert!(rx.try_recv().is_err(), "the limit was queued");
}

/// A new file's `note_files` lookup that fails when its held add is reported is a storage
/// failure like every other lookup of the watcher: the app is told, and the file is still
/// reported, since only the lookup's cleanup is lost.
#[test]
fn a_failed_lookup_for_a_new_file_is_reported_as_a_storage_failure() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    std::fs::create_dir_all(&core).unwrap();
    let vault =
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
    std::fs::write(root.join("new.md"), "a new file").unwrap();
    let log: Log = Arc::default();
    let events = log.clone();
    let sink: EventSink = Arc::new(move |event| events.lock().unwrap().push(event));
    let mut reconciler = Reconciler::new(
        root,
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink,
    );
    let now = Instant::now();
    reconciler.batch(vec!["new.md".into()], now);
    assert!(log.lock().unwrap().is_empty(), "the add is held");

    vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute_batch("DROP TABLE note_files").unwrap();
            Ok(())
        })
        .unwrap();
    reconciler.batch(vec![], now + Duration::from_secs(1));

    let events = log.lock().unwrap().clone();
    assert!(
        events
            .iter()
            .any(|e| matches!(e, VaultEvent::WatchFailed { limit: false, .. })),
        "the failure is reported: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, VaultEvent::Added { path, .. } if path == "new.md")),
        "the file is reported all the same: {events:?}"
    );
}
