//! The supervisor against the stub worker (`src/bin/stub.rs`), which hangs, crashes or breaks the
//! frame cap on demand. Time is never asserted from above: a timeout test only checks that the
//! hung child is gone and the next call gets a new one.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use memry_ml_worker::{
    Clock, Limits, MAX_FRAME_LEN, Request, Response, Supervisor, SystemClock, WorkerError,
};

fn stub() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_memry-ml-worker-stub"))
}

fn open(path: &str) -> Request {
    Request::PdfOpen { path: path.into() }
}

fn limits() -> Limits {
    Limits {
        op_timeout: Duration::from_secs(60),
        ..Limits::default()
    }
}

fn supervisor(limits: Limits) -> Supervisor {
    Supervisor::new(stub(), Vec::new(), limits, Arc::new(SystemClock))
}

/// A clock the test moves by hand.
struct FakeClock(Mutex<Instant>);

impl FakeClock {
    fn advance(&self, by: Duration) {
        *self.0.lock().unwrap() += by;
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Instant {
        *self.0.lock().unwrap()
    }
}

fn opened() -> Response {
    Response::PdfOpened {
        doc: 1,
        page_count: 1,
    }
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[test]
fn a_call_starts_the_worker_and_gets_its_answer() {
    let worker = supervisor(limits());
    assert_eq!(worker.pid(), None, "nothing runs before the first call");
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    let pid = worker.pid().expect("running");
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    assert_eq!(worker.pid(), Some(pid), "the same child answers both");
}

#[test]
fn a_hanging_op_is_killed_at_its_timeout_and_the_next_call_restarts() {
    let worker = supervisor(Limits {
        op_timeout: Duration::from_millis(300),
        ..limits()
    });
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    let hung = worker.pid().expect("running");
    assert_eq!(
        worker.call(&open("hang")),
        Err(WorkerError::Timeout { op: "pdf-open" })
    );
    assert_eq!(worker.pid(), None, "the hung child is gone");
    #[cfg(unix)]
    assert!(!alive(hung), "the hung child was killed and reaped");
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    assert_ne!(worker.pid(), Some(hung));
}

#[test]
fn a_crashed_child_fails_its_call_and_is_restarted() {
    let worker = supervisor(limits());
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    let crashed = worker.pid().expect("running");
    assert!(matches!(
        worker.call(&open("crash")),
        Err(WorkerError::Exited(_))
    ));
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    assert_ne!(worker.pid(), Some(crashed), "a new child answers");
}

#[test]
fn a_crash_is_accounted_before_its_call_fails() {
    // The failed call's caller may call again at once; it must never reach the dead child.
    let worker = supervisor(limits());
    for _ in 0..100 {
        assert!(matches!(
            worker.call(&open("exit")),
            Err(WorkerError::Exited(_))
        ));
        assert_eq!(
            worker.pid(),
            None,
            "the crashed child is gone from the state"
        );
        assert_eq!(worker.call(&open("ok")), Ok(opened()));
    }
}

#[cfg(unix)]
#[test]
fn the_call_after_one_that_found_the_child_dead_starts_a_new_child() {
    let worker = supervisor(limits());
    for _ in 0..100 {
        assert_eq!(worker.call(&open("ok")), Ok(opened()));
        let pid = worker.pid().expect("running");
        // SAFETY: kills the child this test started.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) }, 0);
        // Either a new child answers, or the call writes to the dead one and fails.
        let first = worker.call(&open("ok"));
        assert!(
            matches!(first, Ok(_) | Err(WorkerError::Exited(_))),
            "{first:?}"
        );
        assert_eq!(worker.call(&open("ok")), Ok(opened()));
    }
}

#[test]
fn an_oversized_frame_from_the_worker_kills_it() {
    let worker = supervisor(limits());
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    let broken = worker.pid().expect("running");
    let error = worker.call(&open("oversize")).expect_err("over the cap");
    assert!(
        matches!(&error, WorkerError::Protocol(message) if message.contains("cap")),
        "{error:?}"
    );
    #[cfg(unix)]
    {
        // The reader thread reaps it; wait for that, never for less than it takes.
        let deadline = Instant::now() + Duration::from_secs(30);
        while alive(broken) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(broken), "the child that broke the cap was killed");
    }
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    assert_ne!(worker.pid(), Some(broken));
}

#[test]
fn repeated_crashes_pause_the_worker_until_the_cooldown_ends() {
    let clock = Arc::new(FakeClock(Mutex::new(Instant::now())));
    let limits = limits();
    let cooldown = limits.crash_cooldown;
    let worker = Supervisor::new(stub(), Vec::new(), limits, clock.clone());
    for _ in 0..3 {
        assert!(matches!(
            worker.call(&open("crash")),
            Err(WorkerError::Exited(_))
        ));
    }
    assert_eq!(worker.call(&open("ok")), Err(WorkerError::Paused));
    assert_eq!(worker.pid(), None, "a paused worker starts no child");
    clock.advance(cooldown - Duration::from_secs(1));
    assert_eq!(worker.call(&open("ok")), Err(WorkerError::Paused));
    clock.advance(Duration::from_secs(1));
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
}

#[test]
fn an_answer_resets_the_crash_count() {
    let clock = Arc::new(FakeClock(Mutex::new(Instant::now())));
    let worker = Supervisor::new(stub(), Vec::new(), limits(), clock);
    for _ in 0..2 {
        assert!(worker.call(&open("crash")).is_err());
    }
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    for _ in 0..2 {
        assert!(worker.call(&open("crash")).is_err());
    }
    assert_eq!(
        worker.call(&open("ok")),
        Ok(opened()),
        "four crashes, never three in a row"
    );
}

#[test]
fn a_child_that_dies_before_ready_counts_as_a_crash() {
    let clock = Arc::new(FakeClock(Mutex::new(Instant::now())));
    let worker = Supervisor::new(stub(), vec!["--crash-before-ready".into()], limits(), clock);
    for _ in 0..3 {
        assert!(matches!(
            worker.call(&open("ok")),
            Err(WorkerError::Exited(_))
        ));
    }
    assert_eq!(worker.call(&open("ok")), Err(WorkerError::Paused));
}

#[test]
fn an_idle_worker_exits() {
    let worker = supervisor(Limits {
        idle_exit: Duration::from_millis(100),
        ..limits()
    });
    let started = Instant::now();
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    let pid = worker.pid().expect("running");
    let deadline = Instant::now() + Duration::from_secs(30);
    while worker.pid().is_some() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(worker.pid(), None, "the idle worker was shut down");
    assert!(started.elapsed() >= Duration::from_millis(100));
    #[cfg(unix)]
    {
        let deadline = Instant::now() + Duration::from_secs(30);
        while alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(pid), "the idle child exited and was reaped");
    }
    #[cfg(not(unix))]
    let _ = pid;
    assert_eq!(
        worker.call(&open("ok")),
        Ok(opened()),
        "a later call starts it again"
    );
}

