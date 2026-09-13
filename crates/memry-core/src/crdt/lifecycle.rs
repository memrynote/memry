//! The document lifecycle, exactly as data-model §C.4 draws it.
//!
//! ```text
//! Closed
//!   -> Loading        a surface asked for the document
//! Loading
//!   -> Open           both namespaces replayed
//!   -> Unreadable     the log cannot be replayed
//! Open
//!   -> Replicated     an editor surface attached and received the state
//!   -> Closing        last holder released, grace period started
//! Replicated
//!   -> Open           the editor surface detached
//!   -> Closing        last holder released
//! Closing
//!   -> Open           a new holder arrived inside the grace period
//!   -> Closed         grace period elapsed, evicted
//! Unreadable          (terminal for this document until the app restarts)
//!   -> Closed         released; the note remains readable from note_bodies
//! ```
//!
//! Four things this type is, and one it is not.
//!
//! - **`Replicated` is a real state, not a flag.** In it the core owns the
//!   document and an editor holds a replica, and exactly one of the two may
//!   write to disk. Naming it is what makes "the editor persists nothing"
//!   checkable.
//! - **`Unreadable` is a first-class state, not an error return** (FR-043). A
//!   body whose log cannot be replayed refuses to open *for editing*, says so,
//!   and removes nothing. Reading keeps working, because `note_bodies` is a
//!   separate table that does not need the document.
//! - **"Terminal until the app restarts"** is honoured by a poison set held in
//!   memory: after `Unreadable` is released to `Closed`, the next request still
//!   walks `Closed -> Loading -> Unreadable` and lands there **without asking
//!   the caller to replay again**. The drawn edges are the drawn edges; what
//!   the poison set removes is the retry, not a transition. A restart drops the
//!   set, which is exactly what "until the app restarts" says.
//! - **Open documents are bounded.** An LRU with a grace period, so a fast
//!   navigate-away-and-back does not pay a reload, and memory stays a budget.
//!   Only a document with no holders is ever evicted; eviction under pressure
//!   cuts the grace period short rather than growing past the bound.
//!
//! What it is not: it touches neither `yrs` nor SQLite. It is bookkeeping over
//! ids, which is what lets the state machine be driven and asserted directly
//! rather than inferred from a document that happens to be in memory. Time
//! arrives as an epoch-millisecond argument for the same reason.

use std::collections::{HashMap, HashSet};

/// A document's lifecycle state (data-model §C.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DocumentState {
    /// Not in memory.
    Closed,
    /// A surface asked for it; the log is being replayed.
    Loading,
    /// Both namespaces replayed; the core holds the document.
    Open,
    /// An editor surface attached and received the state.
    Replicated,
    /// The last holder released; the grace period is running.
    Closing,
    /// The log cannot be replayed. Reading continues from `note_bodies`.
    Unreadable,
}

/// The residency budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LifecycleConfig {
    /// How many documents may be resident at once, counting every state above
    /// `Closed`. Memory is a budget (constitution, Principle V).
    pub max_open: usize,
    /// How long a document with no holders stays in `Closing` before eviction.
    pub grace_ms: i64,
}

impl Default for LifecycleConfig {
    fn default() -> Self {
        Self {
            max_open: 8,
            grace_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone)]
struct Entry {
    state: DocumentState,
    holders: u32,
    /// Set while `state` is `Closing`; the instant the grace period elapses.
    evict_at_ms: Option<i64>,
    /// Last time any holder touched it, for the LRU ordering.
    touched_ms: i64,
}

/// The lifecycle of every document this process is holding.
#[derive(Debug)]
pub struct DocumentLifecycle {
    config: LifecycleConfig,
    entries: HashMap<String, Entry>,
    /// Documents whose log failed to replay in this process.
    poisoned: HashSet<String>,
}

impl DocumentLifecycle {
    pub fn new(config: LifecycleConfig) -> Self {
        Self {
            config,
            entries: HashMap::new(),
            poisoned: HashSet::new(),
        }
    }

