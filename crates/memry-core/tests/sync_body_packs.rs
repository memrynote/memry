//! A fresh device takes its bodies from `crdt_snapshot` and `crdt_update`
//! packs, applying only what a body check read after the pack bytes confirms,
//! and settles or owes every live document (chapter 08 §8.4.3, §8.10, #5232).
//!
//! Real `HttpClient`, SQLite, `yrs`, §4.12 crypto, pack reader and spill. The
//! fake is the `Transport`, answering every route from one server state
//! (`body_pack_server`).

mod body_pack_server;

use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use body_pack_server::{
    BodyPack, MANIFEST_RETRY_AFTER_S, Manifest, NOW_MS, Routes, Server, ServerDoc, bootstrap,
    first_sync, has_snapshot, holds_exactly, is_owed, seed_records, snapshot_item_as,
    snapshot_items, update_item, update_items, update_seqs,
};
use memry_core::storage::Db;
use memry_core::sync::body_pull::MANIFEST_READ_DEADLINE;
use memry_core::sync::first_sync::META_FIRST_SYNC_BODY_PACKS;
use memry_core::sync::first_sync_store::read_meta;
use memry_core::sync::pack_bootstrap::BodyPackReport;
use sha2::{Digest as _, Sha256};

async fn run_bodies(db: &Db, routes: &Arc<Routes>, dir: &Path) -> BodyPackReport {
    bootstrap(db, routes, dir)
        .run_bodies(NOW_MS / 1_000)
        .await
        .expect("the body pack phase")
}

/// Runs `work` until a request hangs and `ready` holds, then drops it: the
/// process was killed. `ready` waits out downloads still running beside the
/// hung one.
async fn killed_while(routes: &Routes, work: impl Future, ready: impl Fn() -> bool) {
    tokio::pin!(work);
    let mut hung = false;
    loop {
        tokio::select! {
            _ = &mut work => panic!("the run finished before the kill"),
            () = routes.hung.notified(), if !hung => hung = true,
            () = tokio::time::sleep(Duration::from_millis(5)) => {}
        }
        if hung && ready() {
            return;
        }
    }
}

