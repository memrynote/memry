//! A search reindex lets go of the `data.db` writer between batches (#5417).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use super::Search;
use crate::api::errors::StorageError;
use crate::domain::search::{BATCH_NOTES, LinkChanges};
use crate::storage::Db;
use crate::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use crate::storage::repositories::sync_items::{self, InboundRecord};

const NOW: i64 = 1_700_000_000_000;

fn search_over(notes: usize) -> Search {
    let data = Db::open_in_memory().expect("data.db");
    let index = Db::open_in_memory().expect("index.db");
    data.call_blocking(|conn| {
        migrations::run(conn, DATA_MIGRATIONS)?;
        for n in 0..notes {
            let record = InboundRecord {
                item_type: "note".to_owned(),
                item_id: format!("note-{n:05}"),
                payload_json: format!(r#"{{"title":"Alpha {n}"}}"#),
                server_cursor: Some(1),
                signer_device_id: Some("device-a".to_owned()),
                updated_at: NOW,
                deleted_at: None,
            };
            sync_items::apply_remote(conn, &record, NOW)?;
        }
        Ok(())
    })
    .expect("seed data.db");
    index
        .call_blocking(|conn| migrations::run(conn, INDEX_MIGRATIONS).map(drop))
        .expect("index migrations");
    Search { data, index }
}

/// Before #5417 a full reindex held the `data.db` writer for the whole pass: a writer that
/// asked during the first note got it after the last. Now it gets it when the batch it waited
/// behind commits.
#[test]
fn a_writer_waiting_on_a_full_reindex_gets_the_lock_within_one_batch() {
    let total = BATCH_NOTES * 5;
    let search = search_over(total);
    let reached = Arc::new(AtomicUsize::new(0));
    let (asked, ask) = mpsc::channel::<()>();
    let writer = {
        let data = search.data.clone();
        let reached = reached.clone();
        std::thread::spawn(move || {
            ask.recv().expect("the reindex started");
            data.call_blocking(|_| Ok(reached.load(Ordering::SeqCst)))
                .expect("the writer")
        })
    };
    let stop = || {
        if reached.fetch_add(1, Ordering::SeqCst) == 0 {
            asked.send(()).expect("the writer listens");
            // Ordering only: the writer is blocked on the lock before the first batch ends.
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    };
    assert!(
        search
            .reindex_until(&stop, &mut LinkChanges::default())
            .expect("reindex"),
        "not stopped"
    );
    let got_it_after = writer.join().expect("the writer thread");
    assert!(
        got_it_after <= BATCH_NOTES,
        "the writer waited for {got_it_after} of {total} notes, more than one batch"
    );
    let rows = search
        .index
        .read_blocking(|index| {
            index
                .query_row("SELECT count(*) FROM fts_notes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("count");
    assert_eq!(rows as usize, total, "the index is complete");
}

/// Runs once, on the reindex thread, when the `index.db` connection starts its next COMMIT.
static ON_INDEX_COMMIT: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> =
    std::sync::Mutex::new(None);

fn on_index_commit(event: rusqlite::trace::TraceEvent<'_>) {
    if let rusqlite::trace::TraceEvent::Stmt(_, sql) = event
        && sql == "COMMIT"
        && let Some(hook) = ON_INDEX_COMMIT.lock().expect("the hook").take()
    {
        hook();
    }
}

/// #5468: a batch committed `index.db` while it still held the `data.db` writer, so a save or
/// the vault write-back waited on the search-index commit once per batch. A `data.db` writer
/// that asks while the index commit runs now gets the lock before that commit ends.
#[test]
fn a_data_writer_does_not_wait_on_a_batch_index_commit() {
    let search = search_over(10);
    search
        .index
        .call_blocking(|index| {
            index.trace_v2(
                rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
                Some(on_index_commit),
            );
            Ok(())
        })
        .expect("trace index.db");
    let (got, during) = mpsc::channel::<()>();
    let writer = Arc::new(std::sync::Mutex::new(None));
    let got_lock = Arc::new(std::sync::Mutex::new(None));
    {
        let data = search.data.clone();
        let writer = Arc::clone(&writer);
        let got_lock = Arc::clone(&got_lock);
        *ON_INDEX_COMMIT.lock().expect("the hook") = Some(Box::new(move || {
            *writer.lock().expect("writer slot") = Some(std::thread::spawn(move || {
                data.call_blocking(|_| Ok(())).expect("the writer");
                let _ = got.send(());
            }));
            // Expiry fails the test: the writer is still blocked when the index commit goes on.
            *got_lock.lock().expect("result slot") =
                Some(during.recv_timeout(Duration::from_secs(10)).is_ok());
        }));
    }
    assert!(
        search
            .reindex_until(&|| false, &mut LinkChanges::default())
            .expect("reindex"),
        "not stopped"
    );
    search
        .index
        .call_blocking(|index| {
            index.trace_v2(rusqlite::trace::TraceEventCodes::empty(), None);
            Ok(())
        })
        .expect("untrace");
    if let Some(writer) = writer.lock().expect("writer slot").take() {
        writer.join().expect("the writer thread");
    }
    assert_eq!(
        *got_lock.lock().expect("result slot"),
        Some(true),
        "the data.db writer waited for the batch's index.db commit"
    );
}

/// Runs once, on the reindex thread, when the `data.db` connection starts its next COMMIT.
static ON_DATA_COMMIT: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> =
    std::sync::Mutex::new(None);

fn on_data_commit(event: rusqlite::trace::TraceEvent<'_>) {
    if let rusqlite::trace::TraceEvent::Stmt(_, sql) = event
        && sql == "COMMIT"
        && let Some(hook) = ON_DATA_COMMIT.lock().expect("the hook").take()
    {
        hook();
    }
}

/// REVIEW-5503 finding 1: the batch's `index.db` writer stayed held through the rest between
/// batches, so a write that takes `data.db` then `index.db` (an editor save, a file-text
/// refresh) got `data.db` in the rest and then waited on `index.db` while holding it. A writer
/// that queues behind a batch's `data.db` commit now finishes during the rest.
#[test]
fn a_data_then_index_writer_finishes_during_the_rest_between_batches() {
    let search = search_over(BATCH_NOTES * 2);
    search
        .data
        .call_blocking(|data| {
            data.trace_v2(
                rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
                Some(on_data_commit),
            );
            Ok(())
        })
        .expect("trace data.db");
    let (finished, writer_done) = mpsc::channel::<()>();
    let writer = Arc::new(std::sync::Mutex::new(None));
    let queued = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let result = Arc::new(std::sync::Mutex::new(None));
    let hook = {
        let (data, index) = (search.data.clone(), search.index.clone());
        let (writer, queued) = (Arc::clone(&writer), Arc::clone(&queued));
        move || {
            let waiting = data.clone();
            *writer.lock().expect("writer slot") = Some(std::thread::spawn(move || {
                data.call_blocking(|_| index.call_blocking(|_| Ok(())))
                    .expect("the save");
                let _ = finished.send(());
            }));
            // The save queues on data.db before the batch lets go, so the batch rests after.
            while waiting.writers_waiting() == 0 {
                std::thread::yield_now();
            }
            queued.store(true, Ordering::SeqCst);
        }
    };
    let hook = std::sync::Mutex::new(Some(hook));
    let stop = || {
        // The first stop is at the first row, after the names were settled: arm the hook
        // for the batch's data.db commit. No row runs between that commit and the rest.
        if let Some(hook) = hook.lock().expect("the hook").take() {
            *ON_DATA_COMMIT.lock().expect("the hook") = Some(Box::new(hook));
        } else if queued.swap(false, Ordering::SeqCst) {
            // In the rest. Expiry fails the test: the save is blocked on index.db.
            *result.lock().expect("result slot") =
                Some(writer_done.recv_timeout(Duration::from_secs(10)).is_ok());
        }
        false
    };
    assert!(
        search
            .reindex_until(&stop, &mut LinkChanges::default())
            .expect("reindex"),
        "not stopped"
    );
    search
        .data
        .call_blocking(|data| {
            data.trace_v2(rusqlite::trace::TraceEventCodes::empty(), None);
            Ok(())
        })
        .expect("untrace");
    if let Some(writer) = writer.lock().expect("writer slot").take() {
        writer.join().expect("the save thread");
    }
    assert_eq!(
        *result.lock().expect("result slot"),
        Some(true),
        "a data.db -> index.db writer waited on the index.db writer through the rest"
    );
}

static INTERRUPT_INDEX_COMMIT: std::sync::Mutex<Option<(usize, rusqlite::InterruptHandle)>> =
    std::sync::Mutex::new(None);

/// Interrupts the `index.db` COMMIT counted down to by the slot, which fails it.
fn interrupt_index_commit(event: rusqlite::trace::TraceEvent<'_>) {
    if let rusqlite::trace::TraceEvent::Stmt(_, sql) = event
        && sql == "COMMIT"
    {
        let mut slot = INTERRUPT_INDEX_COMMIT.lock().expect("the slot");
        if let Some((left, _)) = slot.as_mut()
            && *left > 0
        {
            *left -= 1;
        } else if let Some((_, handle)) = slot.take() {
            handle.interrupt();
        }
    }
}

fn fts_counts(search: &Search) -> (i64, i64) {
    search
        .index
        .read_blocking(|index| {
            index
                .query_row(
                    "SELECT count(*), count(DISTINCT id) FROM fts_notes",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("count")
}

/// #5468: `data.db` now commits and lets go before `index.db` commits. A batch whose index
/// commit fails after its `data.db` commit (a crash between the two) ends the pass with an
/// error and leaves the index at its last committed batch; the next pass indexes the rest
/// from `data.db`, every note once.
#[test]
fn a_lost_index_commit_after_the_data_commit_is_redone_by_the_next_pass() {
    let total = BATCH_NOTES + 50;
    let search = search_over(total);
    search
        .index
        .call_blocking(|index| {
            index.trace_v2(
                rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
                Some(interrupt_index_commit),
            );
            // The first batch commits; the second batch's index commit fails.
            *INTERRUPT_INDEX_COMMIT.lock().expect("the slot") =
                Some((1, index.get_interrupt_handle()));
            Ok(())
        })
        .expect("trace index.db");
    assert!(
        search
            .reindex_until(&|| false, &mut LinkChanges::default())
            .is_err(),
        "the interrupted index commit fails the pass"
    );
    search
        .index
        .call_blocking(|index| {
            index.trace_v2(rusqlite::trace::TraceEventCodes::empty(), None);
            Ok(())
        })
        .expect("untrace");
    // Batches are time-boxed too, so the first one's size is not fixed.
    let (rows, ids) = fts_counts(&search);
    assert!(
        rows == ids && rows > 0 && rows < total as i64,
        "only the first batch is in the index, once: {rows} rows, {ids} ids"
    );
    assert!(
        search
            .reindex_until(&|| false, &mut LinkChanges::default())
            .expect("the next pass"),
        "not stopped"
    );
    assert_eq!(
        fts_counts(&search),
        (total as i64, total as i64),
        "every note indexed once"
    );
}

/// A body whose one paragraph is a wiki link to `target`, as a Yjs update.
fn linking_update(id: &str, target: &str) -> Vec<u8> {
    use crate::crdt::DocumentRegistry;
    use crate::crdt::registry::UpdateSink;
    use yrs::{ReadTxn as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};
    let captured: Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Arc::default();
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    DocumentRegistry::new("device-peer", sink)
        .get_or_open(id)
        .expect("open")
        .write(|txn| {
            let fragment = txn.get_xml_fragment("prosemirror").expect("typed root");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            let link = paragraph.push_back(txn, XmlElementPrelim::empty("wikiLink"));
            link.insert_attribute(txn, "target", target);
            link.push_back(txn, XmlTextPrelim::new(target));
        })
        .expect("write");
    let first = captured.lock().expect("lock").first().cloned();
    first.expect("one update")
}

/// REVIEW-5425 finding 5: a stopped pass dropped the link changes of the batches it committed,
/// so desktop never announced them. They now go to the caller's owed links as batches commit.
#[test]
fn a_stopped_pass_owes_the_links_its_committed_batches_changed() {
    let total = BATCH_NOTES + 50;
    let search = search_over(total);
    let update = linking_update("note-00000", "Alpha 1");
    search
        .data
        .call_blocking(|conn| {
            crate::crdt::update_log::append_server_update(conn, "note-00000", 1, &update, NOW)
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("the body");
    // Past the first batch, before the last note: a later batch rolls back, the first stands.
    let calls = AtomicUsize::new(0);
    let stop = || calls.fetch_add(1, Ordering::SeqCst) > BATCH_NOTES + 10;
    let mut links = LinkChanges::default();
    assert!(
        !search.reindex_until(&stop, &mut links).expect("reindex"),
        "stopped after a batch committed"
    );
    assert!(
        links.sources.contains("note-00000"),
        "the committed batch's link change is owed: {links:?}"
    );
}
