//! The watcher is scoped to one vault session, and every lost-event path ends in a rescan
//! (12d review): the own-write record does not outlive a session, a stopped watcher reports
//! nothing, and an edit no OS event announced is found by the safety-net rescan.

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::storage::OpenOptions;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::watch::reconcile::Reconciler;
use memry_desktop::vault::watch::{
    EchoGuard, EventSink, Tuning, VaultEvent, VaultTier, VaultWatcher,
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
    let tier = VaultTier::new(sink(&Log::default()));
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
    };
    let _watcher = VaultWatcher::start_with(
        root,
        vec![],
        vault.note_files(),
        Arc::new(EchoGuard::default()),
        sink(&log),
        tuning,
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