/// Whether pack `id` is spilled under its final name.
fn spilled(dir: &Path, id: &str) -> bool {
    let name: String = Sha256::digest(id.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    dir.join("pack-spill").join(format!("{name}.mpak")).exists()
}

/// A snapshot-only document, an updates-only one, and one with both, in one
/// snapshot pack and one update pack.
fn three_shapes() -> (Vec<ServerDoc>, Vec<BodyPack>) {
    let snapshot_only = ServerDoc::new("snaponly0001", 3)
        .snapshot_at(3)
        .purged_through(3);
    let updates_only = ServerDoc::new("updonly00001", 4);
    let both = ServerDoc::new("bothdoc00001", 5).snapshot_at(2);
    let packs = vec![
        BodyPack::new("s1", snapshot_items(&[&snapshot_only, &both])),
        BodyPack::new("u1", update_items(&[&updates_only, &both])),
    ];
    (vec![snapshot_only, updates_only, both], packs)
}

const SHAPES: [(&str, i64); 3] = [
    ("snaponly0001", 3),
    ("updonly00001", 4),
    ("bothdoc00001", 5),
];

fn holds_the_three_shapes(db: &Db, routes: &Routes) {
    let server = routes.server.lock().unwrap();
    for (id, edits) in SHAPES {
        holds_exactly(db, server.doc(id), edits);
    }
}

#[tokio::test]
async fn snapshots_and_updates_confirmed_by_the_manifest_apply_and_settle() {
    let (db, dir) = body_pack_server::scratch("shapes");
    let (docs, packs) = three_shapes();
    seed_records(&db, &SHAPES.map(|(id, _)| id), &[]);
    let routes = Routes::new(Server::new(docs, packs));

    let report = run_bodies(&db, &routes, &dir).await;

    assert!(report.ran && report.manifest, "{report:?}");
    assert_eq!(report.packs_held, 2);
    assert_eq!(report.snapshots_applied, 2);
    // `bothdoc` takes 3..=5 above its snapshot at 2; its 1 and 2 are not used.
    assert_eq!(report.updates_applied, 4 + 3);
    assert_eq!(report.entries_unconfirmed, 2);
    assert_eq!((report.settled, report.owed), (3, 0));
    holds_the_three_shapes(&db, &routes);
    assert!(SHAPES.iter().all(|(id, _)| !is_owed(&db, id)));
    // One listing page, two downloads, one manifest page.
    assert_eq!(routes.calls().len(), 4, "{:?}", routes.calls());
    assert_eq!(report.requests, 4);
    assert!(
        !dir.join("pack-spill").exists(),
        "the spill goes at the end"
    );
}

/// #5374: a drop that outlasts the transport ladder of both pack GETs
/// pauses the phase, and the packs download after it.
#[tokio::test]
async fn body_packs_lost_to_a_network_drop_download_after_the_pause() {
    let (db, dir) = body_pack_server::scratch("drop");
    let (docs, packs) = three_shapes();
    seed_records(&db, &SHAPES.map(|(id, _)| id), &[]);
    let mut server = Server::new(docs, packs);
    server.dropped_gets = 2 * 4;
    let routes = Routes::new(server);

    let report = run_bodies(&db, &routes, &dir).await;

    assert!(
        report.ran && report.fallback_reasons.is_empty(),
        "{report:?}"
    );
    assert_eq!(report.packs_held, 2);
    assert_eq!((report.settled, report.owed), (3, 0));
    holds_the_three_shapes(&db, &routes);
    assert_eq!(routes.slept().iter().filter(|ms| **ms == 30_000).count(), 1);
}

#[tokio::test]
async fn a_purged_then_recreated_document_and_a_deleted_one_take_no_packed_body() {
    let (db, dir) = body_pack_server::scratch("floor");
    // The pack was written before the purge through 3; the server now holds
    // 4 and 5 above floor 3, so a fresh device must take the route baseline.
    let before_purge = ServerDoc::new("recreated001", 5);
    let recreated = before_purge.clone().purged_through(3);
    let deleted = ServerDoc::new("deleted00001", 2).snapshot_at(2);
    let packs = vec![
        BodyPack::new("s1", snapshot_items(&[&deleted])),
        BodyPack::new("u1", update_items(&[&before_purge, &deleted])),
    ];
    seed_records(&db, &["recreated001"], &["deleted00001"]);
    let routes = Routes::new(Server::new(vec![recreated, deleted], packs));

    let report = run_bodies(&db, &routes, &dir).await;

    assert!(report.ran && report.manifest);
    assert_eq!(report.snapshots_applied + report.updates_applied, 0);
    assert!(
        update_seqs(&db, "recreated001").is_empty(),
        "below the floor"
    );
    assert!(is_owed(&db, "recreated001"));
    assert!(!has_snapshot(&db, "deleted00001"), "§8.10: a tombstone");
    assert!(update_seqs(&db, "deleted00001").is_empty());
    assert!(!is_owed(&db, "deleted00001"));
    assert_eq!((report.settled, report.owed), (0, 1));
}

#[tokio::test]
async fn a_revision_mismatch_a_gap_and_conflicting_digests_apply_only_what_is_proven() {
    let (db, dir) = body_pack_server::scratch("disagree");
    let mismatch = ServerDoc::new("mismatch0001", 3).snapshot_at(2);
    let gap = ServerDoc::new("gapdoc000001", 4);
    let conflict = ServerDoc::new("conflict0001", 2);
    let mut gapped = update_items(&[&gap]);
    gapped.retain(|item| item.4.as_ref().unwrap()["sequenceNum"] != 3);
    let packs = vec![
        BodyPack::new("s1", vec![snapshot_item_as(&mismatch, "rev-old")]),
        BodyPack::new(
            "u1",
            [update_items(&[&mismatch, &conflict]), gapped].concat(),
        ),
        // Sequence 1 again, carrying other bytes.
        BodyPack::new(
            "u2",
            vec![update_item("conflict0001", 1, &conflict.updates[&2])],
        ),
    ];
    seed_records(&db, &["mismatch0001", "gapdoc000001", "conflict0001"], &[]);
    let routes = Routes::new(Server::new(vec![mismatch, gap, conflict], packs));

    let report = run_bodies(&db, &routes, &dir).await;

    assert!(report.ran && report.manifest);
    assert!(
        !has_snapshot(&db, "mismatch0001"),
        "not the server's revision"
    );
    assert!(
        update_seqs(&db, "mismatch0001").is_empty(),
        "§7.8: no update follows a snapshot the device does not hold"
    );
    assert_eq!(update_seqs(&db, "gapdoc000001"), [1, 2], "stops at the gap");
    assert!(update_seqs(&db, "conflict0001").is_empty(), "two digests");
    assert_eq!(report.updates_applied, 2);
    assert_eq!((report.settled, report.owed), (0, 3));
}

#[tokio::test]
async fn a_server_without_the_manifest_is_checked_through_the_batch_route() {
    let (db, dir) = body_pack_server::scratch("no-manifest");
    let (docs, packs) = three_shapes();
    seed_records(&db, &SHAPES.map(|(id, _)| id), &[]);
    let mut server = Server::new(docs, packs);
    server.manifest = Manifest::Missing;
    let routes = Routes::new(server);

    let report = run_bodies(&db, &routes, &dir).await;

    assert!(report.ran && !report.manifest);
    assert_eq!(report.snapshots_applied, 2);
    assert_eq!(report.updates_applied, 7);
    holds_the_three_shapes(&db, &routes);
    assert_eq!(routes.count("/sync/crdt/updates/batch"), 1);
    assert_eq!(
        (report.settled, report.owed),
        (0, 3),
        "the batch route answers no head, so nothing is proven current"
    );
}

#[tokio::test]
async fn a_failed_or_malformed_manifest_page_falls_back_to_the_batch_route() {
    for manifest in [
        Manifest::FailsAfterFirstPage,
        Manifest::MalformedAfterFirstPage,
    ] {
        let (db, dir) = body_pack_server::scratch("short-manifest");
        let (docs, packs) = three_shapes();
        seed_records(&db, &SHAPES.map(|(id, _)| id), &[]);
        let mut server = Server::new(docs, packs);
        server.manifest = manifest;
        server.manifest_page = 1;
        let routes = Routes::new(server);

        let report = run_bodies(&db, &routes, &dir).await;

        assert!(report.ran && !report.manifest);
        assert_eq!(routes.count("/sync/crdt/manifest"), 2);
        assert_eq!(routes.count("/sync/crdt/updates/batch"), 1);
        holds_the_three_shapes(&db, &routes);
        assert_eq!((report.settled, report.owed), (0, 3));
    }
}

/// Seventeen documents, one manifest page each, as a 17k-document vault reads
/// in 17 pages (#5349).
fn seventeen_pages() -> (Vec<ServerDoc>, Vec<BodyPack>, Vec<String>) {
    let docs: Vec<ServerDoc> = (0..17)
        .map(|at| ServerDoc::new(&format!("d{at:011}"), 2).snapshot_at(1))
        .collect();
    let refs: Vec<&ServerDoc> = docs.iter().collect();
    let packs = vec![
        BodyPack::new("s1", snapshot_items(&refs)),
        BodyPack::new("u1", update_items(&refs)),
    ];
    let ids = docs.iter().map(|doc| doc.id.clone()).collect();
    (docs, packs, ids)
}

/// Every document settled from the held packs through the manifest: no batch
/// route, nothing owed to the item-granular passes.
fn settled_from_the_packs(db: &Db, routes: &Routes, ids: &[String], report: &BodyPackReport) {
    assert!(report.ran && report.manifest, "{report:?}");
    assert!(report.fallback_reasons.is_empty(), "{report:?}");
    assert_eq!((report.settled, report.owed), (17, 0));
    assert_eq!(routes.count("/sync/crdt/updates/batch"), 0);
    let server = routes.server.lock().unwrap();
    for id in ids {
        holds_exactly(db, server.doc(id), 2);
        assert!(!is_owed(db, id), "{id}");
    }
}

#[tokio::test]
async fn a_rate_limited_manifest_page_waits_out_the_window_and_keeps_the_held_packs() {
    let (db, dir) = body_pack_server::scratch("manifest-429");
    let (docs, packs, ids) = seventeen_pages();
    seed_records(
        &db,
        &ids.iter().map(String::as_str).collect::<Vec<_>>(),
        &[],
    );
    let mut server = Server::new(docs, packs);
    server.manifest_page = 1;
    server.manifest_window = Some(14);
    let routes = Routes::new(server);

    let report = run_bodies(&db, &routes, &dir).await;

    settled_from_the_packs(&db, &routes, &ids, &report);
    assert_eq!(routes.slept(), [MANIFEST_RETRY_AFTER_S * 1_000]);
    // One listing page, two downloads, 17 manifest pages, and page 15 again.
    assert_eq!(routes.count("/sync/crdt/manifest"), 18);
    assert_eq!(routes.calls().len(), 1 + 2 + 18, "{:?}", routes.calls());
}

/// #5352 L1: a server that rate-limits every page would hold the walk for
/// one window per page. The whole read stops at its deadline instead, and
/// the held packs are checked through the batch route (§8.4.3).
#[tokio::test(start_paused = true)]
async fn a_manifest_read_rate_limited_on_every_page_stops_at_its_deadline() {
    let (db, dir) = body_pack_server::scratch("manifest-deadline");
    let (docs, packs, ids) = seventeen_pages();
    seed_records(
        &db,
        &ids.iter().map(String::as_str).collect::<Vec<_>>(),
        &[],
    );
    let mut server = Server::new(docs, packs);
    server.manifest_page = 1;
    server.manifest_window = Some(1);
    let routes = Routes::new(server);
    routes.clocked.store(true, Ordering::Relaxed);
    let started = tokio::time::Instant::now();

    let report = run_bodies(&db, &routes, &dir).await;

    assert_eq!(started.elapsed(), MANIFEST_READ_DEADLINE);
    assert!(report.ran && !report.manifest, "{report:?}");
    // 16 waits of 45 s would take 720 s; 300 s holds 6 of them.
    assert_eq!(routes.slept().len(), 7);
    assert_eq!(routes.count("/sync/crdt/updates/batch"), 1);
}

#[tokio::test]
async fn a_relaunch_inside_the_window_of_a_killed_manifest_read_still_settles_from_the_packs() {
    let (db, dir) = body_pack_server::scratch("manifest-relaunch");
    let (docs, packs, ids) = seventeen_pages();
    seed_records(
        &db,
        &ids.iter().map(String::as_str).collect::<Vec<_>>(),
        &[],
    );
    let mut server = Server::new(docs, packs);
    server.manifest_page = 1;
    server.manifest_window = Some(30);
    // Killed when the 17th page is asked for, after the packs are held.
    server.hang = Some(format!("cursor={}", ids[15]));
    let routes = Routes::new(server);
    killed_while(&routes, run_bodies(&db, &routes, &dir), || {
        spilled(&dir, "s1") && spilled(&dir, "u1")
    })
    .await;
    assert_eq!(routes.count("/sync/crdt/manifest"), 17);

    routes.server.lock().unwrap().hang = None;
    routes.clear_calls();
    let report = run_bodies(&db, &routes, &dir).await;

    settled_from_the_packs(&db, &routes, &ids, &report);
    assert_eq!(routes.slept(), [MANIFEST_RETRY_AFTER_S * 1_000]);
    assert_eq!(routes.count("/packs/"), 0, "no held pack downloaded again");
    assert_eq!(routes.count("/sync/crdt/manifest"), 18);
}

#[tokio::test]
async fn a_kill_in_a_download_or_on_the_manifest_resumes_without_downloading_a_held_pack() {
    for phase in ["/packs/u1", "/sync/crdt/manifest"] {
        let (db, dir) = body_pack_server::scratch("kill");
        let (docs, packs) = three_shapes();
        seed_records(&db, &SHAPES.map(|(id, _)| id), &[]);
        let mut server = Server::new(docs, packs);
        server.hang = Some(phase.to_owned());
        let routes = Routes::new(server);
        killed_while(&routes, run_bodies(&db, &routes, &dir), || {
            spilled(&dir, "s1")
        })
        .await;
        let held_before = routes.count("/packs/s1");

        routes.server.lock().unwrap().hang = None;
        let report = run_bodies(&db, &routes, &dir).await;

        assert_eq!(held_before, 1, "{phase}");
        assert_eq!(routes.count("/packs/s1"), 1, "{phase}: s1 again");
        assert_eq!(report.packs_held, 2, "{phase}");
        holds_the_three_shapes(&db, &routes);
        assert_eq!((report.settled, report.owed), (3, 0), "{phase}");
    }
}

#[tokio::test]
async fn an_apply_that_fails_part_way_resumes_with_every_update_once() {
    let (db, dir) = body_pack_server::scratch("abort");
    let (docs, packs) = three_shapes();
    seed_records(&db, &SHAPES.map(|(id, _)| id), &[]);
    let routes = Routes::new(Server::new(docs, packs));
    db.call_blocking(|conn| {
        conn.execute_batch(
            "CREATE TEMP TRIGGER refuse BEFORE INSERT ON yjs_updates
             WHEN NEW.doc_id = 'bothdoc00001' AND NEW.seq = 4
             BEGIN SELECT RAISE(ABORT, 'refused'); END",
        )
        .expect("the trigger");
        Ok(())
    })
    .expect("install the trigger");

    let failed = bootstrap(&db, &routes, &dir)
        .run_bodies(NOW_MS / 1_000)
        .await;
    assert!(failed.is_err(), "a storage failure fails the phase");
    assert!(dir.join("pack-spill").exists(), "the packs stay held");

    db.call_blocking(|conn| {
        conn.execute_batch("DROP TRIGGER refuse").expect("drop");
        Ok(())
    })
    .expect("drop the trigger");
    let report = run_bodies(&db, &routes, &dir).await;

    assert_eq!(routes.count("/packs/"), 2, "no pack downloaded twice");
    holds_the_three_shapes(&db, &routes);
    assert_eq!((report.settled, report.owed), (3, 0));
}

/// REVIEW-5269: the manifest's paging can miss a document created behind its
/// cursor during the read. An absent document is owed, not settled at 0, so
/// its body is pulled through the route (§8.10).
#[tokio::test]
async fn a_document_the_manifest_read_missed_ends_with_its_body_pulled() {
    let (db, dir) = body_pack_server::scratch("missed");
    let (mut docs, packs) = three_shapes();
    docs.push(ServerDoc::new("created00001", 2));
    let mut server = Server::new(docs, packs);
    server.records = true;
    server.manifest_misses.insert("created00001".to_owned());
    let routes = Routes::new(server);

    let report = first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert_eq!((report.body_packs.settled, report.body_packs.owed), (3, 1));
    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc("created00001"), 2);
    assert!(!is_owed(&db, "created00001"), "settled at its head");
    for (id, edits) in SHAPES {
        holds_exactly(&db, server.doc(id), edits);
    }
}

