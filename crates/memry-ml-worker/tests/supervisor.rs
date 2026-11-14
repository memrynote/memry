//! The supervisor against the stub worker (`src/bin/stub.rs`), which hangs, crashes or breaks the
//! frame cap on demand. Time is never asserted from above: a timeout test only checks that the
//! hung child is gone and the next call gets a new one.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use memry_ml_worker::{Clock, Limits, Request, Response, Supervisor, SystemClock, WorkerError};

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
