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
