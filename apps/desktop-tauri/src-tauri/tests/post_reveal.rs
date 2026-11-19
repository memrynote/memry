//! The post-reveal queue: the delay is a gate the test opens, never a wall-clock wait.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_tauri::post_reveal::PostReveal;
use tokio::sync::oneshot;

/// A deadline for a hang, not a timing assertion.
const HANG: Duration = Duration::from_secs(30);

fn recorder() -> (Sender<&'static str>, Receiver<&'static str>) {
    mpsc::channel()
}

fn record(tx: &Sender<&'static str>, name: &'static str) -> impl FnOnce() + Send + 'static {
    let tx = tx.clone();
    move || tx.send(name).expect("receiver alive")
}

/// Arms the drain behind a gate; sending on the gate ends the delay.
fn arm(queue: &Arc<PostReveal>, shutting_down: bool) -> oneshot::Sender<()> {
    let (open, gate) = oneshot::channel::<()>();
    queue.schedule(
        async move {
            let _ = gate.await;
        },
        move || shutting_down,
    );
    open
}

/// Registers a marker last and waits for it, so every task queued before it has run.
fn drained(queue: &PostReveal, rx: &Receiver<&'static str>) -> Vec<&'static str> {
    let (tx, done) = mpsc::channel();
    queue.register("marker", move || tx.send(()).expect("receiver alive"));
    done.recv_timeout(HANG).expect("the drain ran");
    rx.try_iter().collect()
}

#[test]
fn work_waits_for_the_delay_after_the_reveal_and_runs_once() {
    let queue = Arc::new(PostReveal::default());
    let (tx, rx) = recorder();
    queue.register("ocr-languages", record(&tx, "ocr"));
    let open = arm(&queue, false);
    // Registered after the reveal, inside the delay: still waits for it.
    queue.register("late", record(&tx, "late"));
    assert!(rx.try_recv().is_err(), "nothing runs before the delay ends");

    open.send(()).expect("drain waiting");
    assert_eq!(drained(&queue, &rx), ["ocr", "late"]);

    queue.register("ocr-languages", record(&tx, "ocr again"));
    assert!(rx.try_recv().is_err(), "a started name never runs again");
}

#[test]
fn a_registration_after_the_drain_runs_at_once() {
    let queue = Arc::new(PostReveal::default());
    let (tx, rx) = recorder();
    arm(&queue, false).send(()).expect("drain waiting");
    assert!(drained(&queue, &rx).is_empty());

    queue.register("after", record(&tx, "after"));
    assert_eq!(rx.try_recv(), Ok("after"));
}

#[test]
fn registering_a_queued_name_again_replaces_its_task_in_its_place() {
    let queue = Arc::new(PostReveal::default());
    let (tx, rx) = recorder();
    queue.register("updater", record(&tx, "first"));
    queue.register("ocr-languages", record(&tx, "ocr"));
    queue.register("updater", record(&tx, "second"));
    arm(&queue, false).send(()).expect("drain waiting");
    assert_eq!(drained(&queue, &rx), ["second", "ocr"]);
}

#[test]
fn a_second_reveal_does_not_arm_a_second_drain() {
    let queue = Arc::new(PostReveal::default());
    let (tx, rx) = recorder();
    queue.register("task", record(&tx, "task"));
    let first = arm(&queue, false);
    // Never opened: the repeat call returns before it spawns a waiter on it.
    let _second = arm(&queue, false);
    first.send(()).expect("drain waiting");
    assert_eq!(drained(&queue, &rx), ["task"]);
}

#[test]
fn a_shutdown_inside_the_delay_runs_nothing_now_or_later() {
    let queue = Arc::new(PostReveal::default());
    let ran = Arc::new(Mutex::new(Vec::<&str>::new()));
    let first = ran.clone();
    queue.register("ocr-languages", move || {
        first.lock().expect("lock").push("ocr")
    });
    let (closed_tx, closed) = mpsc::channel();
    queue.schedule(async {}, move || {
        closed_tx.send(()).expect("receiver alive");
        true
    });
    closed
        .recv_timeout(HANG)
        .expect("the drain checked the shutdown");
    let later = ran.clone();
    queue.register("later", move || later.lock().expect("lock").push("later"));
    // The drain task returned after the check; a queue it had drained would have run `later`
    // inside `register`.
    assert!(ran.lock().expect("lock").is_empty());
}

#[test]
fn a_panicking_task_does_not_stop_the_next_one() {
    let queue = Arc::new(PostReveal::default());
    let (tx, rx) = recorder();
    queue.register("boom", || panic!("task failed"));
    queue.register("next", record(&tx, "next"));
    arm(&queue, false).send(()).expect("drain waiting");
    assert_eq!(drained(&queue, &rx), ["next"]);
}

#[test]
fn a_registration_while_a_task_runs_waits_for_the_tasks_queued_before_it() {
    let queue = Arc::new(PostReveal::default());
    let (tx, rx) = recorder();
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel::<()>();
    queue.register("boom", move || {
        entered_tx.send(()).expect("receiver alive");
        let _ = release_rx.recv();
        panic!("task failed");
    });
    queue.register("next", record(&tx, "next"));
    arm(&queue, false).send(()).expect("drain waiting");
    entered.recv_timeout(HANG).expect("the drain started boom");

    // `boom` is still running and `next` still queued: the marker goes behind `next`.
    queue.register("marker", record(&tx, "marker"));
    release.send(()).expect("boom waiting");
    let order: Vec<_> = (0..2)
        .map(|_| rx.recv_timeout(HANG).expect("task ran"))
        .collect();
    assert_eq!(order, ["next", "marker"]);
}

#[test]
fn the_reveal_arms_the_drain_from_a_thread_outside_the_runtime() {
    // `reveal::show` runs on the event loop thread, which has no tokio context: arming the
    // app's queue there must not build the timer on the calling thread.
    memry_tauri::post_reveal::on_window_shown();
}
