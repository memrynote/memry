//! The manifest check's question before it re-uploads a note (#4785; chapter 05 §5.12.3, §5.15),
//! over the harness of `sync_disk_harness`: a create the server lost goes out again with its
//! body, and a note another device deleted is never brought back by a device that missed the
//! delete.

use std::time::Duration;

use memry_core::storage::repositories::sync_items;
use memry_core::sync::driver::progress::SilentInitialSync;
use memry_core::sync::first_sync::META_FIRST_SYNC_COMPLETED;
use memry_core::sync::outbox;
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};

use super::*;

/// A fresh driver over `peer`'s vault, as after a restart: its first pass checks the manifest.
async fn restarted(server: &Server, peer: &Peer, at: usize) -> SyncDriver {
    driver(&peer.core, &auth(server, at, &peer.store), Vec::new()).await
}

fn deleted(peer: &Peer, id: &str) -> bool {
    let id = id.to_owned();
    let row = peer
        .core
        .db_handle()
        .call_blocking(move |c| sync_items::load(c, "note", &id))
        .unwrap()
        .expect("a row");
    row.deleted_at.is_some()
}

fn queued(peer: &Peer) -> usize {
    peer.core
        .db_handle()
        .call_blocking(|c| outbox::depth(c))
        .unwrap()
}

fn recorded(peer: &Peer, id: &str) -> bool {
    let id = id.to_owned();
    peer.core
        .db_handle()
        .call_blocking(move |c| store::tombstone_clock(c, "note", &id))
        .unwrap()
        .is_some()
}

/// A creates a note, the server loses it, and A's next manifest check asks the server, hears
/// nothing, and queues the note as `create` with a body snapshot: C, a device that never saw it,
/// gets the note and its text. Red without the re-upload: C holds no body.
#[tokio::test(flavor = "multi_thread")]
async fn a_note_create_the_server_lost_reaches_a_second_device() {
    let mut server = Server::start();
    let a = Peer::at(&server, 0).await;
    let id = a.create("Lost plan", None, "kept on A");
    for _ in 0..2 {
        a.sync().await;
    }
    assert_eq!(server.lose(&id), 1, "the server held the note");

    let back = restarted(&server, &a, 0).await;
    for _ in 0..2 {
        pass(&back).await;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let round = back.final_snapshots(deadline).await;
    assert_eq!(round.pushed, 1, "{round:?}");
    assert_eq!(queued(&a), 0);

    let c = Peer::at(&server, 1).await;
    for _ in 0..2 {
        c.sync().await;
    }
    assert!(c.body(&id).contains("kept on A"), "{}", c.body(&id));
}

/// A and B hold a note; A deletes it, and the server sheds the tombstone to a marker. B missed
/// the delete and comes back through `away`, which never serves it the marker, so B's note stays
/// live and the manifest lacks it. B's check asks the server, which answers the marker: B records
/// the delete and queues nothing, and the note stays deleted on A. Red without the question: B
/// re-uploads the note, the server re-creates it over the marker, and A's note is live again.
async fn a_deleted_note_stays_deleted(away: impl AsyncFnOnce(&Server, &Peer) -> SyncDriver) {
    let mut server = Server::start();
    let a = Peer::at(&server, 0).await;
    let b = Peer::at(&server, 1).await;
    let id = a.create("Gone plan", None, "deleted on A");
    for _ in 0..2 {
        a.sync().await;
    }
    for _ in 0..2 {
        b.sync().await;
    }
    assert!(!deleted(&b, &id), "B holds the note");

    a.core
        .notes_writer(a.store.clone())
        .unwrap()
        .delete(id.clone())
        .unwrap();
    a.sync().await;
    assert!(deleted(&a, &id));
    // The shed takes tombstones whose `deleted_at` second has passed.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert_eq!(server.purge(), 1, "the tombstone is a marker now");

    let back = away(&server, &b).await;
    for _ in 0..2 {
        pass(&back).await;
    }
    assert!(
        !deleted(&b, &id),
        "the run from cursor 0 never named the marker"
    );
    assert!(
        recorded(&b, &id),
        "B recorded the delete the server answered"
    );
    assert_eq!(queued(&b), 0, "B queued no create");

    for _ in 0..2 {
        a.sync().await;
    }
    assert!(deleted(&a, &id), "the note came back on A");
}

/// B was away for over a day: its record cursor is reset to 0 (`stale_cursor`).
#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_note_stays_deleted_after_a_run_from_cursor_zero() {
    a_deleted_note_stays_deleted(async |server: &Server, b: &Peer| {
        b.core
            .db_handle()
            .call_blocking(|c| store::write_cursor(c, RECORD_CURSOR_SCOPE, None, 0))
            .unwrap();
        restarted(server, b, 1).await
    })
    .await;
}

/// B's vault holds the note when its first sync runs (an Electron profile moved to this app):
/// the refs pass reads the feed without the marker token.
#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_note_stays_deleted_after_a_first_sync_over_held_rows() {
    a_deleted_note_stays_deleted(async |server: &Server, b: &Peer| {
        b.core
            .db_handle()
            .call_blocking(|c| {
                c.execute(
                    "DELETE FROM meta WHERE key = ?1",
                    [META_FIRST_SYNC_COMPLETED],
                )
                .unwrap();
                store::write_cursor(c, RECORD_CURSOR_SCOPE, None, 0)
            })
            .unwrap();
        let back = restarted(server, b, 1).await;
        assert!(back.needs_first_sync().await.unwrap());
        back.first_sync(Arc::new(SilentInitialSync))
            .await
            .unwrap()
            .expect("not paused");
        back
    })
    .await;
}