#[test]
fn a_busy_worker_is_not_idled_out() {
    let worker = Arc::new(supervisor(Limits {
        idle_exit: Duration::from_millis(50),
        op_timeout: Duration::from_millis(600),
        ..limits()
    }));
    // The hang outlives the idle limit; only the op timeout ends it.
    assert_eq!(
        worker.call(&open("hang")),
        Err(WorkerError::Timeout { op: "pdf-open" })
    );
}

#[test]
fn stop_fails_the_waiting_call() {
    let worker = Arc::new(supervisor(limits()));
    let caller = {
        let worker = worker.clone();
        thread::spawn(move || worker.call(&open("hang")))
    };
    // `pid` takes the lock the call holds while it starts the child and queues the request.
    let deadline = Instant::now() + Duration::from_secs(30);
    while worker.pid().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    worker.stop();
    assert_eq!(caller.join().expect("caller"), Err(WorkerError::Stopped));
    assert_eq!(worker.pid(), None);
}

#[test]
fn a_missing_program_is_a_start_error() {
    let worker = Supervisor::new(
        PathBuf::from("/nonexistent/memry-ml-worker"),
        Vec::new(),
        limits(),
        Arc::new(SystemClock),
    );
    assert!(matches!(
        worker.call(&open("ok")),
        Err(WorkerError::Start(_))
    ));
}

