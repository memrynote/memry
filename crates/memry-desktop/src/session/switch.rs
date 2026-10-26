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
    let rx = f.session.subscribe();
    let result = f.session.switch(&f.dir.path().join("not-a-folder"));
    assert!(matches!(result, Err(SessionError::Invalid(_))));
    let seen = statuses(&drain(&rx));
    assert_eq!(seen.len(), 1);
    assert!(!seen[0].is_open && seen[0].error.is_some());
    assert!(!f.session.status().is_open);
}