#[tokio::test]
async fn a_kill_in_the_route_pull_resumes_with_the_servers_updates_exactly() {
    let (db, dir) = body_pack_server::scratch("kill-route");
    let gap = ServerDoc::new("gapdoc000001", 4);
    let mut gapped = update_items(&[&gap]);
    gapped.retain(|item| item.4.as_ref().unwrap()["sequenceNum"] != 3);
    let mut server = Server::new(vec![gap], vec![BodyPack::new("u1", gapped)]);
    server.records = true;
    // The route pass's batch probe, whose answer would serve the gap.
    server.hang = Some("/sync/crdt/updates/batch".to_owned());
    let routes = Routes::new(server);
    killed_while(&routes, first_sync(&db, &routes, &dir).run(NOW_MS), || true).await;
    assert_eq!(update_seqs(&db, "gapdoc000001"), [1, 2]);
    assert!(is_owed(&db, "gapdoc000001"));
    let marker = db
        .call_blocking(|conn| read_meta(conn, META_FIRST_SYNC_BODY_PACKS))
        .unwrap();
    assert_eq!(marker.as_deref(), Some("1"), "the body pack phase finished");
    // As a kill between the settle and the spill's removal leaves it.
    std::fs::create_dir_all(dir.join("pack-spill")).unwrap();
    std::fs::write(dir.join("pack-spill").join("left.mpak"), b"held").unwrap();

    routes.server.lock().unwrap().hang = None;
    first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the resumed first sync");

    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc("gapdoc000001"), 4);
    assert!(!is_owed(&db, "gapdoc000001"));
    assert_eq!(
        routes.count("/packs/u1"),
        1,
        "the held pack is not fetched again"
    );
    assert!(
        !dir.join("pack-spill").exists(),
        "a resume past the phase removes its spill"
    );
}