#[test]
fn the_worker_runs_below_normal_priority() {
    let worker = supervisor(limits());
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    let pid = worker.pid().expect("running");
    #[cfg(unix)]
    {
        // SAFETY: plain FFI read of a child's nice value.
        let nice = unsafe { libc::getpriority(libc::PRIO_PROCESS, pid as libc::id_t) };
        assert_eq!(nice, 19);
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetPriorityClass, IDLE_PRIORITY_CLASS, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY: the handle is opened, read and closed here.
        let class = unsafe {
            let handle =
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).expect("open process");
            let class = GetPriorityClass(handle);
            let _ = CloseHandle(handle);
            class
        };
        assert_eq!(class, IDLE_PRIORITY_CLASS.0);
    }
}

#[test]
fn a_handle_from_an_earlier_child_is_not_open_in_the_next_one() {
    // Every child numbers its documents from 1, so without the handle's child in it, the first
    // child's handle would reach the second child's document.
    let worker = supervisor(limits());
    let first = worker
        .open_pdf(Path::new("ok"))
        .expect("open in the first child");
    worker.stop();
    let second = worker
        .open_pdf(Path::new("ok"))
        .expect("open in the second child");
    let pid = worker.pid().expect("running").to_string();
    for outcome in [first.page_text(1).map(drop), first.close()] {
        let error = outcome.expect_err("the first child is gone");
        assert!(error.to_string().contains("not open"), "{error:?}");
    }
    assert_eq!(second.page_text(1), Ok(pid), "the live handle still works");
    second.close().expect("close");
}

#[test]
fn an_open_document_keeps_the_worker_from_idling_out() {
    let clock = Arc::new(FakeClock(Mutex::new(Instant::now())));
    let worker = Supervisor::new(
        stub(),
        Vec::new(),
        Limits {
            idle_exit: Duration::from_millis(20),
            ..limits()
        },
        clock.clone(),
    );
    let doc = worker.open_pdf(Path::new("ok")).expect("open");
    let pid = worker.pid().expect("running");
    clock.advance(Duration::from_secs(3600));
    // Many idle ticks pass on the real clock; the open document keeps the child.
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        worker.pid(),
        Some(pid),
        "no idle exit while a document is open"
    );
    assert_eq!(doc.page_text(1), Ok(pid.to_string()));
    doc.close().expect("close");
    clock.advance(Duration::from_secs(3600));
    let deadline = Instant::now() + Duration::from_secs(30);
    while worker.pid().is_some() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(worker.pid(), None, "closed and idle, the child exits");
}

