use std::sync::atomic::AtomicUsize;
use std::time::Instant;

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

#[test]
fn a_stuck_call_times_out_and_blocks_new_calls_until_it_returns() {
    let guarded = Guarded::with_timeout(
        Slow {
            delay: Duration::from_millis(600),
            calls: AtomicUsize::new(0),
        },
        Duration::from_millis(100),
    );
    let start = Instant::now();
    assert!(
        matches!(guarded.password("x"), Err(KeySourceError::Failed(m)) if m.contains("timed out"))
    );
    assert!(start.elapsed() < Duration::from_millis(500));
    // The latch is held: the next call fails at once and never reaches the inner source.
    assert!(
        matches!(guarded.password("x"), Err(KeySourceError::Failed(m)) if m.contains("pending"))
    );
    assert_eq!(guarded.inner.calls.load(Ordering::SeqCst), 1);
    // The stuck call returns, the latch lifts, and a call goes through again.
    std::thread::sleep(Duration::from_millis(700));
    assert!(
        matches!(guarded.password("x"), Err(KeySourceError::Failed(m)) if m.contains("timed out"))
    );
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
