//! The embedding calls over the supervisor, against the stub worker (`src/bin/stub.rs`), which
//! answers an embedding of its own pid and hangs or crashes on demand. A worker that dies fails
//! only the call in flight, the next call gets a new child, and each unexpected exit reaches the
//! exit observer with its phase (Electron's `worker_exit_*`). `tests/embed.rs` runs the real
//! worker on the real model.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use memry_ml_worker::{
    EMBEDDING_DIMENSION, ExitPhase, Limits, MAX_EMBED_IMAGE_BYTES, MAX_EMBED_TEXT_BYTES,
    Supervisor, SystemClock, WorkerError,
};

type Exits = Arc<Mutex<Vec<(ExitPhase, Option<i32>)>>>;

fn supervisor(args: Vec<std::ffi::OsString>) -> (Supervisor, Exits) {
    let exits = Exits::default();
    let seen = exits.clone();
    let worker = Supervisor::new(
        PathBuf::from(env!("CARGO_BIN_EXE_memry-ml-worker-stub")),
        args,
        Limits {
            op_timeout: Duration::from_secs(60),
            ..Limits::default()
        },
        Arc::new(SystemClock),
    )
    .observing_exits(Arc::new(move |phase, code| {
        seen.lock().unwrap().push((phase, code));
    }));
    (worker, exits)
}

fn kill(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: plain FFI call on a child this test's supervisor started.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) }, 0);
    }
    #[cfg(windows)]
    {
        let status = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .status()
            .expect("taskkill");
        assert!(status.success());
    }
}

/// The observer runs after the failed call has its answer, so it is waited for.
fn exits_after(exits: &Exits, count: usize) -> Vec<(ExitPhase, Option<i32>)> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while exits.lock().unwrap().len() < count && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    exits.lock().unwrap().clone()
}

fn waits_for(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !path.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(path.exists(), "the worker reached the op");
}

#[test]
fn a_worker_killed_mid_embed_fails_that_call_and_the_next_one_succeeds() {
    let (worker, exits) = supervisor(Vec::new());
    let worker = Arc::new(worker);
    let dir = tempfile::Builder::new()
        .prefix("memry-embed-kill")
        .tempdir()
        .expect("tempdir");
    let reached = dir.path().join("reached");
    let text = format!("hang:{}", reached.display());
    let in_flight = {
        let worker = worker.clone();
        thread::spawn(move || worker.embed_text(&text))
    };
    waits_for(&reached);
    let killed = worker.pid().expect("running");
    kill(killed);
    assert!(
        matches!(in_flight.join().unwrap(), Err(WorkerError::Exited(_))),
        "the call in flight fails"
    );
    let next = worker
        .embed_text("a note about the sea")
        .expect("the next call");
    let pid = worker.pid().expect("a new child");
    assert_ne!(pid, killed);
    assert_eq!(next, vec![pid as f32; EMBEDDING_DIMENSION]);
    let seen = exits_after(&exits, 1);
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert_eq!(seen[0].0, ExitPhase::InFlight);
    #[cfg(unix)]
    assert_eq!(seen[0].1, Some(-libc::SIGKILL));
}

#[test]
fn a_worker_that_dies_while_idle_reports_idle() {
    let (worker, exits) = supervisor(Vec::new());
    worker.embed_load().expect("load");
    kill(worker.pid().expect("running"));
    let seen = exits_after(&exits, 1);
    assert_eq!(
        seen.iter().map(|(phase, _)| *phase).collect::<Vec<_>>(),
        [ExitPhase::Idle]
    );
    worker.embed_text("still served").expect("a new child");
}

#[test]
fn a_worker_that_dies_before_ready_reports_starting() {
    let (worker, exits) = supervisor(vec!["--crash-before-ready".into()]);
    assert!(matches!(
        worker.embed_text("never served"),
        Err(WorkerError::Exited(_))
    ));
    let seen = exits_after(&exits, 1);
    assert_eq!(
        seen.iter().map(|(phase, _)| *phase).collect::<Vec<_>>(),
        [ExitPhase::Starting]
    );
}

#[test]
fn a_crash_on_an_embed_fails_it_and_counts_toward_the_pause() {
    let (worker, exits) = supervisor(Vec::new());
    for _ in 0..3 {
        assert!(matches!(
            worker.embed_text("crash"),
            Err(WorkerError::Exited(_))
        ));
    }
    assert_eq!(worker.embed_text("paused"), Err(WorkerError::Paused));
    let seen = exits_after(&exits, 3);
    assert!(
        seen.iter().all(|(phase, _)| *phase == ExitPhase::InFlight),
        "{seen:?}"
    );
}

/// A NaN would reach the stored vectors and every similarity computed from them.
#[test]
fn an_embedding_with_a_value_that_is_not_finite_is_refused() {
    let (worker, _) = supervisor(Vec::new());
    assert!(matches!(
        worker.embed_text("nan"),
        Err(WorkerError::Protocol(_))
    ));
}

#[cfg(unix)]
#[test]
fn a_clean_idle_shutdown_reports_nothing() {
    let exits = Exits::default();
    let seen = exits.clone();
    let worker = Supervisor::new(
        PathBuf::from(env!("CARGO_BIN_EXE_memry-ml-worker-stub")),
        Vec::new(),
        Limits {
            idle_exit: Duration::from_millis(100),
            ..Limits::default()
        },
        Arc::new(SystemClock),
    )
    .observing_exits(Arc::new(move |phase, code| {
        seen.lock().unwrap().push((phase, code));
    }));
    worker.embed_load().expect("load");
    let pid = worker.pid().expect("running");
    let deadline = Instant::now() + Duration::from_secs(30);
    // SAFETY: signal 0 only checks that the process exists; a reaped child does not.
    while unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(worker.pid(), None, "the idle worker was shut down");
    assert!(exits.lock().unwrap().is_empty());
}

/// A request over its cap fails before a frame is built, so no child is even started for it.
#[test]
fn an_embed_over_its_cap_fails_without_reaching_the_worker() {
    let (worker, _) = supervisor(Vec::new());
    let long = "a".repeat(MAX_EMBED_TEXT_BYTES + 1);
    assert!(matches!(
        worker.embed_text(&long),
        Err(WorkerError::Failed(_))
    ));
    let image = vec![0u8; MAX_EMBED_IMAGE_BYTES + 1];
    assert!(matches!(
        worker.embed_image(&image, None, None),
        Err(WorkerError::Failed(_))
    ));
    assert!(matches!(
        worker.embed_image(&[1, 2, 3], Some(&long), None),
        Err(WorkerError::Failed(_))
    ));
    assert_eq!(worker.pid(), None);
}
