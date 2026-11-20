//! After the body pack phase, the route pass pulls only what the packs did
//! not bring, and pulls it through the batch route (#5293, #5232).
//!
//! Real `HttpClient`, SQLite, `yrs`, §4.12 crypto, pack reader and spill. The
//! fake is the `Transport` (`body_pack_server`).

mod body_pack_server;

use body_pack_server::{
    BodyPack, NOW_MS, Routes, Server, ServerDoc, first_sync, holds_exactly, is_owed,
    snapshot_items, update_items, update_seqs,
};
use serde_json::{Value as Json, json};

const SNAPSHOT_GET: &str = "/sync/crdt/snapshot/";
const UPDATES_GET: &str = "/sync/crdt/updates?note_id";
const BATCH: &str = "/sync/crdt/updates/batch";

/// A snapshot pushed with no update rows sits at `sequenceNum` 0. Its packed
/// copy, confirmed by the manifest, is the whole body: the document is
/// settled with no route request. The same shape outside every pack still
/// takes its snapshot GET.
#[tokio::test]
async fn a_packed_snapshot_at_sequence_zero_settles_without_a_route_request() {
    let (db, dir) = body_pack_server::scratch("snapshot-zero");
    let packed = ServerDoc::new("zeropacked01", 3).snapshot_only();
    let unpacked = ServerDoc::new("zerorouted01", 2).snapshot_only();
    let packs = vec![BodyPack::new("s1", snapshot_items(&[&packed]))];
    let mut server = Server::new(vec![packed, unpacked], packs);
    server.records = true;
    let routes = Routes::new(server);

    let report = first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert_eq!(report.body_packs.settled, 1, "{:?}", report.body_packs);
    let snapshot_gets: Vec<String> = routes
        .calls()
        .into_iter()
        .filter(|call| call.contains(SNAPSHOT_GET))
        .collect();
    assert_eq!(
        snapshot_gets.len(),
        1,
        "only the unpacked document takes its snapshot GET: {snapshot_gets:?}"
    );
    assert!(snapshot_gets[0].contains("zerorouted01"));
    assert_eq!(routes.count("note_id=zeropacked01"), 0);
    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc("zeropacked01"), 3);
    holds_exactly(&db, server.doc("zerorouted01"), 2);
    assert!(!is_owed(&db, "zeropacked01"));
    assert!(!is_owed(&db, "zerorouted01"));
}

/// Zero loss for the `sequenceNum` 0 rule: a packed snapshot at watermark 0
/// with updates 1 and 2 on the server that no pack holds. The device ends
/// with every edit and both update rows, pulled through the batch route.
#[tokio::test]
async fn a_packed_snapshot_at_sequence_zero_still_pulls_the_updates_after_it() {
    let (db, dir) = body_pack_server::scratch("snapshot-zero-later");
    let doc = ServerDoc::new("zerolater001", 5).snapshot_zero_then_updates(3);
    let packs = vec![BodyPack::new("s1", snapshot_items(&[&doc]))];
    let mut server = Server::new(vec![doc], packs);
    server.records = true;
    let routes = Routes::new(server);

    first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert_eq!(routes.count(BATCH), 1, "{:?}", routes.calls());
    let server = routes.server.lock().unwrap();
    assert_eq!(server.doc("zerolater001").expected_updates(), vec![1, 2]);
    holds_exactly(&db, server.doc("zerolater001"), 5);
    assert!(!is_owed(&db, "zerolater001"));
}