    /// The state of `doc_id`; `Closed` for a document this process does not
    /// hold.
    pub fn state(&self, doc_id: &str) -> DocumentState {
        self.entries
            .get(doc_id)
            .map_or(DocumentState::Closed, |entry| entry.state)
    }

    /// How many holders `doc_id` has.
    pub fn holders(&self, doc_id: &str) -> u32 {
        self.entries.get(doc_id).map_or(0, |entry| entry.holders)
    }

    /// Every document above `Closed`.
    pub fn resident(&self) -> usize {
        self.entries.len()
    }

    /// A surface asks for a document, taking a holder.
    ///
    /// The state it lands in tells the caller what to do next:
    ///
    /// - `Loading` — replay the log, then call [`Self::loaded`] or
    ///   [`Self::unreadable`];
    /// - `Open` or `Replicated` — it was already resident, nothing to replay;
    /// - `Unreadable` — the log already failed in this process. **Do not
    ///   replay it again**; offer the reading path instead.
    ///
    /// Returns the documents this request evicted to stay inside the bound.
    pub fn request(&mut self, doc_id: &str, now_ms: i64) -> Acquisition {
        if let Some(entry) = self.entries.get_mut(doc_id) {
            entry.holders += 1;
            entry.touched_ms = now_ms;
            if entry.state == DocumentState::Closing {
                // Closing -> Open: a new holder arrived inside the grace
                // period, so the reload is not paid.
                entry.state = DocumentState::Open;
                entry.evict_at_ms = None;
            }
            let state = entry.state;
            return Acquisition {
                state,
                evicted: Vec::new(),
            };
        }

        let evicted = self.make_room(now_ms);

        // Closed -> Loading, for every request. A poisoned document walks the
        // same edge and lands on Loading -> Unreadable without a replay.
        let state = if self.poisoned.contains(doc_id) {
            DocumentState::Unreadable
        } else {
            DocumentState::Loading
        };
        self.entries.insert(
            doc_id.to_owned(),
            Entry {
                state,
                holders: 1,
                evict_at_ms: None,
                touched_ms: now_ms,
            },
        );
        Acquisition { state, evicted }
    }

    /// Loading -> Open: both namespaces replayed.
    pub fn loaded(&mut self, doc_id: &str, now_ms: i64) -> DocumentState {
        self.transition(doc_id, now_ms, |entry| {
            if entry.state == DocumentState::Loading {
                entry.state = DocumentState::Open;
            }
        })
    }

    /// Loading -> Unreadable: the log cannot be replayed.
    ///
    /// Nothing is removed and no error is returned in its place. The document
    /// stays resident so the surface can say so, and the id is poisoned for the
    /// rest of the process so a retry loop cannot form.
    pub fn unreadable(&mut self, doc_id: &str, now_ms: i64) -> DocumentState {
        self.poisoned.insert(doc_id.to_owned());
        self.transition(doc_id, now_ms, |entry| {
            if entry.state == DocumentState::Loading {
                entry.state = DocumentState::Unreadable;
            }
        })
    }

    /// Open -> Replicated: an editor surface attached and received the state.
    pub fn editor_attached(&mut self, doc_id: &str, now_ms: i64) -> DocumentState {
        self.transition(doc_id, now_ms, |entry| {
            if entry.state == DocumentState::Open {
                entry.state = DocumentState::Replicated;
            }
        })
    }

    /// Replicated -> Open: the editor surface detached.
    pub fn editor_detached(&mut self, doc_id: &str, now_ms: i64) -> DocumentState {
        self.transition(doc_id, now_ms, |entry| {
            if entry.state == DocumentState::Replicated {
                entry.state = DocumentState::Open;
            }
        })
    }

