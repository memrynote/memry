//! One write of a note at a time (`writeNoteInOrder`, `vault/note-write.ts`): the app's writes
//! of one note (an update, a delete) run one after the other, in the order they arrived, so
//! the second reads what the first wrote. Writes of different notes do not wait for each
//! other. A note's entry is dropped once no write holds or waits for it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

#[derive(Default)]
pub struct WriteOrder {
    notes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl WriteOrder {
    /// Runs `write` once every earlier write of `note_id` has finished. Blocks: call it off the
    /// async runtime. A write that fails does not stop the next one.
    pub fn run<T>(&self, note_id: &str, write: impl FnOnce() -> T) -> T {
        let turn = self.notes().entry(note_id.to_owned()).or_default().clone();
        let result = {
            let _held = turn.lock().unwrap_or_else(PoisonError::into_inner);
            write()
        };
        let mut notes = self.notes();
        // The map's own handle and ours: nobody else holds or waits for this note.
        if Arc::strong_count(&turn) == 2 {
            notes.remove(note_id);
        }
        result
    }

    fn notes(&self) -> MutexGuard<'_, HashMap<String, Arc<Mutex<()>>>> {
        self.notes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.notes().len()
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
        let (queued, second_queued) = mpsc::channel();
        let second = {
            let (order, log) = (order.clone(), log.clone());
            thread::spawn(move || {
                queued.send(()).unwrap();
                order.run("n", || log.lock().unwrap().push("second"));
            })
        };
        second_queued.recv().unwrap();
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
    }
}
