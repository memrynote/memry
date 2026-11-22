//! A fresh device's first sync whose bodies land from packs writes each settled note's vault file
//! in the same session (REVIEW-5339). The core's first sync runs over the body pack test server
//! and tells the shipped disk observer and the write-back of a vault opened through the tier.

#[path = "../../memry-core/tests/body_pack_server/mod.rs"]
mod body_pack_server;

use std::sync::Arc;

use body_pack_server::{
    BodyPack, NOW_MS, Routes, Server, ServerDoc, first_sync_observed, snapshot_items, update_items,
    words,
};
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::sync::body_debt;
use memry_core::sync::driver::observer::{ApplyObserver, Observers};
use memry_desktop::sync::disk::DiskObserver;
use memry_desktop::vault::consumer::VaultTier;

use crate::vault_env::{WAIT, creates, env, indexed};

/// Runs every scheduled write-back at each body tell, as a pack phase that outlasts the
/// write-back's debounce does on a large vault.
struct FlushAtTell(Arc<VaultTier>);

impl ApplyObserver for FlushAtTell {
    fn name(&self) -> &str {
        "flush-at-tell"
    }

    fn bodies_applied(&self, _doc_ids: &[String]) {
        assert!(self.0.flush(WAIT), "the write-back flushed");
    }
}

/// A snapshot-only, an updates-only and a snapshot-plus-updates document, with their edits.
const SHAPES: [(&str, i64); 3] = [
    ("snaponly0001", 3),
    ("updonly00001", 4),
    ("bothdoc00001", 5),
];

fn three_shapes() -> (Vec<ServerDoc>, Vec<BodyPack>) {
    let snapshot_only = ServerDoc::new(SHAPES[0].0, 3)
        .snapshot_at(3)
        .purged_through(3);
    let updates_only = ServerDoc::new(SHAPES[1].0, 4);
    let both = ServerDoc::new(SHAPES[2].0, 5).snapshot_at(2);
    let packs = vec![
        BodyPack::new("s1", snapshot_items(&[&snapshot_only, &both])),
        BodyPack::new("u1", update_items(&[&updates_only, &both])),
    ];
    (vec![snapshot_only, updates_only, both], packs)
}

/// Red before REVIEW-5339: the pack phase told each body while it was still owed, so the
/// write-back kept its file (`BodyNotPulled`), and nothing told it again once the phase settled.
#[tokio::test(flavor = "multi_thread")]
async fn a_first_sync_from_body_packs_writes_every_settled_notes_file() {
    let mut e = env(|store| Some(creates(store)));
    e.open();
    e.facts_until(indexed);
    let core = e.core();
    let (docs, packs) = three_shapes();
    let mut server = Server::new(docs, packs);
    server.records = true;
    let routes = Routes::new(server);
    let observers = Arc::new(Observers::default());
    observers.register(Arc::new(DiskObserver::new(
        e.tier.clone(),
        e.vault.clone(),
        core.clone(),
    )));
    observers.register(Arc::new(FlushAtTell(e.tier.clone())));
    let spill = tempfile::tempdir().unwrap();

    let report = first_sync_observed(&core.db_handle(), &routes, spill.path(), observers)
        .run(NOW_MS)
        .await
        .expect("the first sync");

    let packs = report.body_packs;
    assert!(packs.ran, "{packs:?}");
    assert_eq!((packs.settled, packs.owed), (3, 0), "{packs:?}");
    assert!(e.tier.flush(WAIT), "the write-back flushed");
    let rows = e.rows();
    for (id, edits) in SHAPES {
        let (_, path) = rows
            .iter()
            .find(|(row, _)| row == id)
            .unwrap_or_else(|| panic!("{id} has no file: {rows:?}"));
        assert!(
            e.read(path).contains(&words(edits)),
            "{id}'s file holds its body: {:?}",
            e.read(path)
        );
    }
}

/// Red before #5410: a note whose write-back kept its file while its server body was owed was
/// never scheduled again when the body settled without a tell of its own, so a fresh device's
/// vault never got its file. The body step's settle (`bodies_settled`) now re-drives it.
#[test]
fn a_note_kept_for_its_owed_body_gets_its_file_at_the_body_steps_settle() {
    let mut keys = None;
    let mut e = env(|store| {
        keys = Some(store.clone());
        Some(creates(store))
    });
    e.open();
    e.facts_until(indexed);
    let core = e.core();
    let writer = core.notes_writer(keys.unwrap()).unwrap();
    let id = writer.create("Pulled".into(), None).unwrap();
    let typed = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "the pulled words".into(),
        new_block_id: "pulled-p".into(),
    };
    assert!(writer.edit_block(id.clone(), typed).unwrap());
    let db = core.db_handle();
    let owed = id.clone();
    db.call_blocking(move |conn| body_debt::owe(conn, &owed))
        .unwrap();
    e.tier.schedule(&id);
    assert!(e.tier.flush(WAIT), "the write-back flushed");
    assert!(
        !e.rows().iter().any(|(row, _)| row == &id),
        "no file while owed"
    );

    let settled = id.clone();
    db.call_blocking(move |conn| body_debt::settle(conn, &settled))
        .unwrap();
    DiskObserver::new(e.tier.clone(), e.vault.clone(), core.clone()).bodies_settled();
    assert!(e.tier.flush(WAIT), "the write-back flushed");
    let rows = e.rows();
    let (_, path) = rows
        .iter()
        .find(|(row, _)| row == &id)
        .unwrap_or_else(|| panic!("{id} has no file: {rows:?}"));
    assert!(
        e.read(path).contains("the pulled words"),
        "{:?}",
        e.read(path)
    );
}
