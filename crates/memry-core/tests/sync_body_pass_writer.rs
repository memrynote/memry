//! The bodies pass after a body pack phase reaches the network while another
//! thread holds the `data.db` writer (#5350).
//!
//! The pack phase's settle tells the desktop write-back about every settled
//! note, and the write-back reads each body on the writer. The bodies pass
//! read its window, its debts and each probed document's cursor on the writer
//! too, one hop per document, so on a 17k-note vault it waited minutes behind
//! the write-back with no request in flight.

use crate::body_pack_server;

use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use body_pack_server::{
    BodyPack, NOW_MS, Routes, Server, ServerDoc, first_sync_observed, holds_exactly, is_owed,
    snapshot_items,
};
use memry_core::storage::Db;
use memry_core::sync::driver::observer::{ApplyObserver, Observers};

const PROBE: &str = "/sync/crdt/updates/batch";
/// Liveness only: how long the holder waits for the probe before it lets go.
const HOLD_AT_MOST: Duration = Duration::from_secs(30);

/// Takes the writer when the pack phase tells its settled bodies, as the
/// write-back's body reads do, and holds it until the bodies pass's probe
/// reaches the server. Records whether the probe came while it held.
struct HoldsTheWriter {
    db: Db,
    routes: Arc<Routes>,
    probed_while_held: mpsc::Sender<bool>,
}

impl ApplyObserver for HoldsTheWriter {
    fn name(&self) -> &str {
        "holds-the-writer"
    }

    fn bodies_applied(&self, _doc_ids: &[String]) {
        let (db, routes, told) = (
            self.db.clone(),
            Arc::clone(&self.routes),
            self.probed_while_held.clone(),
        );
        let (held_tx, held_rx) = mpsc::channel();
        std::thread::spawn(move || {
            db.call_blocking(|_| {
                held_tx.send(()).unwrap();
                let until = Instant::now() + HOLD_AT_MOST;
                while routes.count(PROBE) == 0 && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(5));
                }
                told.send(routes.count(PROBE) > 0).unwrap();
                Ok(())
            })
            .unwrap();
        });
        held_rx.recv().unwrap();
    }
}

/// Red before #5350: the probe waited on the writer, so it reached the server
/// only after the holder gave up.
#[tokio::test(flavor = "multi_thread")]
async fn the_bodies_pass_probes_while_the_writer_is_busy() {
    let (db, dir) = body_pack_server::scratch("writer-busy");
    let packed = ServerDoc::new("packed000001", 3).snapshot_only();
    let missed = ServerDoc::new("created00001", 2);
    let packs = vec![BodyPack::new("s1", snapshot_items(&[&packed]))];
    let mut server = Server::new(vec![packed, missed], packs);
    server.records = true;
    // Absent from the manifest: owed after the phase, so the bodies pass
    // probes it (§8.10).
    server.manifest_misses.insert("created00001".to_owned());
    let routes = Routes::new(server);
    let (told, probed_while_held) = mpsc::channel();
    let observers = Arc::new(Observers::default());
    observers.register(Arc::new(HoldsTheWriter {
        db: db.clone(),
        routes: Arc::clone(&routes),
        probed_while_held: told,
    }));

    let report = first_sync_observed(&db, &routes, &dir, observers)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    assert_eq!((report.body_packs.settled, report.body_packs.owed), (1, 1));
    assert!(
        probed_while_held.recv().unwrap(),
        "the probe reached the server while the write-back held the writer"
    );
    let server = routes.server.lock().unwrap();
    holds_exactly(&db, server.doc("created00001"), 2);
    assert!(!is_owed(&db, "created00001"), "settled at its head");
}