/// REVIEW-5347: a first sync killed after its body packs settled re-runs its
/// refs pass on resume, past the body row of an edit made meanwhile. The
/// edited document, settled by the packs, ends at the server's head and owed
/// nothing, so the completed run's `coversThrough` covers it.
#[tokio::test]
async fn a_resume_after_the_body_packs_pulls_a_document_edited_meanwhile() {
    let (db, dir) = body_pack_server::scratch("resume-edited");
    let edited = ServerDoc::new("editdoc00001", 3);
    let gap = ServerDoc::new("gapdoc000001", 4);
    let mut items = update_items(&[&edited, &gap]);
    items.retain(|item| item.1 != "gapdoc000001" || item.4.as_ref().unwrap()["sequenceNum"] != 3);
    let mut server = Server::new(vec![edited, gap], vec![BodyPack::new("u1", items)]);
    server.records = true;
    // The gap keeps one document owed, so the route pass runs and hangs.
    server.hang = Some("/sync/crdt/updates/batch".to_owned());
    let routes = Routes::new(server);
    killed_while(&routes, first_sync(&db, &routes, &dir).run(NOW_MS), || true).await;
    assert_eq!(update_seqs(&db, "editdoc00001"), [1, 2, 3]);
    assert!(!is_owed(&db, "editdoc00001"), "the packs settled it");

    {
        let mut server = routes.server.lock().unwrap();
        server.hang = None;
        server.docs[0] = ServerDoc::new("editdoc00001", 4);
    }
    first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the resumed first sync");

    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc("editdoc00001"), 4);
    holds_exactly(&db, server.doc("gapdoc000001"), 4);
    assert!(!is_owed(&db, "editdoc00001") && !is_owed(&db, "gapdoc000001"));
}

