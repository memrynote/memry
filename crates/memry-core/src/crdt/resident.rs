//! The documents the editor host keeps in memory (Step 14): which are loaded,
//! who holds each one, and when an unheld one leaves.
//!
//! [`super::lifecycle`] decides residency over ids and [`super::registry`] makes
//! documents; this joins the two for one owner, the editor host
//! (`api::editor`). It adds two things neither has:
//!
//! - **Named holders.** A holder is an editor surface, a desktop window label.
//!   A holder takes a document once however often it opens it, and
//!   [`Resident::release_holder`] lets a closed window go of everything it held
//!   (`forgetWindow` in Electron's `crdt-provider.ts`).
//! - **A missing document reloads.** The map of loaded documents is a cache of
//!   the durable log: whenever an id the lifecycle keeps has no document here
//!   (the first request, or [`Resident::invalidate`] after a write whose commit
//!   failed), the caller's loader replays it. So a document in memory never
//!   holds an edit the log does not.
//!
//! An id whose log does not replay walks to `Unreadable` and is answered with
//! `None`, never with a half-built document; the lifecycle's poison set keeps
//! later requests from replaying it again.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use super::errors::CrdtError;
use super::lifecycle::{DocumentLifecycle, DocumentState, LifecycleConfig};
use super::registry::Document;

/// The residency budget. Not Electron's: it kept up to 32 documents no window
/// held, with no timer (`DEFAULT_INACTIVE_DOC_LIMIT`, `crdt-provider.ts:76`,
/// `:2275-2287`). Here the lifecycle's bound of 32 counts held documents too (a
/// held one is never evicted, so the bound yields past 32 rather than take it),
/// and an unheld document leaves after 30 s. Coming back to a note later replays
/// its log, a local SQLite read and a `yrs` apply, instead of costing memory.
pub const EDITOR_LIFECYCLE: LifecycleConfig = LifecycleConfig {
    max_open: 32,
    grace_ms: 30_000,
};

/// A document a holder took.
pub struct Held {
    pub document: Arc<Document>,
    /// The holder did not hold it before this call, so undoing the call
    /// releases it; otherwise the earlier hold stays.
    pub added: bool,
}

/// The documents in memory and their holders.
pub struct Resident {
    lifecycle: DocumentLifecycle,
    docs: HashMap<String, Arc<Document>>,
    holders: BTreeMap<String, BTreeSet<String>>,
    /// Holders whose copy is of a document since purged; see [`Resident::purge`].
    stale: BTreeMap<String, BTreeSet<String>>,
}

impl Resident {
    pub fn new(config: LifecycleConfig) -> Self {
        Self {
            lifecycle: DocumentLifecycle::new(config),
            docs: HashMap::new(),
            holders: BTreeMap::new(),
            stale: BTreeMap::new(),
        }
    }

    /// `holder` takes `doc_id`, loading it through `load` when it is not in
    /// memory. `None`: the log does not replay, and `holder` holds nothing new.
    pub fn hold(
        &mut self,
        doc_id: &str,
        holder: &str,
        now_ms: i64,
        load: impl FnOnce() -> Result<Arc<Document>, CrdtError>,
    ) -> Result<Option<Held>, CrdtError> {
        if self
            .holders
            .get(doc_id)
            .is_some_and(|set| set.contains(holder))
        {
            let state = self.lifecycle.state(doc_id);
            let document = self.settle(doc_id, state, now_ms, load)?;
            return Ok(document.map(|document| Held {
                document,
                added: false,
            }));
        }
        let document = self.request(doc_id, now_ms, load);
        if let Ok(Some(_)) = document {
            self.lifecycle.editor_attached(doc_id, now_ms);
            self.holders
                .entry(doc_id.to_owned())
                .or_default()
                .insert(holder.to_owned());
        } else {
            self.lifecycle.release(doc_id, now_ms);
        }
        Ok(document?.map(|document| Held {
            document,
            added: true,
        }))
    }

    /// `doc_id` for one operation, without a holder: a document nobody holds
    /// stays for the grace period and then goes.
    pub fn borrow(
        &mut self,
        doc_id: &str,
        now_ms: i64,
        load: impl FnOnce() -> Result<Arc<Document>, CrdtError>,
    ) -> Result<Option<Arc<Document>>, CrdtError> {
        let document = self.request(doc_id, now_ms, load);
        self.lifecycle.release(doc_id, now_ms);
        document
    }

    /// The loaded document, without loading or touching it.
    pub fn peek(&self, doc_id: &str) -> Option<Arc<Document>> {
        self.docs.get(doc_id).cloned()
    }

    /// `holder` lets go of `doc_id`. False when it did not hold it.
    pub fn release(&mut self, doc_id: &str, holder: &str, now_ms: i64) -> bool {
        let Some(set) = self.holders.get_mut(doc_id) else {
            return false;
        };
        if !set.remove(holder) {
            return false;
        }
        if set.is_empty() {
            self.holders.remove(doc_id);
        }
        self.reopened(doc_id, holder);
        self.lifecycle.release(doc_id, now_ms);
        true
    }

    /// `holder` lets go of everything it holds; returns those ids.
    pub fn release_holder(&mut self, holder: &str, now_ms: i64) -> Vec<String> {
        let held: Vec<String> = self
            .holders
            .iter()
            .filter(|(_, set)| set.contains(holder))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &held {
            self.release(id, holder, now_ms);
        }
        held
    }