#[test]
fn a_large_request_behind_a_hung_op_runs_on_the_next_child() {
    // The hung child reads nothing more, so a request larger than the pipe buffer would block in
    // its write. It waits for its turn instead: the hung op's timeout kills the child, and the
    // large request goes to a new one.
    let dir = tempfile::tempdir().expect("temp dir");
    let signal = dir.path().join("hung");
    let worker = Arc::new(supervisor(Limits {
        op_timeout: Duration::from_secs(2),
        ..limits()
    }));
    let (done, results) = std::sync::mpsc::channel();
    let hung = {
        let (worker, done) = (worker.clone(), done.clone());
        let path = format!("hang:{}", signal.display());
        thread::spawn(move || {
            let _ = done.send(("hung", worker.call(&open(&path))));
        })
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    while !signal.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(signal.exists(), "the child took the hanging op");
    let large = {
        let worker = worker.clone();
        let path = "x".repeat(4 << 20);
        thread::spawn(move || {
            let _ = done.send(("large", worker.call(&open(&path))));
        })
    };
    let mut outcomes = std::collections::HashMap::new();
    for _ in 0..2 {
        // timing-bound: a watchdog against a deadlock, far past the 2 s op timeout.
        let (name, outcome) = results
            .recv_timeout(Duration::from_secs(60))
            .expect("both calls end; the timeout kill is not blocked by the large write");
        outcomes.insert(name, outcome);
    }
    hung.join().expect("hung caller");
    large.join().expect("large caller");
    assert_eq!(
        outcomes["hung"],
        Err(WorkerError::Timeout { op: "pdf-open" })
    );
    assert_eq!(
        outcomes["large"],
        Ok(opened()),
        "not failed with the hung op"
    );
    assert_eq!(
        worker.call(&open("ok")),
        Ok(opened()),
        "a new child answers"
    );
}

#[test]
fn the_worker_gets_only_the_inherited_env_and_the_install_dir_as_cwd() {
    // The app's own environment holds tokens and paths; the child parses untrusted files.
    let worker = supervisor(limits());
    let request = Request::PdfRenderPage {
        doc: 1,
        page: 1,
        max_edge: 1,
    };
    let Ok(Response::Text(report)) = worker.call(&request) else {
        panic!("the stub answers with its environment");
    };
    let (names, cwd) = report.split_once('\t').expect("names, a tab, the cwd");
    let mut names: Vec<_> = names
        .lines()
        .map(|name| {
            if cfg!(windows) {
                name.to_uppercase()
            } else {
                name.to_owned()
            }
        })
        // Windows sets this one itself in a process that runs under emulation (CI, windows-11-arm).
        .filter(|name| !(cfg!(windows) && name == "PROCESSOR_ARCHITECTURE"))
        .collect();
    names.sort();
    // Mirrors `INHERITED_ENV` in `src/supervisor.rs`.
    let expected: &[&str] = if cfg!(windows) { &["SYSTEMROOT"] } else { &[] };
    assert_eq!(
        names, expected,
        "the app's environment did not reach the child"
    );
    assert_eq!(
        Path::new(cwd).canonicalize().expect("cwd exists"),
        stub().parent().unwrap().canonicalize().unwrap(),
        "the child runs in its install dir, not the app's cwd"
    );
}

#[test]
fn a_request_over_the_frame_cap_fails_only_its_call() {
    // Nothing is written for a request the codec refuses, so the child is healthy and the
    // failure is not a crash: with a crash limit of 1 a counted crash would pause the worker.
    let worker = supervisor(Limits {
        crash_limit: 1,
        ..limits()
    });
    assert_eq!(worker.call(&open("ok")), Ok(opened()));
    let pid = worker.pid().expect("running");
    let too_large = "x".repeat(MAX_FRAME_LEN as usize);
    assert!(matches!(
        worker.call(&open(&too_large)),
        Err(WorkerError::Failed(_))
    ));
    assert_eq!(worker.pid(), Some(pid), "the healthy child keeps running");
    assert_eq!(worker.call(&open("ok")), Ok(opened()), "not paused");
    assert_eq!(worker.pid(), Some(pid), "the same child answers");
}

#[test]
fn a_call_queued_behind_a_slow_op_gets_its_own_full_timeout() {
    // The child answers in order, so the second read waits in the child while the first runs.
    // Its timeout counts from when the first one is answered, and the healthy child survives.
    let worker = Arc::new(supervisor(Limits {
        ocr_timeout: Duration::from_secs(3),
        ..limits()
    }));
    let read = |worker: &Supervisor| {
        worker.recognize(Path::new("tessdata"), &["slow:2000".into()], Vec::new())
    };
    assert_eq!(
        read(&worker),
        Ok("read".into()),
        "one read fits the timeout"
    );
    let pid = worker.pid().expect("running");
    let first = {
        let worker = worker.clone();
        thread::spawn(move || read(&worker))
    };
    let second = {
        let worker = worker.clone();
        thread::spawn(move || read(&worker))
    };
    assert_eq!(first.join().expect("first"), Ok("read".into()));
    assert_eq!(second.join().expect("second"), Ok("read".into()));
    assert_eq!(
        worker.pid(),
        Some(pid),
        "the healthy child was never killed"
    );
}

/// Never writes a `Ready` frame.
#[cfg(unix)]
fn silent(limits: Limits, clock: Arc<dyn Clock>) -> Supervisor {
    Supervisor::new("/bin/sleep".into(), vec!["600".into()], limits, clock)
}

#[cfg(unix)]
#[test]
fn a_child_that_never_gets_ready_counts_as_a_crash() {
    let clock = Arc::new(FakeClock(Mutex::new(Instant::now())));
    let worker = silent(
        Limits {
            start_timeout: Duration::from_millis(100),
            ..limits()
        },
        clock,
    );
    for _ in 0..3 {
        let error = worker.call(&open("ok")).expect_err("never ready");
        assert!(matches!(error, WorkerError::Start(_)), "{error:?}");
    }
    assert_eq!(worker.call(&open("ok")), Err(WorkerError::Paused));
}

#[cfg(unix)]
#[test]
fn stop_ends_a_start_that_waits_for_ready() {
    let worker = Arc::new(silent(
        Limits {
            start_timeout: Duration::from_secs(120),
            ..limits()
        },
        Arc::new(SystemClock),
    ));
    let caller = {
        let worker = worker.clone();
        thread::spawn(move || worker.call(&open("ok")))
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    while worker.pid().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let pid = worker.pid().expect("the starting child is in the state");
    worker.stop();
    assert_eq!(caller.join().expect("caller"), Err(WorkerError::Stopped));
    assert!(!alive(pid), "the starting child was killed and reaped");
}

/// Set in the copy of this test binary that plays the app: the file it writes its child's pid to.
#[cfg(unix)]
const APP_PIDFILE: &str = "MEMRY_TEST_APP_PIDFILE";

#[cfg(unix)]
#[test]
fn the_worker_exits_when_the_app_dies() {
    if let Some(pidfile) = std::env::var_os(APP_PIDFILE) {
        // The child must be inside the hung op, not waiting on stdin, whose end at the app's
        // death would end it without the parent watch.
        let marker = std::path::PathBuf::from(&pidfile).with_extension("hung");
        let worker = Arc::new(supervisor(limits()));
        let caller = worker.clone();
        let op = open(&format!("hang:{}", marker.display()));
        thread::spawn(move || caller.call(&op));
        let deadline = Instant::now() + Duration::from_secs(30);
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(marker.exists(), "the child took the hanging op");
        let pid = worker.pid().expect("running");
        std::fs::write(&pidfile, pid.to_string()).expect("write pid");
        loop {
            thread::park();
        }
    }
    let dir = tempfile::tempdir().expect("temp dir");
    let pidfile = dir.path().join("pid");
    let mut app = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args([
            "--exact",
            "the_worker_exits_when_the_app_dies",
            "--nocapture",
        ])
        .env(APP_PIDFILE, &pidfile)
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("start the app");
    let deadline = Instant::now() + Duration::from_secs(60);
    let child = loop {
        let pid = std::fs::read_to_string(&pidfile)
            .ok()
            .and_then(|s| s.parse::<u32>().ok());
        if let Some(pid) = pid {
            break pid;
        }
        // timing-bound: a watchdog against an app that never starts, far past its start.
        assert!(
            Instant::now() < deadline,
            "the app never started its worker"
        );
        thread::sleep(Duration::from_millis(20));
    };
    // The child is inside a hung op, so it never reads the stdin the app's death closes.
    app.kill().expect("kill the app");
    app.wait().expect("reap the app");
    let deadline = Instant::now() + Duration::from_secs(30);
    while alive(child) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    let survived = alive(child);
    if survived {
        // SAFETY: kills the orphan this test caused.
        unsafe { libc::kill(child as libc::pid_t, libc::SIGKILL) };
    }
    assert!(!survived, "the worker outlived the app");
}