/// A kill on the second updates page of a document with more updates than one
/// page: the batch probe's answer was the first page, so the first per-document
/// GET is the second page. The resume ends with the server's updates exactly.
#[tokio::test]
async fn a_kill_on_the_second_updates_page_resumes_with_every_update() {
    let (db, dir) = body_pack_server::scratch("kill-second-page");
    let long = ServerDoc::new("longdoc00001", 150);
    let mut server = Server::new(vec![long], vec![]);
    server.records = true;
    server.hang = Some("/sync/crdt/updates?note_id=longdoc00001".to_owned());
    let routes = Routes::new(server);
    killed_while(&routes, first_sync(&db, &routes, &dir).run(NOW_MS), || true).await;
    assert_eq!(routes.count("/sync/crdt/updates/batch"), 1);
    assert_eq!(
        update_seqs(&db, "longdoc00001"),
        (1..=100).collect::<Vec<i64>>(),
        "the first page, from the batch answer, is stored before the kill"
    );

    routes.server.lock().unwrap().hang = None;
    first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the resumed first sync");

    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc("longdoc00001"), 150);
    assert!(!is_owed(&db, "longdoc00001"));
}

/// The request ceiling of a fresh device whose documents the packs bring to
/// their heads: two listing walks (records, then bodies) of `ceil(P / 50)`
/// pages, `P` downloads, one feed page and one record manifest, and one body
/// manifest page per thousand documents. Window pulls are added only for
/// documents that are not current.
fn ceiling(packs: usize, documents: usize) -> usize {
    2 * packs.div_ceil(50) + packs + 2 + documents.div_ceil(1000)
}

