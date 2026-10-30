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
    let overflow = Arc::<AtomicBool>::default();
    let mut worker = Worker::new(
        reconciler,
        root.clone(),
        sink,
        Tuning::windows(),
        (tx.clone(), rx),
        overflow.clone(),
        Arc::default(),
    );
    worker.watcher = Some(watch(&root, &tx, &overflow).unwrap());

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
