use std::sync::mpsc::channel;

use super::fixture::*;

#[test]
fn switch_a_second_switch_is_refused_while_one_runs() {
    let f = fixture();
    let (entered_tx, entered) = channel();
    let (release_tx, release_rx) = channel::<()>();
    let release_rx = Mutex::new(release_rx);
    let first = f.vault("first");
    let slow = f.vault("slow");
    f.session
        .open(&first, OpenSource::Select)
        .expect("open first");
    let slow_path = slow.clone();
    let entered_tx = Mutex::new(entered_tx);
    f.session.on_open(
        "hold",
        OpenStage::Settings,
        Arc::new(move |view| {
            if view.path == slow_path {
                let _ = lock(&entered_tx).send(());
                let _ = lock(&release_rx).recv();
            }
            Ok(())
        }),
    );
    let session = f.session.clone();
    let switching = std::thread::spawn(move || session.switch(&slow));
    entered
        .recv_timeout(Duration::from_secs(10))
        .expect("the switch is running");
    assert!(f.session.is_switching());
    assert!(matches!(
        f.session.switch(&first),
        Err(SessionError::SwitchInProgress)
    ));
    assert_eq!(
        SessionError::SwitchInProgress.to_string(),
        "A vault switch is already in progress"
    );
    release_tx.send(()).expect("release");
    switching
        .join()
        .expect("join")
        .expect("the first switch finished");
    assert!(!f.session.is_switching());
}

#[test]
fn switch_emits_no_closed_status_when_it_succeeds() {
    let f = fixture();
    f.session
        .open(&f.vault("a"), OpenSource::Select)
        .expect("a");
    let rx = f.session.subscribe();
    f.session.switch(&f.vault("b")).expect("switch");
    let seen = statuses(&drain(&rx));
    assert_eq!(seen.len(), 1);
    assert!(seen[0].is_open);
}

#[test]
fn switch_emits_exactly_one_closed_status_when_it_fails_with_no_vault_left() {
    let f = fixture();
    f.session
        .open(&f.vault("a"), OpenSource::Select)
        .expect("a");
    // An Electron-shaped database where the core's belongs: it fails after the old vault closed.
    let target = f.vault("b");
    std::fs::create_dir_all(target.join(".memry/core")).expect("core dir");
    rusqlite::Connection::open(target.join(".memry/core/data.db"))
        .expect("db")
        .execute_batch("CREATE TABLE __drizzle_migrations (id INTEGER)")
        .expect("seed");
    let rx = f.session.subscribe();
    let result = f.session.switch(&target);
    assert!(matches!(
        result,
        Err(SessionError::Storage(StorageError::ForeignSchema { .. }))
    ));
    let seen = statuses(&drain(&rx));
    assert_eq!(seen.len(), 1);
    assert!(!seen[0].is_open && seen[0].error.is_some());
    assert!(!f.session.status().is_open);
}

#[test]
fn switch_to_a_folder_that_is_gone_leaves_the_open_vault_open() {
    let f = fixture();
    let vault = f.vault("v");
    f.session.open(&vault, OpenSource::Select).expect("open");
    let rx = f.session.subscribe();
    let missing = f.dir.path().join("not-there");

    assert!(matches!(
        f.session.switch(&missing),
        Err(SessionError::Invalid(_))
    ));
    assert!(matches!(
        f.session.replace(&missing, OpenSource::Select),
        Err(SessionError::Invalid(_))
    ));

    let status = f.session.status();
    assert!(status.is_open, "the vault the user works in stays open");
    assert_eq!(status.path.as_deref(), Some(&*vault.to_string_lossy()));
    let reported = statuses(&drain(&rx));
    assert!(
        reported.iter().all(|s| s.is_open && s.error.is_some()),
        "the failure is reported without a closed status: {reported:?}"
    );
}
