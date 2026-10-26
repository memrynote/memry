use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};

use super::*;

/// A projector that records its calls and can be held inside `project`.
struct Fake {
    name: &'static str,
    background: bool,
    projected: AtomicUsize,
    reconciled: AtomicUsize,
    rebuilt: AtomicUsize,
    entered: Sender<()>,
    gate: Mutex<Receiver<()>>,
    gated: bool,
    reconcile_error: Option<&'static str>,
    reconcile_until_cancelled: bool,
}

struct Handle {
    fake: Arc<Fake>,
    entered: Receiver<()>,
    release: Sender<()>,
}

fn fake(name: &'static str, gated: bool) -> Handle {
    let (entered_tx, entered) = channel();
    let (release, gate) = channel();
    Handle {
        fake: Arc::new(Fake {
            name,
            background: false,
            projected: AtomicUsize::new(0),
            reconciled: AtomicUsize::new(0),
            rebuilt: AtomicUsize::new(0),
            entered: entered_tx,
            gate: Mutex::new(gate),
            gated,
            reconcile_error: None,
            reconcile_until_cancelled: false,
        }),
        entered,
        release,
    }
}

impl Projector for Fake {
    fn name(&self) -> &str {
        self.name
    }
    fn background(&self) -> bool {
        self.background
    }
    fn handles(&self, _: &ProjectionEvent) -> bool {
        true
    }
    fn project(&self, _: &ProjectionEvent) -> Result<(), String> {
        self.projected.fetch_add(1, Ordering::SeqCst);
        if self.gated {
            let _ = self.entered.send(());
            let _ = lock(&self.gate).recv();
        }
        Ok(())
    }
    fn rebuild(&self) -> Result<(), String> {
        self.rebuilt.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn reconcile(&self, cancel: &CancelToken) -> Result<(), String> {
        self.reconciled.fetch_add(1, Ordering::SeqCst);
        while self.reconcile_until_cancelled && !cancel.is_cancelled() {
            std::thread::sleep(Duration::from_millis(2));
        }
        self.reconcile_error.map_or(Ok(()), |e| Err(e.to_owned()))
    }
}

fn task(id: impl ToString) -> ProjectionEvent {
    ProjectionEvent::TaskUpserted {
        task_id: id.to_string(),
    }
}

const SETTLE: Duration = Duration::from_secs(5);

#[test]
fn projection_2001_queued_events_drop_one_count_it_and_reconcile_once() {
    let handle = fake("held", true);
    let runtime =
        ProjectionRuntime::start(vec![handle.fake.clone()], DEFAULT_QUEUE_LIMIT).expect("start");
    runtime.publish(task("first"));
    handle
        .entered
        .recv_timeout(SETTLE)
        .expect("the lane took the first event");
    for n in 0..=DEFAULT_QUEUE_LIMIT {
        runtime.publish(task(n));
    }
    // 2001 distinct events queued behind the held one: the cap kept 2000.
    for _ in 0..=DEFAULT_QUEUE_LIMIT {
        let _ = handle.release.send(());
    }
    assert!(runtime.flush(SETTLE));
    assert_eq!(runtime.dropped("held"), 1);
    assert_eq!(
        handle.fake.reconciled.load(Ordering::SeqCst),
        1,
        "exactly one repair"
    );
    assert_eq!(
        handle.fake.projected.load(Ordering::SeqCst),
        1 + DEFAULT_QUEUE_LIMIT
    );
    assert!(runtime.stop(true).stuck.is_empty());
}

#[test]
fn projection_equal_events_coalesce_to_one_project_call() {
    let handle = fake("held", true);
    let runtime =
        ProjectionRuntime::start(vec![handle.fake.clone()], DEFAULT_QUEUE_LIMIT).expect("start");
    runtime.publish(task("busy"));
    handle.entered.recv_timeout(SETTLE).expect("held");
    runtime.publish(task("same"));
    runtime.publish(task("same"));
    runtime.publish(task("same"));
    for _ in 0..3 {
        let _ = handle.release.send(());
    }
    assert!(runtime.flush(SETTLE));
    assert_eq!(
        handle.fake.projected.load(Ordering::SeqCst),
        2,
        "the held one plus one `same`"
    );
    runtime.stop(true);
}

#[test]
fn projection_a_sleeping_background_lane_does_not_delay_flush() {
    let slow = fake("embedding", true);
    let quick = fake("search", false);
    let mut background = Arc::try_unwrap(slow.fake).ok().expect("sole owner");
    background.background = true;
    let background = Arc::new(background);
    let runtime = ProjectionRuntime::start(
        vec![quick.fake.clone(), background.clone()],
        DEFAULT_QUEUE_LIMIT,
    )
    .expect("start");
    runtime.publish(task("a"));
    slow.entered
        .recv_timeout(SETTLE)
        .expect("the background lane is inside project");
    let started = Instant::now();
    assert!(runtime.flush(Duration::from_secs(2)));
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(quick.fake.projected.load(Ordering::SeqCst), 1);
    let _ = slow.release.send(());
    runtime.stop(true);
    assert_eq!(
        background.projected.load(Ordering::SeqCst),
        1,
        "it still got the event"
    );
}

#[test]
fn projection_stop_returns_within_the_deadline_with_a_stuck_lane() {
    let handle = fake("stuck", true);
    let runtime =
        ProjectionRuntime::start(vec![handle.fake.clone()], DEFAULT_QUEUE_LIMIT).expect("start");
    runtime.publish(task("a"));
    handle.entered.recv_timeout(SETTLE).expect("held");
    runtime.publish(task("queued"));
    let started = Instant::now();
    // The 5 s production deadline is a constant; the test uses a short one so scheduler
    // jitter on a loaded runner cannot decide it.
    assert_eq!(STOP_DRAIN_TIMEOUT, Duration::from_millis(5000));
    let report = runtime.stop_within(true, Duration::from_millis(300));
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(report.stuck, ["stuck"]);
    assert_eq!(runtime.live_threads(), 1);
    // Publishing after stop is refused.
    runtime.publish(task("late"));
    let _ = handle.release.send(());
    let _ = handle.release.send(());
    let end = Instant::now() + SETTLE;
    while runtime.live_threads() > 0 && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        handle.fake.projected.load(Ordering::SeqCst),
        1,
        "the queued event was dropped"
    );
}