/// The owed documents that need no baseline come from the batch answer
/// itself: a document no pack holds and that has no server snapshot, one
/// with updates past its packs, and one with no body at all. One batch
/// request, and no per-document GET.
#[tokio::test]
async fn owed_documents_without_a_baseline_due_are_served_by_one_batch() {
    let (db, dir) = body_pack_server::scratch("route-batch");
    let edited = ServerDoc::new("editeddoc001", 5).snapshot_at(2);
    let packed_part = ServerDoc::new("editeddoc001", 3).snapshot_at(2);
    let fresh = ServerDoc::new("freshdoc0001", 3);
    let empty = ServerDoc::new("emptydoc0001", 0);
    let packs = vec![
        BodyPack::new("s1", snapshot_items(&[&packed_part])),
        BodyPack::new("u1", update_items(&[&packed_part])),
    ];
    let mut server = Server::new(vec![edited, fresh, empty], packs);
    server.records = true;
    let routes = Routes::new(server);

    let report = first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert_eq!(report.body_packs.owed, 3, "{:?}", report.body_packs);
    assert_eq!(routes.count(SNAPSHOT_GET), 0, "{:?}", routes.calls());
    assert_eq!(routes.count(UPDATES_GET), 0, "{:?}", routes.calls());
    assert_eq!(routes.count(BATCH), 1, "{:?}", routes.calls());
    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc("editeddoc001"), 5);
    holds_exactly(&db, server.doc("freshdoc0001"), 3);
    holds_exactly(&db, server.doc("emptydoc0001"), 0);
    for id in ["editeddoc001", "freshdoc0001", "emptydoc0001"] {
        assert!(!is_owed(&db, id), "{id} is settled");
    }
}

const MALFORMED: &str = "maldoc000001";

/// A batch answer whose entry for the document is rewritten: it must not
/// stand in for the updates GET, so the device still ends with the server's
/// body exactly (REVIEW-5303).
async fn pulls_whole_despite(doc: ServerDoc, rewrite: fn(&mut Json)) {
    let (db, dir) = body_pack_server::scratch("malformed-batch");
    let edits = doc.updates.len() as i64 + doc.floor;
    let mut server = Server::new(vec![doc], vec![]);
    server.records = true;
    server.batch_rewrite = Some(rewrite);
    let routes = Routes::new(server);

    first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc(MALFORMED), edits);
    assert!(!is_owed(&db, MALFORMED));
}

#[tokio::test]
async fn a_batch_entry_without_updates_is_not_a_page() {
    pulls_whole_despite(ServerDoc::new(MALFORMED, 3), |body| {
        body["notes"][MALFORMED] = json!({});
    })
    .await;
}

#[tokio::test]
async fn a_batch_entry_whose_updates_are_not_an_array_is_not_a_page() {
    pulls_whole_despite(ServerDoc::new(MALFORMED, 3), |body| {
        body["notes"][MALFORMED] = json!({"updates": "x", "hasMore": false, "floor": 0});
    })
    .await;
}

#[tokio::test]
async fn a_batch_entry_with_an_unreadable_update_is_not_a_page() {
    pulls_whole_despite(ServerDoc::new(MALFORMED, 3), |body| {
        body["notes"][MALFORMED]["updates"][0]
            .as_object_mut()
            .unwrap()
            .remove("data");
    })
    .await;
}

/// The log is purged through the snapshot, and the answer omits that
/// snapshot: a floor above `since` with no snapshot meta is not trusted.
#[tokio::test]
async fn a_floor_above_since_with_no_snapshot_meta_is_not_trusted() {
    let doc = ServerDoc::new(MALFORMED, 3)
        .snapshot_at(2)
        .purged_through(2);
    pulls_whole_despite(doc, |body| {
        body["snapshotMeta"]
            .as_object_mut()
            .unwrap()
            .remove(MALFORMED);
    })
    .await;
}