#[tokio::test]
async fn the_request_count_follows_the_packs_and_not_the_documents() {
    for count in [40usize, 2_500] {
        let (db, dir) = body_pack_server::scratch("ceiling");
        let docs: Vec<ServerDoc> = (0..count)
            .map(|at| ServerDoc::new(&format!("d{at:011}"), 2).snapshot_at(1))
            .collect();
        let refs: Vec<&ServerDoc> = docs.iter().collect();
        let mut packs: Vec<BodyPack> = refs
            .chunks(1_000)
            .enumerate()
            .map(|(at, chunk)| BodyPack::new(&format!("s{at}"), snapshot_items(chunk)))
            .collect();
        packs.extend(
            refs.chunks(500)
                .enumerate()
                .map(|(at, chunk)| BodyPack::new(&format!("u{at}"), update_items(chunk))),
        );
        let listed = packs.len() + 1;
        let mut server = Server::new(docs, packs);
        server.records = true;
        let routes = Routes::new(server);

        let report = first_sync(&db, &routes, &dir)
            .run(NOW_MS)
            .await
            .expect("the first sync");

        assert_eq!(
            routes.calls().len(),
            ceiling(listed, count),
            "N = {count}: {:?}",
            routes.calls()
        );
        assert_eq!(report.body_packs.settled, count, "N = {count}");
        assert_eq!(report.body_packs.owed, 0);
        let server = routes.server.lock().unwrap();
        for at in [0, count - 1] {
            holds_exactly(&db, server.doc(&format!("d{at:011}")), 2);
        }
    }
}