    /// A holder releases the document.
    ///
    /// On the last holder: `Open` and `Replicated` start the grace period;
    /// `Unreadable` goes straight to `Closed`, because there is nothing to come
    /// back to and the note stays readable from `note_bodies`.
    pub fn release(&mut self, doc_id: &str, now_ms: i64) -> DocumentState {
        let Some(entry) = self.entries.get_mut(doc_id) else {
            return DocumentState::Closed;
        };
        entry.holders = entry.holders.saturating_sub(1);
        entry.touched_ms = now_ms;
        if entry.holders > 0 {
            return entry.state;
        }

        match entry.state {
            DocumentState::Unreadable | DocumentState::Loading => {
                self.entries.remove(doc_id);
                DocumentState::Closed
            }
            DocumentState::Open | DocumentState::Replicated => {
                entry.state = DocumentState::Closing;
                entry.evict_at_ms = Some(now_ms + self.config.grace_ms);
                DocumentState::Closing
            }
            DocumentState::Closing => DocumentState::Closing,
            DocumentState::Closed => DocumentState::Closed,
        }
    }

    /// Closes every `Closing` document whose grace period has elapsed.
    ///
    /// Returns the ids that went to `Closed`, which is what the caller releases
    /// from the registry.
    pub fn sweep(&mut self, now_ms: i64) -> Vec<String> {
        let due: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                entry.state == DocumentState::Closing
                    && entry.evict_at_ms.is_some_and(|at| at <= now_ms)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &due {
            self.entries.remove(id);
        }
        due
    }

    /// Whether a document's log already failed in this process.
    pub fn is_poisoned(&self, doc_id: &str) -> bool {
        self.poisoned.contains(doc_id)
    }

    /// Evicts held-free documents, least recently touched first, until there is
    /// room for one more.
    ///
    /// Under pressure this cuts a grace period short. That is the trade the
    /// bound exists to make: a grace period is an optimisation and the budget
    /// is not. A document with a holder is never taken.
    fn make_room(&mut self, now_ms: i64) -> Vec<String> {
        let mut evicted = Vec::new();
        while self.entries.len() >= self.config.max_open {
            let victim = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.holders == 0)
                .min_by_key(|(id, entry)| (entry.touched_ms, (*id).clone()))
                .map(|(id, _)| id.clone());
            let Some(victim) = victim else {
                // Every resident document is held. The bound yields rather than
                // pulling a document out from under a reader.
                break;
            };
            self.entries.remove(&victim);
            evicted.push(victim);
        }
        let _ = now_ms;
        evicted
    }

    fn transition<F>(&mut self, doc_id: &str, now_ms: i64, f: F) -> DocumentState
    where
        F: FnOnce(&mut Entry),
    {
        let Some(entry) = self.entries.get_mut(doc_id) else {
            return DocumentState::Closed;
        };
        f(entry);
        entry.touched_ms = now_ms;
        entry.state
    }
}

impl Default for DocumentLifecycle {
    fn default() -> Self {
        Self::new(LifecycleConfig::default())
    }
}

