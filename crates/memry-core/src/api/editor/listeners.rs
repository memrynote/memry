//! The listeners of the editor's documents: who hears each committed update,
//! and the fan-out that tells them.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, MutexGuard, PoisonError};

use super::{Editor, Origin};

/// What a document's listener hears, after the commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice<'a> {
    /// An update the document took, and where it came from.
    Update(&'a [u8], &'a Origin),
    /// The document's body was purged (a delete applied): a window drops its
    /// copy and opens the document again. Its edits are refused
    /// ([`EditorError::Purged`]), and while every holder is stale no update
    /// of the new document is sent, until one opens it.
    Purged,
}

/// Called with each [`Notice`] of a document.
pub type Listener = Arc<dyn Fn(Notice<'_>) + Send + Sync>;

/// Names a listener for [`Editor::unsubscribe`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ListenerId(u64);

#[derive(Default)]
pub(super) struct Listeners {
    next: u64,
    by_doc: HashMap<String, Vec<(ListenerId, Listener)>>,
}

impl Editor {
    /// Calls `listener` with every [`Notice`] of `note_id`, after its commit.
    pub fn subscribe(
        &self,
        note_id: &str,
        listener: impl Fn(Notice<'_>) + Send + Sync + 'static,
    ) -> ListenerId {
        let mut listeners = self.listeners();
        listeners.next += 1;
        let id = ListenerId(listeners.next);
        listeners
            .by_doc
            .entry(note_id.to_owned())
            .or_default()
            .push((id, Arc::new(listener)));
        id
    }

    /// Stops a listener. False when it was not subscribed.
    pub fn unsubscribe(&self, id: ListenerId) -> bool {
        let mut listeners = self.listeners();
        let mut found = false;
        listeners.by_doc.retain(|_, list| {
            let before = list.len();
            list.retain(|(each, _)| *each != id);
            found |= list.len() != before;
            !list.is_empty()
        });
        found
    }

    /// Hands `notice`, committed, to `note_id`'s listeners, and counts it
    /// toward the document's next compaction.
    pub(super) fn fan_out(&self, note_id: &str, notice: Notice<'_>) {
        self.count_growth(note_id, notice);
        let listeners: Vec<Listener> = self
            .listeners()
            .by_doc
            .get(note_id)
            .map(|list| list.iter().map(|(_, f)| Arc::clone(f)).collect())
            .unwrap_or_default();
        for listener in listeners {
            if catch_unwind(AssertUnwindSafe(|| listener(notice))).is_err() {
                let what = match notice {
                    Notice::Update(_, origin) => origin.kind(),
                    Notice::Purged => "purge",
                };
                eprintln!("memry editor: a listener of {note_id} panicked on a {what} notice");
            }
        }
    }

    fn listeners(&self) -> MutexGuard<'_, Listeners> {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}
