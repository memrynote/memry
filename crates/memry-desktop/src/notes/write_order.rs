//! One write of a note at a time (`writeNoteInOrder`, `vault/note-write.ts`): the app's writes
//! of one note (an update, a delete) run one after the other, in the order they arrived, so
//! the second reads what the first wrote. Writes of different notes do not wait for each
//! other. A note's entry is dropped once no write holds or waits for it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

#[derive(Default)]
pub struct WriteOrder {
    notes: Mutex<HashMap<String, Turn>>,
}

/// A note's turn: the lock its writes take one at a time, and how many writes hold or wait
/// for it. The count changes only under the map's lock, so the last write to leave drops the
/// entry; a handle count read there could still include a write that has left the map's lock
/// but not yet dropped its handle.
#[derive(Default)]
struct Turn {
    lock: Arc<Mutex<()>>,
    writes: usize,
}

impl WriteOrder {
    /// Runs `write` once every earlier write of `note_id` has finished. Blocks: call it off the
    /// async runtime. A write that fails does not stop the next one.
    pub fn run<T>(&self, note_id: &str, write: impl FnOnce() -> T) -> T {
        let lock = {
            let mut notes = self.notes();
            let turn = notes.entry(note_id.to_owned()).or_default();
            turn.writes += 1;
            turn.lock.clone()
        };
        // Counted out however the write ends, a panic included.
        let _leave = Leave {
            order: self,
            note_id,
        };
        let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        write()
    }

    fn notes(&self) -> MutexGuard<'_, HashMap<String, Turn>> {
        self.notes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn leave(&self, note_id: &str) {
        let mut notes = self.notes();
        if let Some(turn) = notes.get_mut(note_id) {
            turn.writes -= 1;
            if turn.writes == 0 {
                notes.remove(note_id);
            }
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.notes().len()
    }

    /// How many writes of `note_id` hold or wait for its turn.
    #[cfg(test)]
    fn writes(&self, note_id: &str) -> usize {
        self.notes().get(note_id).map_or(0, |turn| turn.writes)
    }
}

/// A write's leaving of its note's turn, after its hold of the lock: declared before the hold,
/// so it drops after it.
struct Leave<'a> {
    order: &'a WriteOrder,
    note_id: &'a str,
}

impl Drop for Leave<'_> {
    fn drop(&mut self) {
        self.order.leave(self.note_id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;

    use super::*;

    #[test]
    fn a_second_write_of_a_note_waits_for_the_first_and_an_idle_note_is_dropped() {
        let order = Arc::new(WriteOrder::default());
        let (entered, first_entered) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let log = Arc::new(Mutex::new(Vec::new()));
        let first = {
            let (order, log) = (order.clone(), log.clone());
            thread::spawn(move || {
                order.run("n", || {
                    entered.send(()).unwrap();
                    released.recv().unwrap();
                    log.lock().unwrap().push("first");
                });
            })
        };
        first_entered.recv().unwrap();
        let second = {
            let (order, log) = (order.clone(), log.clone());
            thread::spawn(move || order.run("n", || log.lock().unwrap().push("second")))
        };
        // The second write is in line once it counts itself in.
        while order.writes("n") < 2 {
            thread::yield_now();
        }
        // Another note does not wait for `n`.
        order.run("other", || log.lock().unwrap().push("other"));
        release.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();
        let log = log.lock().unwrap().clone();
        assert_eq!(log.first(), Some(&"other"));
        assert_eq!(&log[1..], ["first", "second"]);
        assert_eq!(order.len(), 0);
    }

    #[test]
    fn a_failed_write_does_not_stop_the_next() {
        let order = WriteOrder::default();
        let failed: Result<(), &str> = order.run("n", || Err("refused"));
        assert!(failed.is_err());
        assert_eq!(order.run("n", || 7), 7);
        let panicked = std::panic::catch_unwind(|| order.run("n", || panic!("broken write")));
        assert!(panicked.is_err());
        assert_eq!(order.run("n", || 8), 8);
        assert_eq!(order.len(), 0);
    }
}
