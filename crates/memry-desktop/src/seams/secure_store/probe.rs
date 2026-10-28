//! One "is there a keychain at all" probe per process: at most one probe thread at a time, and
//! only a definite answer is kept. A doubt is answered "a keychain may exist" and asked again next
//! time. A kept "none" is safe: the device key moves into the keychain as soon as the keychain
//! answers, whatever the probe said.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

pub enum ProbeState {
    Idle,
    Running(Receiver<Option<bool>>),
    Done(bool),
}

/// `probe` answers `Some(true)` for "no keychain", `Some(false)` for "one exists" and `None` for
/// a doubt. It runs on a thread of its own so a wedged bus cannot hold the caller past
/// `deadline`; a caller that times out leaves it running, and the next caller waits on it.
pub fn absent(state: &Mutex<ProbeState>, deadline: Duration, probe: fn() -> Option<bool>) -> bool {
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
    if let ProbeState::Done(answer) = *state {
        return answer;
    }
    if matches!(*state, ProbeState::Idle) {
        let (done, answer) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("memry-keyring-probe".to_owned())
            .spawn(move || {
                let _ = done.send(probe());
            });
        if spawned.is_err() {
            return false;
        }
        *state = ProbeState::Running(answer);
    }
    let ProbeState::Running(answer) = &*state else {
        return false;
    };
    match answer.recv_timeout(deadline) {
        Ok(Some(absent)) => {
            *state = ProbeState::Done(absent);
            absent
        }
        Ok(None) | Err(RecvTimeoutError::Disconnected) => {
            *state = ProbeState::Idle;
            false
        }
        Err(RecvTimeoutError::Timeout) => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    const LONG: Duration = Duration::from_secs(5);

    #[test]
    fn a_definite_answer_is_kept_and_a_doubt_is_asked_again() {
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        let doubt = Mutex::new(ProbeState::Idle);
        let probe = || {
            RUNS.fetch_add(1, Ordering::SeqCst);
            None
        };
        assert!(!absent(&doubt, LONG, probe));
        assert!(!absent(&doubt, LONG, probe));
        assert_eq!(RUNS.load(Ordering::SeqCst), 2, "a doubt is not kept");

        static DEFINITE: AtomicUsize = AtomicUsize::new(0);
        let none = Mutex::new(ProbeState::Idle);
        let probe = || {
            DEFINITE.fetch_add(1, Ordering::SeqCst);
            Some(true)
        };
        assert!(absent(&none, LONG, probe));
        assert!(absent(&none, LONG, probe));
        assert_eq!(
            DEFINITE.load(Ordering::SeqCst),
            1,
            "a definite answer is kept"
        );
    }

    #[test]
    fn a_probe_that_does_not_answer_in_time_is_waited_on_not_started_again() {
        static STARTS: AtomicUsize = AtomicUsize::new(0);
        let state = Mutex::new(ProbeState::Idle);
        let probe = || {
            STARTS.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(300));
            Some(true)
        };
        assert!(!absent(&state, Duration::from_millis(1), probe));
        assert!(!absent(&state, Duration::from_millis(1), probe));
        assert!(absent(&state, LONG, probe));
        assert_eq!(STARTS.load(Ordering::SeqCst), 1);
    }
}
