//! The order the row lane is taken in (`rows::RowOwner::lane`): first come, first served.
//!
//! `std::sync::Mutex` does not hand itself to a waiter. A thread that unlocks and locks again
//! at once, as the consumer does between two facts or two files, takes it back ahead of a
//! thread already waiting: Windows' SRW locks do, and so do macOS's and Linux's. An app save
//! waiting for the lane could then wait out a whole open walk (#3530). Each taker draws a
//! ticket, without a lock so no one cuts in before the draw, and waits for its number.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, PoisonError};

#[derive(Default)]
pub(super) struct Line {
    next: AtomicU64,
    serving: Mutex<u64>,
    served: Condvar,
}

impl Line {
    /// Waits for every taker that asked before this one to be done.
    pub(super) fn wait(&self) -> Turn<'_> {
        let ticket = self.next.fetch_add(1, Ordering::Relaxed);
        let mut serving = self.serving.lock().unwrap_or_else(PoisonError::into_inner);
        while *serving != ticket {
            serving = self
                .served
                .wait(serving)
                .unwrap_or_else(PoisonError::into_inner);
        }
        Turn(self)
    }
}

/// A taker's turn; the next ticket's starts when it is dropped, on a panic too.
pub(super) struct Turn<'a>(&'a Line);

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        *self
            .0
            .serving
            .lock()
            .unwrap_or_else(PoisonError::into_inner) += 1;
        self.0.served.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    use super::*;

    /// A holder that lets its turn go and asks again at once comes after a taker already in
    /// line, as the consumer between two files comes after an app save.
    #[test]
    fn a_waiting_taker_goes_before_the_holder_asks_again() {
        let line = Arc::new(Line::default());
        let held = line.wait();
        let served = Arc::new(AtomicBool::new(false));
        let taker = {
            let (line, served) = (line.clone(), served.clone());
            std::thread::spawn(move || {
                let _turn = line.wait();
                served.store(true, Ordering::SeqCst);
            })
        };
        // The taker drew its ticket and waits behind `held`.
        while line.next.load(Ordering::SeqCst) < 2 {
            std::thread::yield_now();
        }
        drop(held);
        let _again = line.wait();
        assert!(served.load(Ordering::SeqCst));
        taker.join().unwrap();
    }
}