    /// Drops the loaded document; the next access replays the log.
    pub fn invalidate(&mut self, doc_id: &str) {
        self.docs.remove(doc_id);
    }

    /// The document's log was purged: the loaded copy goes, a log that failed
    /// to replay is replayed again on the next request, and every holder is
    /// stale until it opens the document again. A stale holder's copy is of
    /// the deleted document, and an edit of it would bring the deleted body
    /// back (chapter 07 §7.15).
    pub fn purge(&mut self, doc_id: &str) {
        self.docs.remove(doc_id);
        self.lifecycle.forgive(doc_id);
        if let Some(holders) = self.holders.get(doc_id) {
            let stale = self.stale.entry(doc_id.to_owned()).or_default();
            stale.extend(holders.iter().cloned());
        }
    }

    /// Whether `holder`'s copy of `doc_id` is of a document since purged.
    pub fn is_stale(&self, doc_id: &str, holder: &str) -> bool {
        self.stale
            .get(doc_id)
            .is_some_and(|set| set.contains(holder))
    }

    /// `holder` received the document as it is now, or let it go.
    pub fn reopened(&mut self, doc_id: &str, holder: &str) {
        if let Some(set) = self.stale.get_mut(doc_id) {
            set.remove(holder);
            if set.is_empty() {
                self.stale.remove(doc_id);
            }
        }
    }

    /// Unloads every unheld document whose grace period has passed.
    pub fn sweep(&mut self, now_ms: i64) -> Vec<String> {
        let gone = self.lifecycle.sweep(now_ms);
        for id in &gone {
            self.docs.remove(id);
        }
        gone
    }

    pub fn is_held(&self, doc_id: &str) -> bool {
        self.holders.contains_key(doc_id)
    }

    /// Every held id, sorted.
    pub fn held_ids(&self) -> Vec<String> {
        self.holders.keys().cloned().collect()
    }

    /// One lifecycle request, settled. The caller releases it.
    fn request(
        &mut self,
        doc_id: &str,
        now_ms: i64,
        load: impl FnOnce() -> Result<Arc<Document>, CrdtError>,
    ) -> Result<Option<Arc<Document>>, CrdtError> {
        let acquisition = self.lifecycle.request(doc_id, now_ms);
        for evicted in &acquisition.evicted {
            self.docs.remove(evicted);
        }
        self.settle(doc_id, acquisition.state, now_ms, load)
    }

    fn settle(
        &mut self,
        doc_id: &str,
        state: DocumentState,
        now_ms: i64,
        load: impl FnOnce() -> Result<Arc<Document>, CrdtError>,
    ) -> Result<Option<Arc<Document>>, CrdtError> {
        if state == DocumentState::Unreadable {
            return Ok(None);
        }
        if let Some(document) = self.docs.get(doc_id) {
            self.lifecycle.loaded(doc_id, now_ms);
            return Ok(Some(Arc::clone(document)));
        }
        match load() {
            Ok(document) => {
                self.docs.insert(doc_id.to_owned(), Arc::clone(&document));
                self.lifecycle.loaded(doc_id, now_ms);
                Ok(Some(document))
            }
            Err(CrdtError::Undecodable { .. } | CrdtError::NotApplicable { .. }) => {
                self.lifecycle.unreadable(doc_id, now_ms);
                Ok(None)
            }
            Err(other) => Err(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crdt::DocumentRegistry;

    fn loader(id: &str) -> impl FnOnce() -> Result<Arc<Document>, CrdtError> + '_ {
        move || DocumentRegistry::new("device-a", Arc::new(|_, _| {})).get_or_open(id)
    }

    #[test]
    fn a_second_hold_by_the_same_holder_adds_nothing() {
        let mut resident = Resident::new(EDITOR_LIFECYCLE);
        let first = resident.hold("n1", "main", 0, loader("n1")).unwrap();
        assert!(first.unwrap().added);
        let again = resident.hold("n1", "main", 1, || unreachable!()).unwrap();
        assert!(!again.unwrap().added);
    }

    #[test]
    fn past_the_bound_the_oldest_unheld_document_goes_and_a_held_one_stays() {
        let mut resident = Resident::new(EDITOR_LIFECYCLE);
        resident.hold("held", "main", 0, loader("held")).unwrap();
        let ids: Vec<String> = (0..40).map(|n| format!("n{n}")).collect();
        for (n, id) in ids.iter().enumerate() {
            resident.borrow(id, 1 + n as i64, loader(id)).unwrap();
        }

        assert!(
            resident.peek("held").is_some(),
            "a held document is never evicted"
        );
        assert!(
            resident.peek("n0").is_none(),
            "the least recently touched went"
        );
        assert!(resident.peek("n39").is_some());
        let loaded = ids.iter().filter(|id| resident.peek(id).is_some()).count();
        assert_eq!(loaded + 1, EDITOR_LIFECYCLE.max_open);
    }

    #[test]
    fn an_invalidated_document_reloads_for_its_holder() {
        let mut resident = Resident::new(EDITOR_LIFECYCLE);
        let first = resident
            .hold("n1", "main", 0, loader("n1"))
            .unwrap()
            .unwrap()
            .document;
        resident.invalidate("n1");
        let reloaded = resident.borrow("n1", 1, loader("n1")).unwrap().unwrap();
        assert!(!Arc::ptr_eq(&first, &reloaded));
        assert!(
            resident.is_held("n1"),
            "a borrow does not take the holder's place"
        );
    }
}