/// What a [`DocumentLifecycle::request`] produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Acquisition {
    /// The state the requested document is now in.
    pub state: DocumentState,
    /// Documents evicted to make room, which the caller releases from the
    /// registry.
    pub evicted: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lifecycle(max_open: usize, grace_ms: i64) -> DocumentLifecycle {
        DocumentLifecycle::new(LifecycleConfig { max_open, grace_ms })
    }

    #[test]
    fn the_happy_path_walks_closed_loading_open_replicated_closing_closed() {
        let mut life = lifecycle(4, 1_000);

        assert_eq!(life.state("abc123def456"), DocumentState::Closed);
        assert_eq!(
            life.request("abc123def456", 0).state,
            DocumentState::Loading
        );
        assert_eq!(life.loaded("abc123def456", 1), DocumentState::Open);
        assert_eq!(
            life.editor_attached("abc123def456", 2),
            DocumentState::Replicated
        );
        assert_eq!(life.editor_detached("abc123def456", 3), DocumentState::Open);
        assert_eq!(life.release("abc123def456", 4), DocumentState::Closing);

        assert!(
            life.sweep(1_003).is_empty(),
            "the grace period has not elapsed"
        );
        assert_eq!(life.sweep(1_004), vec!["abc123def456".to_owned()]);
        assert_eq!(life.state("abc123def456"), DocumentState::Closed);
    }

    #[test]
    fn replicated_can_close_without_detaching_first() {
        // §C.4 draws `Replicated -> Closing` directly: the holder can go while
        // the editor is still attached.
        let mut life = lifecycle(4, 1_000);
        life.request("abc123def456", 0);
        life.loaded("abc123def456", 0);
        life.editor_attached("abc123def456", 0);

        assert_eq!(life.release("abc123def456", 5), DocumentState::Closing);
    }

    #[test]
    fn a_holder_arriving_inside_the_grace_period_skips_the_reload() {
        let mut life = lifecycle(4, 1_000);
        life.request("abc123def456", 0);
        life.loaded("abc123def456", 0);
        life.release("abc123def456", 10);
        assert_eq!(life.state("abc123def456"), DocumentState::Closing);

        let again = life.request("abc123def456", 500);
        assert_eq!(
            again.state,
            DocumentState::Open,
            "Closing -> Open, not Closing -> Closed -> Loading"
        );
        assert!(life.sweep(10_000).is_empty());
    }

    #[test]
    fn two_holders_mean_the_first_release_does_not_start_the_grace_period() {
        let mut life = lifecycle(4, 1_000);
        life.request("abc123def456", 0);
        life.loaded("abc123def456", 0);
        life.request("abc123def456", 1);
        assert_eq!(life.holders("abc123def456"), 2);

        assert_eq!(life.release("abc123def456", 2), DocumentState::Open);
        assert_eq!(life.release("abc123def456", 3), DocumentState::Closing);
    }

    #[test]
    fn unreadable_is_a_state_and_a_second_request_does_not_replay() {
        let mut life = lifecycle(4, 1_000);
        assert_eq!(
            life.request("abc123def456", 0).state,
            DocumentState::Loading
        );
        assert_eq!(
            life.unreadable("abc123def456", 1),
            DocumentState::Unreadable
        );

        // Terminal: released to Closed, but the next request lands back on
        // Unreadable rather than asking anyone to replay the log again.
        assert_eq!(life.release("abc123def456", 2), DocumentState::Closed);
        assert_eq!(life.state("abc123def456"), DocumentState::Closed);
        assert!(life.is_poisoned("abc123def456"));
        assert_eq!(
            life.request("abc123def456", 3).state,
            DocumentState::Unreadable
        );

        // And a different document is unaffected: nothing was removed.
        assert_eq!(
            life.request("other12345678", 4).state,
            DocumentState::Loading
        );
    }

    #[test]
    fn the_bound_evicts_the_least_recently_touched_unheld_document() {
        let mut life = lifecycle(2, 1_000);

        life.request("aaa", 0);
        life.loaded("aaa", 0);
        life.release("aaa", 1);

        life.request("bbb", 2);
        life.loaded("bbb", 2);
        life.release("bbb", 3);

        // `aaa` was touched first and both are unheld, so `aaa` goes even
        // though its grace period has not elapsed.
        let third = life.request("ccc", 4);
        assert_eq!(third.evicted, vec!["aaa".to_owned()]);
        assert_eq!(life.state("aaa"), DocumentState::Closed);
        assert_eq!(life.state("bbb"), DocumentState::Closing);
        assert_eq!(life.resident(), 2);
    }

    #[test]
    fn the_bound_never_evicts_a_held_document() {
        let mut life = lifecycle(1, 1_000);
        life.request("aaa", 0);
        life.loaded("aaa", 0);

        let second = life.request("bbb", 1);
        assert!(second.evicted.is_empty());
        assert_eq!(second.state, DocumentState::Loading);
        assert_eq!(
            life.state("aaa"),
            DocumentState::Open,
            "a reader is never pulled out from under"
        );
        assert_eq!(
            life.resident(),
            2,
            "the budget yields rather than losing a reader"
        );
    }
}