/// A pack that cannot be used (§8.12) is absent. `lostdoc` loses what it
/// needed from the pack `lose` takes away and is owed when the body pack
/// phase ends; `keptdoc` is served by another pack and settled. The route
/// pull, killed then resumed, ends `lostdoc` at the server's updates exactly.
async fn a_lost_pack_leaves_its_documents_owed(label: &str, lose: impl FnOnce(&mut Server)) {
    let (db, dir) = body_pack_server::scratch(label);
    let lost = ServerDoc::new("lostdoc00001", 4).snapshot_at(2);
    let kept = ServerDoc::new("keptdoc00001", 3)
        .snapshot_at(3)
        .purged_through(3);
    let packs = vec![
        BodyPack::new("s1", snapshot_items(&[&lost])),
        BodyPack::new("s2", snapshot_items(&[&kept])),
        BodyPack::new("u1", update_items(&[&lost])),
    ];
    let mut server = Server::new(vec![lost, kept], packs);
    server.records = true;
    server.hang = Some("/sync/crdt/updates/batch".to_owned());
    lose(&mut server);
    let routes = Routes::new(server);
    killed_while(&routes, first_sync(&db, &routes, &dir).run(NOW_MS), || true).await;
    assert!(is_owed(&db, "lostdoc00001"), "{label}");
    assert!(!is_owed(&db, "keptdoc00001"), "{label}");

    routes.server.lock().unwrap().hang = None;
    first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the resumed first sync");

    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc("lostdoc00001"), 4);
    holds_exactly(&db, server.doc("keptdoc00001"), 3);
    assert!(!is_owed(&db, "lostdoc00001"), "{label}");
    for pack in ["/packs/s1", "/packs/s2"] {
        assert_eq!(routes.count(pack), 1, "{label}: {pack} again");
    }
}

#[tokio::test]
async fn a_corrupt_snapshot_pack_leaves_its_documents_owed() {
    a_lost_pack_leaves_its_documents_owed("corrupt", |server| {
        server.corrupt.insert("s1".to_owned());
    })
    .await;
}

/// A network drop on a download is no error of the phase: the pack is
/// absent, the finished packs are used, and none is downloaded again.
#[tokio::test]
async fn a_network_drop_mid_download_uses_the_finished_packs() {
    a_lost_pack_leaves_its_documents_owed("dropped", |server| {
        server.dropped.insert("u1".to_owned());
    })
    .await;
}

#[tokio::test]
async fn an_update_pack_gone_between_listing_and_download_leaves_its_documents_owed() {
    a_lost_pack_leaves_its_documents_owed("gone", |server| {
        server.gone.insert("u1".to_owned());
    })
    .await;
}

