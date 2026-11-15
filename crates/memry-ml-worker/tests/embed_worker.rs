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

/// Every window of a recording on the stub, which opens any path as three windows. The samples
/// stay in the worker; only the window count and one embedding per window cross the pipe.
fn embed_recording(worker: &Supervisor, path: &str) -> Result<Vec<Vec<f32>>, WorkerError> {
    let recording = worker.open_audio(std::path::Path::new(path))?;
    let mut vectors = Vec::new();
    for window in 0..recording.windows() {
        vectors.push(worker.embed_audio_window(&recording, window)?);
    }
    worker.close_audio(recording)?;
    Ok(vectors)
}

/// A voice memo's name is the user's: the refusal of a path that is not UTF-8 names no path.
#[cfg(unix)]
#[test]
fn a_path_that_is_not_utf8_is_refused_without_naming_it() {
    use std::os::unix::ffi::OsStrExt;
    let (worker, _) = supervisor(Vec::new());
    let path = std::path::Path::new(std::ffi::OsStr::from_bytes(b"/memo-\xff-private.wav"));
    match worker.open_audio(path) {
        Err(WorkerError::Failed(message)) => {
            assert!(!message.contains("private"), "{message}")
        }
        other => panic!("{:?}", other.map(|recording| recording.windows())),
    }
}

#[test]
fn a_recording_is_embedded_window_by_window_in_one_child() {
    let (worker, exits) = supervisor(Vec::new());
    let vectors = embed_recording(&worker, "memo.wav").expect("embedded");
    let pid = worker.pid().expect("running") as f32;
    assert_eq!(vectors, vec![vec![pid; EMBEDDING_DIMENSION]; 3]);
    let short = worker
        .open_audio(std::path::Path::new("short.wav"))
        .expect("opened");
    assert_eq!(short.windows(), 0, "a recording under one second has none");
    worker.close_audio(short).expect("closed");
    assert!(exits.lock().unwrap().is_empty());
}

/// A native crash on any window (an audio encoder fault on a hostile file) fails the recording,
/// so no partial set is stored, and reaches the exit observer; the next recording gets a new
/// child. The open and the windows before it succeed, which resets the supervisor's crash count:
/// the app's breaker counts each such recording (`memry-desktop/tests/embedding_worker.rs`).
#[test]
fn a_crash_on_an_audio_window_fails_the_recording_and_the_next_gets_a_new_child() {
    let (worker, exits) = supervisor(Vec::new());
    let mut killed = Vec::new();
    for _ in 0..3 {
        let recording = worker
            .open_audio(std::path::Path::new("crash.wav"))
            .expect("opened");
        killed.push(worker.pid().expect("running"));
        worker
            .embed_audio_window(&recording, 0)
            .expect("the first window");
        assert!(matches!(
            worker.embed_audio_window(&recording, 1),
            Err(WorkerError::Exited(_))
        ));
    }
    assert_eq!(
        embed_recording(&worker, "memo.wav").expect("served").len(),
        3
    );
    assert!(!killed.contains(&worker.pid().expect("running")));
    let seen = exits_after(&exits, 3);
    assert_eq!(
        seen.iter().map(|(phase, _)| *phase).collect::<Vec<_>>(),
        [ExitPhase::InFlight; 3]
    );
}

/// A window that never returns is killed at the op timeout; the next recording gets a new child,
/// and a window of the old child's recording is refused rather than sent to the new one.
#[test]
fn a_hung_audio_window_is_killed_at_the_op_timeout() {
    let worker = Supervisor::new(
        PathBuf::from(env!("CARGO_BIN_EXE_memry-ml-worker-stub")),
        Vec::new(),
        Limits {
            op_timeout: Duration::from_millis(500),
            ..Limits::default()
        },
        Arc::new(SystemClock),
    );
    let hung = worker
        .open_audio(std::path::Path::new("hang.wav"))
        .expect("opened");
    let killed = worker.pid().expect("running");
    assert!(matches!(
        worker.embed_audio_window(&hung, 1),
        Err(WorkerError::Timeout { .. })
    ));
    assert!(matches!(
        worker.embed_audio_window(&hung, 0),
        Err(WorkerError::NotOpen)
    ));
    assert_eq!(
        embed_recording(&worker, "memo.wav")
            .expect("a new child")
            .len(),
        3
    );
    assert_ne!(worker.pid(), Some(killed));
}

#[test]
fn an_audio_embedding_with_a_value_that_is_not_finite_is_refused() {
    let (worker, _) = supervisor(Vec::new());
    assert!(matches!(
        embed_recording(&worker, "nan.wav"),
        Err(WorkerError::Protocol(_))
    ));
}
