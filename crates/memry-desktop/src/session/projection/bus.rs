//! One lane's bounded queue (`apps/desktop/src/main/projections/bus.ts`).
//!
//! Newest wins, in place: an already-queued event of the same kind for the same entity is
//! fully superseded, so it is overwritten instead of queued twice. Only the entity's newest
//! pending event is a candidate, so a `NoteDeleted` can never be reordered behind a later
//! `NoteUpserted`: a change of kind re-anchors the entity to the tail. At the cap the oldest
//! event is dropped and counted, and the lane owes a reconcile for it.

use std::collections::{HashMap, VecDeque};

use super::event::{EventKind, ProjectionEvent};

pub const DEFAULT_QUEUE_LIMIT: usize = 2000;

struct Newest {
    /// Sequence number of the newest queued event of this entity.
    seq: u64,
    kind: EventKind,
}

pub struct ProjectionBus {
    queue: VecDeque<ProjectionEvent>,
    /// Sequence number of `queue[0]`.
    head_seq: u64,
    newest: HashMap<String, Newest>,
    dropped: u64,
    limit: usize,
}

impl ProjectionBus {
    pub fn new(limit: usize) -> Self {
        Self {
            queue: VecDeque::new(),
            head_seq: 0,
            newest: HashMap::new(),
            dropped: 0,
            limit: limit.max(1),
        }
    }

    pub fn enqueue(&mut self, event: ProjectionEvent) {
        let key = event.entity_key();
        let kind = event.kind();
        if let Some(newest) = self.newest.get(&key)
            && newest.kind == kind
        {
            let index = usize::try_from(newest.seq - self.head_seq).unwrap_or(usize::MAX);
            if let Some(slot) = self.queue.get_mut(index) {
                *slot = event;
                return;
            }
        }
        if self.queue.len() >= self.limit {
            self.dequeue();
            self.dropped += 1;
        }
        let seq = self.head_seq + self.queue.len() as u64;
        self.queue.push_back(event);
        self.newest.insert(key, Newest { seq, kind });
    }

    pub fn dequeue(&mut self) -> Option<ProjectionEvent> {
        let event = self.queue.pop_front()?;
        let key = event.entity_key();
        if self
            .newest
            .get(&key)
            .is_some_and(|n| n.seq == self.head_seq)
        {
            self.newest.remove(&key);
        }
        self.head_seq += 1;
        Some(event)
    }

    pub fn clear(&mut self) {
        self.head_seq += self.queue.len() as u64;
        self.queue.clear();
        self.newest.clear();
    }

    /// Events dropped to stay under the cap since the last call.
    pub fn take_dropped(&mut self) -> u64 {
        std::mem::take(&mut self.dropped)
    }

    /// Events dropped and not yet taken.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upsert(id: &str) -> ProjectionEvent {
        ProjectionEvent::TaskUpserted { task_id: id.into() }
    }

    fn delete(id: &str) -> ProjectionEvent {
        ProjectionEvent::TaskDeleted { task_id: id.into() }
    }

    #[test]
    fn the_cap_drops_the_oldest_and_counts_it() {
        let mut bus = ProjectionBus::new(3);
        for n in 0..4 {
            bus.enqueue(upsert(&n.to_string()));
        }
        assert_eq!(bus.len(), 3);
        assert_eq!(bus.take_dropped(), 1);
        assert_eq!(bus.take_dropped(), 0);
        assert_eq!(bus.dequeue(), Some(upsert("1")));
    }

    #[test]
    fn an_equal_event_overwrites_the_queued_one_in_place() {
        let mut bus = ProjectionBus::new(10);
        let note = |title: &str| ProjectionEvent::NoteHeaderTagsResolved {
            note_id: "n".into(),
            header_tags: vec![title.into()],
        };
        bus.enqueue(note("old"));
        bus.enqueue(upsert("t"));
        bus.enqueue(note("new"));
        assert_eq!(bus.len(), 2);
        assert_eq!(bus.dequeue(), Some(note("new")));
    }

    #[test]
    fn a_delete_is_never_reordered_behind_a_later_upsert() {
        let mut bus = ProjectionBus::new(10);
        bus.enqueue(upsert("t"));
        bus.enqueue(delete("t"));
        bus.enqueue(upsert("t"));
        let order: Vec<_> = std::iter::from_fn(|| bus.dequeue()).collect();
        assert_eq!(order, [upsert("t"), delete("t"), upsert("t")]);
    }

    #[test]
    fn coalescing_survives_dequeues_of_earlier_events() {
        let mut bus = ProjectionBus::new(10);
        bus.enqueue(upsert("a"));
        bus.enqueue(upsert("b"));
        assert_eq!(bus.dequeue(), Some(upsert("a")));
        bus.enqueue(upsert("b"));
        assert_eq!(bus.len(), 1);
        bus.clear();
        bus.enqueue(upsert("b"));
        assert_eq!(bus.len(), 1);
    }
}
