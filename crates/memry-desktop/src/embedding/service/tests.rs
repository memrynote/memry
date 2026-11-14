//! The bridge's rules (embeddings.ts) on a fake model: no download, no ONNX Runtime.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Receiver;

use super::*;
use crate::registry::{AppConfig, VaultRegistry};
use crate::session::OpenSource;
use crate::shell::shutdown::{Deadline, ShutdownContext, ShutdownReason};

/// A hang guard, never a bound on how fast the code is.
const HANG: Duration = Duration::from_secs(60);

/// A point a fake model waits at until the test lets it go, telling the test it got there.
struct Gate {
    reached: Mutex<mpsc::Sender<()>>,
    open: Mutex<bool>,
    opened: Condvar,
}

impl Gate {
    fn new() -> (Arc<Self>, Receiver<()>) {
        let (tx, rx) = mpsc::channel();
        let gate = Arc::new(Self {
            reached: Mutex::new(tx),
            open: Mutex::new(false),
            opened: Condvar::new(),
        });
        (gate, rx)
    }

    fn wait(&self) {
        let _ = lock(&self.reached).send(());
        let mut open = lock(&self.open);
        while !*open {
            open = self.opened.wait(open).unwrap();
        }
    }

    fn release(&self) {
        *lock(&self.open) = true;
        self.opened.notify_all();
    }
}