#[test]
fn projection_close_during_a_slow_reconcile_cancels_it_and_no_thread_survives() {
    let mut slow = fake("slow", false);
    let inner = Arc::get_mut(&mut slow.fake).expect("sole owner");
    inner.reconcile_until_cancelled = true;
    let runtime =
        ProjectionRuntime::start(vec![slow.fake.clone()], DEFAULT_QUEUE_LIMIT).expect("start");
    runtime.start_reconcile(Arc::new(|_, _| {})).expect("chain");
    let end = Instant::now() + SETTLE;
    while slow.fake.reconciled.load(Ordering::SeqCst) == 0 && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(
        slow.fake.reconciled.load(Ordering::SeqCst),
        1,
        "the pass is running"
    );
    let started = Instant::now();
    let report = runtime.stop(false);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(report.stuck.is_empty());
    assert_eq!(runtime.live_threads(), 0);
}

#[test]
fn projection_a_failed_reconcile_is_reported_and_rebuilt_once_without_stopping_the_pass() {
    let mut bad = fake("bad", false);
    Arc::get_mut(&mut bad.fake)
        .expect("sole owner")
        .reconcile_error = Some("index is broken");
    let good = fake("good", false);
    let runtime = ProjectionRuntime::start(
        vec![bad.fake.clone(), good.fake.clone()],
        DEFAULT_QUEUE_LIMIT,
    )
    .expect("start");
    let (tx, rx) = channel();
    runtime
        .start_reconcile(Arc::new(move |name, error| {
            let _ = tx.send((name.to_owned(), error.to_owned()));
        }))
        .expect("chain");
    assert_eq!(
        rx.recv_timeout(SETTLE).expect("reported"),
        ("bad".to_owned(), "index is broken".to_owned())
    );
    runtime.stop(false);
    assert_eq!(bad.fake.rebuilt.load(Ordering::SeqCst), 1);
    assert_eq!(
        good.fake.reconciled.load(Ordering::SeqCst),
        1,
        "the next projector still ran"
    );
}

/// Records the highest number of calls inside the projector at once.
struct Exclusive {
    inside: AtomicUsize,
    peak: AtomicUsize,
}

impl Exclusive {
    fn enter(&self) {
        let now = self.inside.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(20));
        self.inside.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Projector for Exclusive {
    fn name(&self) -> &str {
        "exclusive"
    }
    fn handles(&self, _: &ProjectionEvent) -> bool {
        true
    }
    fn project(&self, _: &ProjectionEvent) -> Result<(), String> {
        self.enter();
        Ok(())
    }
    fn rebuild(&self) -> Result<(), String> {
        self.enter();
        Ok(())
    }
    fn reconcile(&self, _: &CancelToken) -> Result<(), String> {
        self.enter();
        Err("force a rebuild too".into())
    }
}

#[test]
fn projection_project_reconcile_and_rebuild_never_overlap_on_one_projector() {
    let probe = Arc::new(Exclusive {
        inside: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
    });
    let runtime =
        ProjectionRuntime::start(vec![probe.clone()], DEFAULT_QUEUE_LIMIT).expect("start");
    for n in 0..10 {
        runtime.publish(task(n));
    }
    runtime.start_reconcile(Arc::new(|_, _| {})).expect("chain");
    assert!(runtime.flush(SETTLE));
    runtime.stop(true);
    assert_eq!(probe.peak.load(Ordering::SeqCst), 1);
}
