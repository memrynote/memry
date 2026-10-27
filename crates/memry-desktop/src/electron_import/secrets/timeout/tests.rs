use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;

use super::*;

struct Slow {
    delay: Duration,
    calls: AtomicUsize,
}

impl ChromiumKeySource for Slow {
    fn password(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(self.delay);
        Ok(Some(Zeroizing::new(b"pw".to_vec())))
    }

    fn windows_key(
        &self,
        _: &ElectronProfile,
    ) -> Result<Option<Zeroizing<[u8; 32]>>, KeySourceError> {
        Ok(None)
    }
}

#[test]
fn a_fast_call_returns_its_value() {
    let guarded = Guarded::new(Slow {
        delay: Duration::ZERO,
        calls: AtomicUsize::new(0),
    });
    assert_eq!(&**guarded.password("x").unwrap().unwrap(), b"pw");
    assert_eq!(&**guarded.password("x").unwrap().unwrap(), b"pw");
}

/// A source whose first call blocks until the test releases it. The test waits on channels, never
/// on the clock, so it holds however late the worker thread starts (on a loaded Windows runner the
/// timeout can fire before the worker reaches the source).
struct Stuck {
    calls: AtomicUsize,
    entered: Mutex<mpsc::Sender<()>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl ChromiumKeySource for Stuck {
    fn password(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.lock().unwrap().send(()).unwrap();
        if call == 0 {
            self.release.lock().unwrap().recv().unwrap();
        }
        Ok(Some(Zeroizing::new(b"pw".to_vec())))
    }

    fn windows_key(
        &self,
        _: &ElectronProfile,
    ) -> Result<Option<Zeroizing<[u8; 32]>>, KeySourceError> {
        Ok(None)
    }
}

#[test]
fn a_stuck_call_times_out_and_blocks_new_calls_until_it_returns() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let guarded = Guarded::with_timeout(
        Stuck {
            calls: AtomicUsize::new(0),
            entered: Mutex::new(entered_tx),
            release: Mutex::new(release_rx),
        },
        Duration::from_millis(10),
    );
    assert!(
        matches!(guarded.password("x"), Err(KeySourceError::Failed(m)) if m.contains("timed out"))
    );
    // The stuck call is inside the source now (the timeout may have fired before it got there).
    entered_rx.recv().unwrap();
    // The latch is held: the next call fails at once and never reaches the inner source.
    assert!(
        matches!(guarded.password("x"), Err(KeySourceError::Failed(m)) if m.contains("pending"))
    );
    assert_eq!(guarded.inner.calls.load(Ordering::SeqCst), 1);
    // The stuck call returns and the latch lifts (just after the source returns): a call is
    // admitted again and reaches the source. It may itself time out if the worker starts late,
    // so what counts is that it was admitted, not what it returned. A bounded number of
    // attempts, not a time budget.
    release_tx.send(()).unwrap();
    let mut admitted = false;
    for _ in 0..10_000_000 {
        match guarded.password("x") {
            Err(KeySourceError::Failed(m)) if m.contains("pending") => std::thread::yield_now(),
            _ => {
                admitted = true;
                break;
            }
        }
    }
    assert!(
        admitted,
        "the latch never lifted after the stuck call returned"
    );
    entered_rx.recv().unwrap();
    assert_eq!(guarded.inner.calls.load(Ordering::SeqCst), 2);
}

struct Panics;

impl ChromiumKeySource for Panics {
    fn password(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
        panic!("keychain exploded");
    }

    fn windows_key(
        &self,
        _: &ElectronProfile,
    ) -> Result<Option<Zeroizing<[u8; 32]>>, KeySourceError> {
        Ok(None)
    }
}

#[test]
fn a_panicking_call_is_reported_as_failed_and_releases_the_latch() {
    let guarded = Guarded::new(Panics);
    for _ in 0..2 {
        // The second call would say "still pending" if the panic had left the latch held.
        assert!(
            matches!(guarded.password("x"), Err(KeySourceError::Failed(m)) if m == "the call panicked")
        );
    }
}

#[test]
fn the_latch_guard_releases_even_when_the_worker_unwinds_outside_catch_unwind() {
    let latch = Arc::new(AtomicBool::new(true));
    let held = Release(Arc::clone(&latch));
    let unwound = std::panic::catch_unwind(AssertUnwindSafe(move || {
        let _held = held;
        panic!("worker died");
    }));
    assert!(unwound.is_err());
    assert!(!latch.load(Ordering::SeqCst));
}
