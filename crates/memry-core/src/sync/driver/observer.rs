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
//! - **One panic stops one call.** A panic is logged with the observer's name,
//!   the method and the page size, and the observer's next method and the next
//!   observer still run: a broken status feed must not stop a note reaching its
//!   file. A call slower than [`SLOW_CALL`] is logged too, since it holds the
//!   pass.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value as Json;

pub use crate::sync::hardening::quarantine::SecurityWarning;

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
/// `conflict_resolved` telemetry, the conflict report and a task's
/// `superseded` row.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldConflict {
    pub field: String,
    pub losing: Json,
    pub winning: Json,
    pub merged_clock: Json,
    /// This device's value lost, so `losing` is the value it held. False when
    /// it won (§6.3's `_offline` tie rule), and `losing` is the remote's.
    pub local_lost: bool,
}

/// One record of a committed page. Ids, the outcome and the conflicts only:
/// an observer that needs the payload reads the row from core.
#[derive(Debug, Clone, PartialEq)]
pub struct AppliedRecord {
    pub item_type: String,
    pub item_id: String,
    pub outcome: AppliedOutcome,
    pub conflicts: Vec<FieldConflict>,
    /// A note's title as this device held it before the record applied, `None` for a note
    /// that was not here and for every other type: a pulled change that keeps the title never
    /// renames the note's file (Electron's `titleChanged`, `note-handler.ts:349`).
    pub title_before: Option<String>,
}

/// An attachment an applied record references (Electron's
/// `requestEmbeddedAttachmentDownloads`, `note-handler.ts:153`). Core does
/// not know which files this device holds; the observer skips what it has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentDownload {
    pub owner_id: String,
    pub attachment_id: String,
    /// The owner's item type.
    pub hint: String,
    /// The attachment is the owner's own file (a non-markdown note's
    /// `attachmentId`, `note-handler.ts:637`), not one it embeds.
    pub own_file: bool,
}

/// What one committed page applied, as the observers hear it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppliedFeed {
    /// Every record of the page, in apply order.
    pub records: Vec<AppliedRecord>,
    /// Notes whose pulled tombstone lost to a newer local edit.
    pub revived_notes: Vec<String>,
    pub downloads: Vec<AttachmentDownload>,
}

impl AppliedFeed {
    pub fn is_empty(&self) -> bool {
        self.records.is_empty() && self.revived_notes.is_empty() && self.downloads.is_empty()
    }
}

/// A desktop service that follows what sync applied. Every method defaults to
/// nothing, so an observer implements only what it consumes. It runs under the
/// vault's pass gate: awaiting a pass (`run_pass`, `sync_now`) from it
/// deadlocks.
pub trait ApplyObserver: Send + Sync {
    /// A name for the log line of a panic.
    fn name(&self) -> &str;

    /// Every record of one committed page, in apply order. One call per page.
    fn records_applied(&self, _batch: &[AppliedRecord]) {}

    /// These tasks' activity logs grew in one committed page, by a pulled
    /// `task_activity` row or a `superseded` row this device wrote, each task
    /// once. Told by [`SupersededObserver`] after its own write committed, so
    /// a read at this call sees every row.
    ///
    /// [`SupersededObserver`]: crate::domain::task_activity::superseded::SupersededObserver
    fn task_activity_created(&self, _task_ids: &[String]) {}

    /// A pulled tombstone of `note_id` was skipped because the local edit is
    /// newer, so the note lives on (Electron's `note-handler.ts:740`).
    fn note_revived(&self, _note_id: &str) {}

    /// An applied record references attachment `attachment_id`, which this
    /// device may lack: the observer skips one it has or already asked for.
    fn attachment_download_needed(&self, _download: &AttachmentDownload) {}

    /// These note or journal bodies changed in the update log, committed.
    /// Record pages carry no body change, and `Editor::subscribe` sees only
    /// resident documents, so this is how a non-resident body reaches its file.
    fn bodies_applied(&self, _doc_ids: &[String]) {}

    /// The pass's body step finished and every debt it pulled is settled or
    /// re-owed, committed. `bodies_applied` fires before a document's debt is
    /// settled, so work that needs a settled body (an owed file's take) runs
    /// here.
    fn bodies_settled(&self) {}

    /// A pulled record's signature did not verify, and its quarantine
    /// counted it (desktop's `SecurityWarningEvent`).
    fn security_warning(&self, _warning: &SecurityWarning) {}

    /// A pulled record did not decode and its row is marked corrupt, on the
    /// feed or on the hourly refetch (desktop's `ItemCorruptEvent`).
    fn item_corrupt(&self, _item: &CorruptItem) {}

    /// A row held corrupt was refetched and applied (desktop's
    /// `ItemRecoveredEvent`). Its page's `records_applied` told it too.
    fn item_recovered(&self, _record: &AppliedRecord) {}
}

/// A pulled record marked corrupt. `warning` when its bad signature counted
/// toward the quarantine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorruptItem {
    pub item_type: String,
    pub item_id: String,
    /// Why it did not decode; names no content.
    pub reason: String,
    pub warning: Option<SecurityWarning>,
}