enum Step {
    Vector,
    Fail(&'static str),
    Panic,
    Block(Arc<Gate>),
    /// Waits for the request's abort, as a download does.
    AwaitAbort(Arc<Gate>),
}

#[derive(Default)]
struct Script {
    loads: Mutex<VecDeque<Step>>,
    embeds: Mutex<VecDeque<Step>>,
    load_calls: AtomicUsize,
    dropped: AtomicUsize,
    cancelled: AtomicUsize,
}

impl Script {
    fn play(&self, queue: &Mutex<VecDeque<Step>>, abort: Option<&Abort>) -> Result<(), String> {
        let step = lock(queue).pop_front().unwrap_or(Step::Vector);
        match step {
            Step::Vector => Ok(()),
            Step::Fail(message) => Err(message.to_owned()),
            Step::Panic => panic!("onnx runtime fault"),
            Step::Block(gate) => {
                gate.wait();
                Ok(())
            }
            Step::AwaitAbort(gate) => {
                let _ = lock(&gate.reached).send(());
                let abort = abort.expect("loads only");
                while !abort.cancel.is_cancelled() {
                    std::thread::sleep(Duration::from_millis(5));
                }
                self.cancelled.fetch_add(1, Ordering::SeqCst);
                Err("the model download was cancelled".to_owned())
            }
        }
    }
}

struct FakeEngine(Arc<Script>);

impl Engine for FakeEngine {
    fn embed_text(&mut self, _: &str) -> Result<Vec<f32>, String> {
        self.0.play(&self.0.embeds, None)?;
        Ok(vec![0.5; EMBEDDING_DIMENSION])
    }
}

impl Drop for FakeEngine {
    fn drop(&mut self) {
        self.0.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

struct FakeLoader(Arc<Script>);

impl ModelLoader for FakeLoader {
    fn load(
        &self,
        abort: &Abort,
        progress: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<Box<dyn Engine>, String> {
        self.0.load_calls.fetch_add(1, Ordering::SeqCst);
        progress(ModelProgress::new(
            Phase::Downloading,
            50,
            "Downloading model: 50%",
        ));
        self.0.play(&self.0.loads, Some(abort))?;
        Ok(Box::new(FakeEngine(self.0.clone())))
    }
}

struct Case {
    service: Arc<EmbeddingService>,
    script: Arc<Script>,
    events: Arc<Mutex<Vec<ModelProgress>>>,
}

const TEXT: &str = "a note long enough to embed";

fn case(timing: Timing) -> Case {
    let script = Arc::new(Script::default());
    let events: Arc<Mutex<Vec<ModelProgress>>> = Arc::default();
    let sink = events.clone();
    let service = EmbeddingService::new(
        Arc::new(FakeLoader(script.clone())),
        Arc::new(move |event| lock(&sink).push(event)),
        timing,
    );
    Case {
        service,
        script,
        events,
    }
}

/// Requests outlive the hang guard, so a missing stop fails the test instead of timing out.
fn long_deadline() -> Timing {
    Timing {
        request_deadline: HANG * 10,
        ..Timing::default()
    }
}

impl Case {
    fn loads(&self) -> usize {
        self.script.load_calls.load(Ordering::SeqCst)
    }

    fn error(&self) -> String {
        self.service.status().error.unwrap_or_default()
    }
}

/// Runs `f` on its own thread; the answer arrives on the receiver.
fn background<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Receiver<T> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx
}

/// Runs `f` on its own thread and fails the test if it does not return.
fn returns<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    background(f).recv_timeout(HANG).expect("the call hung")
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(start.elapsed() < HANG, "{what} never happened");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn the_first_embed_loads_the_model_and_reports_each_phase() {
    let c = case(long_deadline());
    assert_eq!(c.service.embed(TEXT), Some(vec![0.5; EMBEDDING_DIMENSION]));
    assert_eq!(
        c.service.embed(TEXT).map(|v| v.len()),
        Some(EMBEDDING_DIMENSION)
    );
    assert_eq!(c.loads(), 1);
    let status = c.service.status();
    assert!(status.loaded && !status.loading && status.error.is_none());
    assert_eq!(
        *lock(&c.events),
        [
            ModelProgress::new(Phase::Loading, 0, "Initializing model..."),
            ModelProgress::new(Phase::Downloading, 50, "Downloading model: 50%"),
            ModelProgress::new(Phase::Ready, 100, "Model ready"),
        ]
    );
}

#[test]
fn text_under_ten_units_after_a_js_trim_never_loads_the_model() {
    let c = case(long_deadline());
    assert_eq!(c.service.embed("\u{feff}  123456789 \n"), None);
    assert_eq!(c.loads(), 0);
}

/// embeddings.ts:246-262: a failed load surfaces as the error event and the status error, and
/// the next load inside the backoff never reaches the model, until AI is enabled again.
#[test]
fn a_failed_load_backs_off_until_the_failure_is_reset() {
    let c = case(long_deadline());
    lock(&c.script.loads).push_back(Step::Fail("offline"));
    assert!(!c.service.load());
    assert_eq!(c.error(), "offline");
    assert_eq!(
        lock(&c.events).last(),
        Some(&ModelProgress::new(Phase::Error, 0, "Error: offline"))
    );

    assert!(!c.service.load());
    assert_eq!(c.service.embed(TEXT), None);
    assert_eq!(c.loads(), 1);

    c.service.reset_failure();
    assert!(c.service.load());
    assert_eq!(c.loads(), 2);
    assert!(c.service.status().error.is_none());
}

#[test]
fn a_panic_in_inference_is_caught_and_the_model_is_loaded_again() {
    let c = case(long_deadline());
    assert!(c.service.load());
    lock(&c.script.embeds).push_back(Step::Panic);

    assert_eq!(
        returns({
            let service = c.service.clone();
            move || service.embed(TEXT)
        }),
        None
    );
    assert!(c.error().contains("onnx runtime fault"), "{}", c.error());
    assert!(!c.service.status().loaded);
    assert_eq!(c.script.dropped.load(Ordering::SeqCst), 1);

    // The crash feeds the backoff (embeddings.ts:308-316); enabling AI again clears it.
    assert_eq!(c.service.embed(TEXT), None);
    c.service.reset_failure();
    assert!(c.service.embed(TEXT).is_some());
    assert_eq!(c.loads(), 2);
}

#[test]
fn a_panic_while_loading_is_caught_as_a_load_failure() {
    let c = case(long_deadline());
    lock(&c.script.loads).push_back(Step::Panic);
    assert!(!returns({
        let service = c.service.clone();
        move || service.load()
    }));
    assert!(c.error().contains("panicked"), "{}", c.error());
    assert!(!c.service.load(), "backing off");
}

/// `REQUEST_TIMEOUT_MS` (embeddings.ts:805-811): the caller gets its answer at the deadline, the
/// failure feeds the backoff, and the stuck thread is let go.
#[test]
fn a_request_past_its_deadline_fails_and_lets_the_stuck_thread_go() {
    let c = case(Timing {
        request_deadline: Duration::from_millis(200),
        ..Timing::default()
    });
    assert!(c.service.load());
    let (gate, reached) = Gate::new();
    lock(&c.script.embeds).push_back(Step::Block(gate.clone()));

    assert_eq!(
        returns({
            let service = c.service.clone();
            move || service.embed(TEXT)
        }),
        None
    );
    reached.recv_timeout(HANG).expect("the inference started");
    assert_eq!(c.error(), "Embedding request timed out");
    assert!(!c.service.status().loaded);
    assert!(!c.service.load(), "backing off");

    gate.release();
    until("the stuck thread dropping its model", || {
        c.script.dropped.load(Ordering::SeqCst) == 1
    });
}

#[test]
fn stopping_ends_a_waiting_load_and_cancels_its_download() {
    let c = case(long_deadline());
    let (gate, reached) = Gate::new();
    lock(&c.script.loads).push_back(Step::AwaitAbort(gate));
    let service = c.service.clone();
    let load = background(move || service.load());
    reached.recv_timeout(HANG).expect("the download started");

    c.service.stop();
    assert!(!load.recv_timeout(HANG).expect("the load hung"));
    until("the download seeing the cancel", || {
        c.script.cancelled.load(Ordering::SeqCst) == 1
    });
    // A stop is not a failure: the next load goes ahead.
    assert!(c.service.load());
}

#[test]
fn closing_the_vault_cancels_the_download() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    std::fs::create_dir_all(dir.path().join("vault")).unwrap();
    let config = AppConfig::load(dir.path().join("app").join("memry-config.json"));
    let session = Session::new(VaultRegistry::new(Arc::new(config)));
    session
        .open(&dir.path().join("vault"), OpenSource::Select)
        .unwrap();
    let c = case(long_deadline());
    c.service.register(&session);
    let (gate, reached) = Gate::new();
    lock(&c.script.loads).push_back(Step::AwaitAbort(gate));
    let service = c.service.clone();
    let load = background(move || service.load());
    reached.recv_timeout(HANG).expect("the download started");

    session.close();
    assert!(!load.recv_timeout(HANG).expect("the load hung"));
    until("the download seeing the cancel", || {
        c.script.cancelled.load(Ordering::SeqCst) == 1
    });
}

/// `IDLE_SHUTDOWN_MS` (embeddings.ts:846-856): the model is dropped after the idle time and the
/// next request loads it again.
#[test]
fn an_idle_model_is_dropped_and_loaded_again_on_the_next_request() {
    let c = case(Timing {
        idle_unload: Duration::from_millis(50),
        ..long_deadline()
    });
    assert!(c.service.embed(TEXT).is_some());
    until("the idle unload", || {
        c.script.dropped.load(Ordering::SeqCst) == 1
    });
    assert!(!c.service.status().loaded);
    assert!(c.service.embed(TEXT).is_some());
    assert_eq!(c.loads(), 2);
}

#[test]
fn the_quit_step_waits_for_the_running_inference_to_finish() {
    let c = case(long_deadline());
    assert!(c.service.load());
    let (gate, reached) = Gate::new();
    lock(&c.script.embeds).push_back(Step::Block(gate.clone()));
    let service = c.service.clone();
    let embed = std::thread::spawn(move || service.embed(TEXT));
    reached.recv_timeout(HANG).expect("the inference started");

    let step = c.service.shutdown_step();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let context = ShutdownContext {
        installing_update: false,
        reason: ShutdownReason::Quit,
    };
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        gate.release();
    });
    runtime
        .block_on(step(context, Deadline::after(HANG)))
        .unwrap();
    assert_eq!(
        c.script.dropped.load(Ordering::SeqCst),
        1,
        "the thread finished"
    );
    assert_eq!(embed.join().unwrap(), None, "stopped before it answered");
    releaser.join().unwrap();
}
