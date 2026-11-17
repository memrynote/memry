//! The desktop driver's snapshot gate reads the pull of the pass it runs in
//! (chapter 07 §7.13.2 condition 1, Step 17 L6a, #3534), on `driver_fakes`'s
//! server.
//!
//! A snapshot makes the server drop the updates at or below its watermark, so
//! one sent after a pull that left part of the feed unread can drop a peer's
//! update this device never applied. Both snapshot paths are covered: the push
//! wave's fallback for an update too large for the incremental route, and the
//! due snapshots a pass ends with.

use crate::driver_fakes::Desktop;

use memry_core::crdt::{BODY_FRAGMENT, update_log};
use memry_core::storage::Db;
use memry_core::sync::engine::MAX_PAGES_PER_PASS;
use memry_core::sync::outbox::{self, Change};
use yrs::{ReadTxn as _, StateVector, Transact as _, XmlFragment as _, XmlTextPrelim};

/// One body update of `doc_id` carrying `text`, as the local edit path writes
/// it: the update log row and the outbox row commit together.
fn queue_body_update(db: &Db, doc_id: &str, text: &str) {
    let author = yrs::Doc::with_client_id(1);
    let fragment = author.get_or_insert_xml_fragment(BODY_FRAGMENT);
    fragment.push_back(&mut author.transact_mut(), XmlTextPrelim::new(text));
    let update = author
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let doc_id = doc_id.to_owned();
    db.call_blocking(move |conn| {
        outbox::commit(
            conn,
            &Change::crdt_update("note", &doc_id, update.clone()),
            1,
            |tx| {
                update_log::append_local_update_in(tx, &doc_id, &update, 1).map_err(|error| {
                    memry_core::api::errors::StorageError::Failed {
                        what: error.to_string(),
                    }
                })
            },
        )?;
        Ok(())
    })
    .expect("queue the update");
}

/// `chars` printable characters a deflate cannot do much with.
fn noisy_text(chars: usize) -> String {
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    (0..chars)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            char::from(b' ' + ((state >> 33) % 95) as u8)
        })
        .collect()
}

/// Feed pages enough that the next pass stops at its page cap, unread.
fn feed_past_the_page_cap(desktop: &Desktop) {
    for page in 0..=MAX_PAGES_PER_PASS {
        desktop
            .server
            .deleted_page(&[], &format!("cursor-{page}"), true);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn snapshots_sent(desktop: &Desktop) -> usize {
    desktop.server.count("/sync/crdt/snapshot") + desktop.server.count("/sync/crdt/snapshot/batch")
}

#[tokio::test]
async fn the_fallback_gate_reads_this_passs_pull() {
    let desktop = Desktop::open(&["note"], |_| Ok(())).await;
    let clean = desktop.pass().await;
    assert!(!clean.pull.has_more, "the first pass reads the whole feed");

    queue_body_update(&desktop.db, "bigdoc000001", &noisy_text(1_500_000));
    feed_past_the_page_cap(&desktop);
    let pass = desktop.pass().await;

    assert!(pass.pull.has_more, "this pass left the feed unread");
    assert_eq!(
        snapshots_sent(&desktop),
        0,
        "no snapshot after an unread feed"
    );
    let depth = desktop
        .db
        .call_blocking(|conn| outbox::depth(conn))
        .unwrap();
    assert_eq!(depth, 1, "the large update waits, unacked");
}

#[tokio::test]
async fn a_clean_waves_oversize_update_goes_out_as_a_snapshot() {
    let desktop = Desktop::open(&["note"], |_| Ok(())).await;
    assert!(!desktop.pass().await.pull.has_more);

    queue_body_update(&desktop.db, "bigdoc000001", &noisy_text(1_500_000));
    let pass = desktop.pass().await;

    assert!(!pass.pull.has_more, "this pass read the whole feed");
    assert!(
        snapshots_sent(&desktop) >= 1,
        "the fallback sent a snapshot"
    );
    let depth = desktop
        .db
        .call_blocking(|conn| outbox::depth(conn))
        .unwrap();
    assert_eq!(depth, 0, "the snapshot acked the large update");
}

#[tokio::test]
async fn a_due_snapshot_after_an_unread_feed_stays_requested() {
    let desktop = Desktop::open(&["note"], |_| Ok(())).await;
    queue_body_update(&desktop.db, "doc000000001", "an edit");
    desktop.pass().await;
    assert_eq!(
        desktop.server.count("/sync/crdt/updates"),
        1,
        "the update was stored"
    );

    feed_past_the_page_cap(&desktop);
    assert!(desktop.pass().await.pull.has_more);
    let later = now_ms() + 300_000;
    assert!(desktop.driver.snapshots_due(later));
    let round = desktop.driver.push_due_snapshots(later).await;

    assert_eq!((round.pushed, round.requeued, round.dropped), (0, 1, 0));
    assert_eq!(snapshots_sent(&desktop), 0);
    assert!(desktop.driver.snapshots_due(later + 300_000), "asked again");
}