/// An observer call this slow is logged: it runs under the pass gate.
const SLOW_CALL: Duration = Duration::from_secs(5);

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

    /// Tells every observer what one committed page applied, on
    /// `spawn_blocking`: the records in one call, then each revived note, then
    /// each attachment. An empty page tells no one.
    pub async fn applied(&self, feed: AppliedFeed) {
        if feed.is_empty() {
            return;
        }
        let size = feed.records.len();
        self.each("applied", move |observer| {
            if !feed.records.is_empty() {
                guarded(observer, "records_applied", size, || {
                    observer.records_applied(&feed.records)
                });
            }
            for note_id in &feed.revived_notes {
                guarded(observer, "note_revived", size, || {
                    observer.note_revived(note_id)
                });
            }
            for download in &feed.downloads {
                guarded(observer, "attachment_download_needed", size, || {
                    observer.attachment_download_needed(download)
                });
            }
        })
        .await;
    }

    /// Tells every observer that these bodies changed, on `spawn_blocking`.
    pub async fn bodies_applied(&self, doc_ids: Vec<String>) {
        if doc_ids.is_empty() {
            return;
        }
        let size = doc_ids.len();
        self.each("bodies_applied", move |observer| {
            guarded(observer, "bodies_applied", size, || {
                observer.bodies_applied(&doc_ids)
            });
        })
        .await;
    }

    /// Tells every observer that the body step settled, on `spawn_blocking`.
    pub async fn bodies_settled(&self) {
        self.each("bodies_settled", |observer| {
            guarded(observer, "bodies_settled", 0, || observer.bodies_settled());
        })
        .await;
    }

    /// Tells every observer each corrupt record, then its quarantine, on
    /// `spawn_blocking`.
    pub async fn corrupt(&self, items: Vec<CorruptItem>) {
        if items.is_empty() {
            return;
        }
        let size = items.len();
        self.each("corrupt", move |observer| {
            for item in &items {
                guarded(observer, "item_corrupt", size, || {
                    observer.item_corrupt(item)
                });
                if let Some(warning) = &item.warning {
                    guarded(observer, "security_warning", size, || {
                        observer.security_warning(warning)
                    });
                }
            }
        })
        .await;
    }

    /// Tells every observer each corrupt row a refetch applied, on
    /// `spawn_blocking`.
    pub async fn recovered(&self, records: Vec<AppliedRecord>) {
        if records.is_empty() {
            return;
        }
        let size = records.len();
        self.each("recovered", move |observer| {
            for record in &records {
                guarded(observer, "item_recovered", size, || {
                    observer.item_recovered(record)
                });
            }
        })
        .await;
    }

    async fn each(&self, what: &'static str, call: impl Fn(&dyn ApplyObserver) + Send + 'static) {
        let observers = self.snapshot();
        if observers.is_empty() {
            return;
        }
        let joined = tokio::task::spawn_blocking(move || {
            for observer in &observers {
                call(observer.as_ref());
            }
        })
        .await;
        if let Err(error) = joined {
            eprintln!("memry-core: the sync observers' {what} task failed: {error}");
        }
    }
}

/// Runs one observer method: a panic is logged and stops only this call, and
/// a call slower than [`SLOW_CALL`] is logged.
fn guarded(observer: &dyn ApplyObserver, method: &str, size: usize, call: impl FnOnce()) {
    let started = Instant::now();
    if catch_unwind(AssertUnwindSafe(call)).is_err() {
        eprintln!(
            "memry-core: sync observer `{}` panicked in {method} over {size} item(s); \
             the rest still runs",
            observer.name()
        );
    }
    let took = started.elapsed();
    if took > SLOW_CALL {
        eprintln!(
            "memry-core: sync observer `{}` took {took:?} in {method} over {size} item(s), \
             holding the sync pass",
            observer.name()
        );
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

        fn note_revived(&self, note_id: &str) {
            self.seen.lock().unwrap().push(format!("revived {note_id}"));
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
            title_before: None,
        }
    }

    fn page(records: Vec<AppliedRecord>) -> AppliedFeed {
        AppliedFeed {
            records,
            ..AppliedFeed::default()
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_panic_stops_one_call_not_the_observers_next_method_or_the_next_observer() {
        let observers = Observers::default();
        let broken = recording("broken", true);
        let after = recording("after", false);
        observers.register(broken.clone());
        observers.register(after.clone());

        let mut feed = page(vec![record("t1"), record("t2")]);
        feed.revived_notes.push("n0".into());
        observers.applied(feed).await;
        observers.bodies_applied(vec!["n1".into()]).await;
        assert_eq!(*broken.seen.lock().unwrap(), ["revived n0"]);
        assert_eq!(
            *after.seen.lock().unwrap(),
            ["t1", "t2", "revived n0", "n1"]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_empty_page_tells_no_one_and_order_is_registration_order() {
        let observers = Observers::default();
        let first = recording("first", false);
        observers.register(first.clone());
        observers.applied(AppliedFeed::default()).await;
        assert!(first.seen.lock().unwrap().is_empty());

        let second = recording("second", false);
        observers.register(second.clone());
        observers.applied(page(vec![record("t1")])).await;
        assert_eq!(*first.seen.lock().unwrap(), ["t1"]);
        assert_eq!(*second.seen.lock().unwrap(), ["t1"]);
    }
}