/// Staging #5232: 27 snapshot-only documents whose snapshots no pack holds
/// (a `created_at` tie remainder the builder served item by item). Each
/// takes its snapshot GET, and the batch answer is its updates page: no
/// `updates?note_id=` GET follows the baseline.
#[tokio::test]
async fn an_unpacked_snapshot_takes_its_get_and_the_batch_page_is_its_updates() {
    let (db, dir) = body_pack_server::scratch("unpacked-snapshots");
    let packed: Vec<ServerDoc> = (0..3)
        .map(|i| ServerDoc::new(&format!("tiepacked{i:03}"), 2).snapshot_only())
        .collect();
    let unpacked: Vec<ServerDoc> = (0..27)
        .map(|i| ServerDoc::new(&format!("tieremain{i:03}"), 2).snapshot_only())
        .collect();
    let edited = ServerDoc::new("tieedited001", 5).snapshot_at(2);
    let packs = vec![BodyPack::new(
        "s1",
        snapshot_items(&packed.iter().collect::<Vec<_>>()),
    )];
    let docs = packed.into_iter().chain(unpacked).chain([edited]).collect();
    let mut server = Server::new(docs, packs);
    server.records = true;
    let routes = Routes::new(server);

    first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert_eq!(routes.count(SNAPSHOT_GET), 28, "{:?}", routes.calls());
    assert_eq!(routes.count(UPDATES_GET), 0, "{:?}", routes.calls());
    assert_eq!(routes.count(BATCH), 1, "{:?}", routes.calls());
    let server = routes.server.lock().unwrap();
    for i in 0..27 {
        let id = format!("tieremain{i:03}");
        holds_exactly(&db, server.doc(&id), 2);
        assert!(!is_owed(&db, &id), "{id} is settled");
    }
    holds_exactly(&db, server.doc("tieedited001"), 5);
    assert_eq!(update_seqs(&db, "tieedited001"), vec![3, 4, 5]);
    assert!(!is_owed(&db, "tieedited001"));
}

/// The batch page starts below an unpacked snapshot taken after it, and
/// stops at the page limit: its rows at or under the snapshot are replays,
/// and the pull goes on from the snapshot with every update after it.
#[tokio::test]
async fn a_batch_page_below_the_baseline_continues_from_the_snapshot() {
    let (db, dir) = body_pack_server::scratch("page-below-baseline");
    let doc = ServerDoc::new("longdoc00001", 150).snapshot_at(120);
    let mut server = Server::new(vec![doc], vec![]);
    server.records = true;
    let routes = Routes::new(server);

    first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert_eq!(routes.count(SNAPSHOT_GET), 1, "{:?}", routes.calls());
    let pages: Vec<String> = routes
        .calls()
        .into_iter()
        .filter(|call| call.contains(UPDATES_GET))
        .collect();
    assert_eq!(pages.len(), 1, "{pages:?}");
    assert!(pages[0].contains("since=120"), "{pages:?}");
    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc("longdoc00001"), 150);
    assert_eq!(
        update_seqs(&db, "longdoc00001"),
        (121..=150).collect::<Vec<_>>()
    );
    assert!(!is_owed(&db, "longdoc00001"));
}

/// Deleted and re-created under the same id between the probe and the
/// snapshot GET: the old log is purged through 5 with no snapshot, and the
/// new incarnation's rows are 6 and 7.
fn recreate(server: &mut Server) {
    let at = server
        .docs
        .iter()
        .position(|doc| doc.id == "recreated001")
        .unwrap();
    let mut doc = ServerDoc::new("recreated001", 7).purged_through(5);
    doc.snapshot = None;
    server.docs[at] = doc;
}

/// REVIEW-5311 q6: a baseline was due, and the GET finds no snapshot. The
/// probe page belongs to the purged incarnation, so it is not applied; the
/// pull pages afresh and stores only the new incarnation's rows.
#[tokio::test]
async fn a_baseline_due_but_gone_at_the_get_does_not_apply_the_probe_page() {
    let (db, dir) = body_pack_server::scratch("baseline-gone");
    let mut server = Server::new(
        vec![ServerDoc::new("recreated001", 5).snapshot_at(2)],
        vec![],
    );
    server.records = true;
    server.before.push((SNAPSHOT_GET.to_owned(), recreate));
    let routes = Routes::new(server);

    first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert_eq!(update_seqs(&db, "recreated001"), vec![6, 7]);
}