/// The record phase lists, then the body phase's listing answers 404: no
/// body pack is used, and the window pull brings every document to the
/// server's updates exactly.
#[tokio::test]
async fn a_listing_404_in_the_body_phase_leaves_the_bodies_to_the_routes() {
    let (db, dir) = body_pack_server::scratch("listing-404");
    let (docs, packs) = three_shapes();
    let mut server = Server::new(docs, packs);
    server.records = true;
    server.listing_missing_from = Some(1);
    let routes = Routes::new(server);

    let report = first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert!(!report.body_packs.ran, "{:?}", report.body_packs);
    assert!(!report.body_packs.fallback_reasons.is_empty());
    assert_eq!(routes.count("/packs/s1") + routes.count("/packs/u1"), 0);
    holds_the_three_shapes(&db, &routes);
    assert!(SHAPES.iter().all(|(id, _)| !is_owed(&db, id)));
}

/// A packed snapshot at the server's revision but another `sequenceNum`
/// would set the cursor wrong, so it is not confirmed.
#[tokio::test]
async fn a_snapshot_at_the_revision_but_another_sequence_number_is_not_applied() {
    let (db, dir) = body_pack_server::scratch("snapshot-seq");
    let doc = ServerDoc::new("seqdoc000001", 3).snapshot_at(2);
    let mut item = snapshot_item_as(&doc, &doc.snapshot.as_ref().unwrap().revision);
    item.4.as_mut().unwrap()["sequenceNum"] = 1.into();
    seed_records(&db, &["seqdoc000001"], &[]);
    let routes = Routes::new(Server::new(
        vec![doc],
        vec![BodyPack::new("s1", vec![item])],
    ));

    let report = run_bodies(&db, &routes, &dir).await;

    assert!(report.ran && report.manifest);
    assert_eq!(report.snapshots_applied, 0);
    assert!(!has_snapshot(&db, "seqdoc000001"));
    assert!(is_owed(&db, "seqdoc000001"));
}

/// REVIEW-5273: a pack is a cache (§8.0). A spill that cannot be written
/// (ENOSPC; here a file squatting the spill path) falls back to the routes
/// instead of failing the first sync.
#[tokio::test]
async fn an_unwritable_spill_falls_back_instead_of_failing_the_first_sync() {
    let (db, dir) = body_pack_server::scratch("unwritable-spill");
    std::fs::write(dir.join("pack-spill"), b"not a directory").unwrap();
    let a = ServerDoc::new("probedoc0001", 4).snapshot_at(2);
    let b = ServerDoc::new("probedoc0002", 3);
    let packs = vec![
        BodyPack::new("s1", snapshot_items(&[&a])),
        BodyPack::new("u1", update_items(&[&a, &b])),
    ];
    let mut server = Server::new(vec![a, b], packs);
    server.records = true;
    let routes = Routes::new(server);

    let report = first_sync(&db, &routes, &dir)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert!(!report.body_packs.ran);
    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc("probedoc0001"), 4);
    holds_exactly(&db, server.doc("probedoc0002"), 3);
}

/// REVIEW-5273: a run killed after spilling, resumed when the listing has no
/// body pack (a purge dropped them, §8.4.3), writes marker 0 and never runs
/// the phase again, so the spill must not outlive it.
#[tokio::test]
async fn a_resume_that_finds_no_body_pack_removes_the_old_spill() {
    let (db, dir) = body_pack_server::scratch("leftover-spill");
    let (docs, packs) = three_shapes();
    seed_records(&db, &SHAPES.map(|(id, _)| id), &[]);
    let mut server = Server::new(docs, packs);
    server.hang = Some("/sync/crdt/manifest".to_owned());
    let routes = Routes::new(server);
    killed_while(&routes, run_bodies(&db, &routes, &dir), || {
        spilled(&dir, "s1") && spilled(&dir, "u1")
    })
    .await;

    {
        let mut server = routes.server.lock().unwrap();
        server.hang = None;
        server.packs.clear();
    }
    let report = run_bodies(&db, &routes, &dir).await;

    assert!(!report.ran);
    assert!(!dir.join("pack-spill").exists(), "the old spill is removed");
}
