//! The applied-record feed (#3534): what a pulled page changed, told to the
//! desktop services that follow the database (write-back, locks, status,
//! attachments) after the page commits.
//!
//! Three rules, each a way to lose data or wedge a pass:
//!
//! - **After the commit, never inside it.** An observer reads the row it is
//!   told about from core; inside the transaction a reader connection would
//!   not see it yet, and a slow observer would hold the writer.
//! - **Off the runtime.** Observers are synchronous and may block (a file
//!   write-back, a lock reconcile), so they run on `spawn_blocking`.
//! - **One panic stops one observer.** A panic is logged with the observer's
//!   name and the page size, and the next observer still runs: a broken status
//!   feed must not stop a note reaching its file.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, RwLock};

use serde_json::Value as Json;

/// What the apply did with one pulled record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppliedOutcome {
    /// No live local row existed; the remote one was stored.
    Created,
    /// The remote row replaced the local one wholesale.
    Updated,
    /// A tombstone was applied.
    Deleted,
    /// A field merge combined the local and remote rows (chapter 06 §6.3).
    Merged,
    /// The local row won (chapter 06 §6.3.1) or the type's schema refused it.
    Skipped,
}

/// One field a concurrent merge decided (chapter 06 §6.5), for the
/// `conflict_resolved` telemetry and the conflict report.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldConflict {
    pub field: String,
    pub losing: Json,
    pub winning: Json,
    pub merged_clock: Json,
}

/// One record of a committed page. Ids, the outcome and the conflicts only:
/// an observer that needs the payload reads the row from core.
#[derive(Debug, Clone, PartialEq)]
pub struct AppliedRecord {
    pub item_type: String,
    pub item_id: String,
    pub outcome: AppliedOutcome,
    pub conflicts: Vec<FieldConflict>,
}

/// A desktop service that follows what sync applied. Every method defaults to
/// nothing, so an observer implements only what it consumes.
pub trait ApplyObserver: Send + Sync {
    /// A name for the log line of a panic.
    fn name(&self) -> &str;

    /// Every record of one committed page, in apply order. One call per page.
    fn records_applied(&self, _batch: &[AppliedRecord]) {}

    /// A pulled tombstone of `note_id` was skipped because the local edit is
    /// newer, so the note lives on (Electron's `note-handler.ts:740`).
    fn note_revived(&self, _note_id: &str) {}

    /// An applied record references attachment `attachment_id`, which this
    /// device lacks. `hint` is the owner's type.
    fn attachment_download_needed(&self, _owner_id: &str, _attachment_id: &str, _hint: &str) {}

    /// These note or journal bodies changed in the update log, committed.
    /// Record pages carry no body change, and `Editor::subscribe` sees only
    /// resident documents, so this is how a non-resident body reaches its file.
    fn bodies_applied(&self, _doc_ids: &[String]) {}
}

/// The registered observers, in registration order. Shared by every pull of
/// one driver, so an observer registered after the driver was built still
/// hears the next page.
#[derive(Default)]
pub struct Observers(RwLock<Vec<Arc<dyn ApplyObserver>>>);

impl Observers {
    pub fn register(&self, observer: Arc<dyn ApplyObserver>) {
        self.0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(observer);
    }

    fn snapshot(&self) -> Vec<Arc<dyn ApplyObserver>> {
        self.0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Tells every observer about one committed page, on `spawn_blocking`.
    /// An empty page tells no one.
    pub async fn records_applied(&self, batch: Vec<AppliedRecord>) {
        if batch.is_empty() {
            return;
        }
        let size = batch.len();
        self.each("records_applied", size, move |observer| {
            observer.records_applied(&batch)
        })
        .await;
    }

    /// Tells every observer that these bodies changed, on `spawn_blocking`.
    pub async fn bodies_applied(&self, doc_ids: Vec<String>) {
        if doc_ids.is_empty() {
            return;
        }
        let size = doc_ids.len();
        self.each("bodies_applied", size, move |observer| {
            observer.bodies_applied(&doc_ids)
        })
        .await;
    }

    async fn each(
        &self,
        what: &'static str,
        size: usize,
        call: impl Fn(&dyn ApplyObserver) + Send + 'static,
    ) {
        let observers = self.snapshot();
        if observers.is_empty() {
            return;
        }
        let joined = tokio::task::spawn_blocking(move || {
            for observer in &observers {
                let ran = catch_unwind(AssertUnwindSafe(|| call(observer.as_ref())));
                if ran.is_err() {
                    eprintln!(
                        "memry-core: sync observer `{}` panicked in {what} over {size} item(s); \
                         the next observer still runs",
                        observer.name()
                    );
                }
            }
        })
        .await;
        if let Err(error) = joined {
            eprintln!("memry-core: the sync observers' {what} task failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Recording {
        name: &'static str,
        panics: bool,
        seen: Mutex<Vec<String>>,
    }

    impl ApplyObserver for Recording {
        fn name(&self) -> &str {
            self.name
        }

        fn records_applied(&self, batch: &[AppliedRecord]) {
            assert!(!self.panics, "a broken observer");
            let ids = batch.iter().map(|record| record.item_id.clone());
            self.seen.lock().unwrap().extend(ids);
        }

        fn bodies_applied(&self, doc_ids: &[String]) {
            assert!(!self.panics, "a broken observer");
            self.seen.lock().unwrap().extend(doc_ids.iter().cloned());
        }
    }

    fn recording(name: &'static str, panics: bool) -> Arc<Recording> {
        Arc::new(Recording {
            name,
            panics,
            seen: Mutex::default(),
        })
    }

    fn record(id: &str) -> AppliedRecord {
        AppliedRecord {
            item_type: "task".into(),
            item_id: id.into(),
            outcome: AppliedOutcome::Created,
            conflicts: Vec::new(),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_panicking_observer_does_not_stop_the_next_one() {
        let observers = Observers::default();
        let broken = recording("broken", true);
        let after = recording("after", false);
        observers.register(broken);
        observers.register(after.clone());

        observers
            .records_applied(vec![record("t1"), record("t2")])
            .await;
        observers.bodies_applied(vec!["n1".into()]).await;
        assert_eq!(*after.seen.lock().unwrap(), ["t1", "t2", "n1"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_empty_page_tells_no_one_and_order_is_registration_order() {
        let observers = Observers::default();
        let first = recording("first", false);
        observers.register(first.clone());
        observers.records_applied(Vec::new()).await;
        assert!(first.seen.lock().unwrap().is_empty());

        let second = recording("second", false);
        observers.register(second.clone());
        observers.records_applied(vec![record("t1")]).await;
        assert_eq!(*first.seen.lock().unwrap(), ["t1"]);
        assert_eq!(*second.seen.lock().unwrap(), ["t1"]);
    }
}
