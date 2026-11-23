//! A fresh device's first sync whose body reads meet a 429 (#5570). A note
//! whose server body is empty holds no body rows, so the body manifest lists
//! none of them and the bodies pass probes them in batches.
//!
//! Real `HttpClient`, SQLite, pack reader and `yrs`; the transport is the body
//! pack test server.

use crate::body_pack_server;

use body_pack_server::{
    BodyPack, NOW_MS, Routes, Server, ServerDoc, cursor_of, first_sync, is_owed, scratch,
    update_items,
};
use memry_core::sync::body_pull::MAX_RATE_LIMIT_PAUSES;
use memry_core::sync::first_sync::FirstSyncLimits;

/// More than one probe chunk (100), so the bodies pass sends two probes.
const EMPTY: usize = 150;

/// A 429 on the batch probe is waited out, not answered with a route pull of
/// every empty-body document. Red before #5570: the probe treated the 429 as
/// "no batch route", and each document cost a snapshot GET and an updates GET
/// (one bench run: 310 documents, 620 requests, t_bodies 153.7 s).
#[tokio::test(flavor = "multi_thread")]
async fn a_rate_limited_probe_is_waited_out_and_no_empty_body_is_route_pulled() {
    let (db, dir) = scratch("first-sync-empty-bodies");
    let full = ServerDoc::new("fulldoc00001", 3);
    let mut docs = vec![full.clone()];
    let empties: Vec<String> = (0..EMPTY).map(|n| format!("empty{n:07}")).collect();
    docs.extend(empties.iter().map(|id| ServerDoc::new(id, 0)));
    let packs = vec![BodyPack::new("u1", update_items(&[&full]))];
    let mut server = Server::new(docs, packs);
    server.records = true;
    server.batch_rate_limits = 1;
    let routes = Routes::new(server);

    let report = first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert!(report.body_packs.ran, "{:?}", report.body_packs);
    assert_eq!(routes.count("/sync/crdt/snapshot/"), 0, "no snapshot GET");
    assert_eq!(routes.count("/sync/crdt/updates?"), 0, "no updates GET");
    // Two chunks, and the one refused asked again.
    assert_eq!(routes.count("/sync/crdt/updates/batch"), 3);
    for id in &empties {
        assert!(
            !is_owed(&db, id),
            "{id} is settled, so no later pass pulls it"
        );
        assert_eq!(cursor_of(&db, id), Some(0), "{id} holds its empty body");
    }
}

/// A 429 on a body manifest page is waited out and the page asked again. Red
/// before #5570: the read stopped short, so the phase checked every document
/// through the batch route, proved none current and route-pulled each one (a
/// second bench run inside the same minute: 623 snapshot GETs, about an hour).
#[tokio::test(flavor = "multi_thread")]
async fn a_rate_limited_manifest_page_is_waited_out_and_nothing_is_route_pulled() {
    let (db, dir) = scratch("first-sync-manifest-429");
    let docs: Vec<ServerDoc> = (0..3)
        .map(|n| ServerDoc::new(&format!("fulldoc{n:05}"), 3))
        .collect();
    let packs = vec![BodyPack::new(
        "u1",
        update_items(&docs.iter().collect::<Vec<_>>()),
    )];
    let mut server = Server::new(docs, packs);
    server.records = true;
    server.manifest_page = 1;
    server.manifest_rate_limits = 1;
    let routes = Routes::new(server);

    let report = first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    let packs = report.body_packs;
    assert!(packs.manifest, "the manifest was read whole: {packs:?}");
    assert_eq!((packs.settled, packs.owed), (3, 0), "{packs:?}");
    assert_eq!(routes.count("/sync/crdt/snapshot/"), 0, "no snapshot GET");
    assert_eq!(routes.count("/sync/crdt/updates?"), 0, "no updates GET");
}

/// `n` documents whose server body is empty.
fn empty_docs(n: usize) -> Vec<ServerDoc> {
    (0..n)
        .map(|n| ServerDoc::new(&format!("empty{n:07}"), 0))
        .collect()
}

/// A server refusing every body read holds the bodies pass for one budget of
/// [`MAX_RATE_LIMIT_PAUSES`] waits, the probes and the document pulls together
/// (#5423). Red before: each probe chunk waited out two 429s of its own,
/// outside the pass's eight, so a window of `n` chunks waited `2n + 8` times.
#[tokio::test(start_paused = true)]
async fn a_server_refusing_every_body_read_holds_the_pass_for_one_pause_budget() {
    let (db, dir) = scratch("first-sync-refused-bodies");
    let mut server = Server::new(empty_docs(EMPTY), Vec::new());
    server.records = true;
    server.batch_rate_limits = usize::MAX;
    server.snapshot_rate_limits = usize::MAX;
    let routes = Routes::new(server);

    first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect_err("every body read is refused");

    // Three reads give up, each on one refused request: the two probe chunks
    // and the one document pull. Every other request followed a wait.
    let refused = routes.count("/sync/crdt/updates/batch") + routes.count("/sync/crdt/snapshot/");
    assert!(
        refused <= 3 + MAX_RATE_LIMIT_PAUSES as usize,
        "{refused} refused requests"
    );
}

/// A bucket that refills is waited out however many windows the probes take
/// (#5423): the budget counts 429s in a row, so pacing like the unelevated
/// thirty batch requests a minute never runs it out, and no chunk falls back
/// to a route pull per document.
#[tokio::test(start_paused = true)]
async fn a_refilling_bucket_is_waited_out_past_the_pause_budget() {
    let chunks = MAX_RATE_LIMIT_PAUSES as usize + 1;
    let (db, dir) = scratch("first-sync-refilling-bucket");
    let mut server = Server::new(empty_docs(chunks * 100), Vec::new());
    server.records = true;
    server.batch_refused_once_each = true;
    let routes = Routes::new(server);

    first_sync(&db, &routes, &dir)
        .with_limits(FirstSyncLimits::ALL)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert_eq!(routes.count("/sync/crdt/updates/batch"), 2 * chunks);
    assert_eq!(routes.count("/sync/crdt/snapshot/"), 0, "no snapshot GET");
    assert_eq!(routes.count("/sync/crdt/updates?"), 0, "no updates GET");
}
