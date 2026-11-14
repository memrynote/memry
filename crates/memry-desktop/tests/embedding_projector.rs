//! The note embedding lane (Step 23 lane 9, #3540), after Electron's `embedding-projector.ts`,
//! on a real vault under the running tier, the shipped projection feed and a fake model
//! ([`crate::embedding_lane`]). What a close or an upgrade leaves owed: `embedding_owed.rs`.
//!
//! | Test                                                  | Rule                                     |
//! | ----------------------------------------------------- | ---------------------------------------- |
//! | a written note is embedded; an edit replaces it        | `updateEmbedding`                        |
//! | a removed note loses its vectors                       | `note.deleted` arm                       |
//! | with AI off a note is only owed; AI on embeds it       | `isAIEnabled`, `reconcileProjections`    |
//! | AI turned off mid-pass stops the pass                  | `canContinue`                            |
//! | while indexing a note is only owed; the drain embeds   | `drainDeferredEmbeddings`                |
//! | a reindex's end drains the notes it deferred           | `drainDeferredEmbeddings`                |
//! | an edit landing mid-embed stops the stale store        | `revisions`, bumped at publish           |
//! | an edit queued at close is owed and embedded on reopen | the stored content hash, REVIEW-4548     |
//! | a reconcile while indexing keeps every vector          | prune after the walk                     |
//! | a rebuild while indexing loads nothing, clears nothing | prune after the walk                     |
//! | a reconcile drops the vectors of a note gone           | `reconcile`'s prune                      |
//! | a reopen with unchanged files embeds nothing           | `reconcile` owes nothing                 |

use std::fs;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use memry_desktop::embedding::PROJECTORS;
use memry_desktop::embedding::projector::drain_deferred;
use memry_desktop::session::projection::{CancelToken, Projector};
use memry_desktop::vault::consumer::Applied;

use crate::embedding_lane::{ALPHA, BETA, GAMMA, lane};
use crate::vault_env::{WAIT, indexed};

#[test]
fn a_written_note_is_embedded_and_an_edit_replaces_its_vector() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);
    let first = l.head_text(&id).expect("a head vector of the model's");
    assert!(first.contains("first body"), "{first}");

    l.write("a.md", "Alpha now holds an edited body instead.\n");
    l.until("the edit's vector", |l| {
        l.head_text(&id)
            .is_some_and(|text| text.contains("edited body"))
    });
    assert_eq!(l.state(&id).map(|(v, _)| v), Some(6));
}

#[test]
fn a_removed_note_loses_its_vectors() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);

    fs::remove_file(l.e.vault.join("a.md")).unwrap();
    l.e.facts_until(|f| matches!(f, Applied::Removed { path, .. } if path == "a.md"));
    l.until("no vectors", |l| {
        l.state(&id).is_none() && l.head(&id).is_none()
    });
}

#[test]
fn with_ai_off_a_note_is_only_owed_until_ai_turns_on() {
    let mut l = lane();
    l.ai.store(false, Ordering::SeqCst);
    let id = l.write("a.md", ALPHA);
    l.owes(&id);
    l.settled();
    assert_eq!(l.embeds(), 0);

    l.ai.store(true, Ordering::SeqCst);
    let runtime = l.e.session.projections().unwrap();
    runtime.reconcile_named(&PROJECTORS).unwrap();
    l.embedded(&id);
}

#[test]
fn ai_turned_off_mid_pass_stops_embedding() {
    let mut l = lane();
    l.indexing.store(true, Ordering::SeqCst);
    let ids: Vec<String> = [("a.md", ALPHA), ("b.md", BETA), ("c.md", GAMMA)]
        .into_iter()
        .map(|(rel, text)| l.write(rel, text))
        .collect();
    for id in &ids {
        l.owes(id);
    }
    l.settled();
    let (gate, reached) = l.hold_next();
    l.indexing.store(false, Ordering::SeqCst);
    drain_deferred(&l.e.session, &l.index);
    reached
        .recv_timeout(WAIT)
        .expect("the pass reached the model");

    l.ai.store(false, Ordering::SeqCst);
    gate.release();
    l.settled();
    assert_eq!(l.embeds(), 1, "the pass stopped after the held inference");
    let owed = l.owed();
    for id in &ids {
        assert!(owed.contains(id), "{id} stays owed");
        assert!(l.head(id).is_none());
    }
}

#[test]
fn while_indexing_a_note_is_only_owed_and_the_drain_embeds_it() {
    let mut l = lane();
    l.indexing.store(true, Ordering::SeqCst);
    let id = l.write("a.md", ALPHA);
    l.owes(&id);
    l.settled();
    assert_eq!(l.embeds(), 0);

    l.indexing.store(false, Ordering::SeqCst);
    drain_deferred(&l.e.session, &l.index);
    l.embedded(&id);
}

const EDITED: &str = "Alpha now holds an edited body instead.\n";

#[test]
fn a_reindex_end_drains_the_notes_it_deferred() {
    let mut l = lane();
    l.ai.store(false, Ordering::SeqCst);
    let id = l.write("a.md", ALPHA);
    l.owes(&id);
    l.settled();
    l.ai.store(true, Ordering::SeqCst);

    l.index.reindex(|_| {}).unwrap();
    l.embedded(&id);
}

#[test]
fn an_edit_landing_mid_embed_stops_the_stale_store() {
    let mut l = lane();
    let (first, reached) = l.hold_next();
    let id = l.write("a.md", ALPHA);
    reached
        .recv_timeout(WAIT)
        .expect("the lane reached the model");

    l.write("a.md", EDITED);
    l.publish(&id);
    let (second, reached) = l.hold_next();
    first.release();
    reached
        .recv_timeout(WAIT)
        .expect("the next inference reached the model");
    let next = l.model.embedded.lock().unwrap().last().cloned().unwrap();
    assert!(
        next.contains("edited body"),
        "the stale embed went on: {next}"
    );
    assert!(l.head(&id).is_none(), "the stale body was stored");

    second.release();
    l.until("the edit's vector", |l| {
        l.head_text(&id)
            .is_some_and(|text| text.contains("edited body"))
    });
    l.settled();
    assert!(l.head_text(&id).unwrap().contains("edited body"));
}

#[test]
fn an_edit_queued_at_close_is_owed_and_embedded_after_reopen() {
    let mut l = lane();
    let edited = l.write("b.md", BETA);
    l.embedded(&edited);
    l.settled();
    let (gate, reached) = l.hold_next();
    let held = l.write("a.md", ALPHA);
    reached
        .recv_timeout(WAIT)
        .expect("the lane reached the model");
    let (embeds, loads) = (l.embeds(), l.model.loads.load(Ordering::SeqCst));

    l.write("b.md", "Beta now holds an edited body instead.\n");
    l.owes(&edited);
    // The held embed resumes inside the close, after the token is set and while the lanes
    // drain, so the drained edit reaches `project` too.
    let release = gate.clone();
    l.e.session
        .on_close("release-held-embed", Arc::new(move |_| release.release()));
    l.e.close();
    assert_eq!(l.embeds(), embeds, "embedded during the close");
    assert_eq!(l.model.loads.load(Ordering::SeqCst), loads);

    l.e.open();
    l.e.facts_until(indexed);
    l.until("the edit's vector", |l| {
        l.head_text(&edited)
            .is_some_and(|text| text.contains("edited body"))
    });
    l.embedded(&held);
}

#[test]
fn a_reconcile_while_indexing_keeps_every_vector() {
    let mut l = lane();
    let ids: Vec<String> = [("a.md", ALPHA), ("b.md", BETA)]
        .into_iter()
        .map(|(rel, text)| l.write(rel, text))
        .collect();
    for id in &ids {
        l.embedded(id);
    }
    l.settled();

    l.indexing.store(true, Ordering::SeqCst);
    l.forget_note_files();
    l.reconcile();
    for id in &ids {
        assert_eq!(l.state(id).map(|(v, _)| v), Some(6), "{id} lost its state");
        assert!(l.head(id).is_some(), "{id} lost its vector");
    }
}

#[test]
fn a_rebuild_while_indexing_loads_no_model_and_clears_nothing() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);
    l.settled();
    l.service.stop();
    l.until("the model unloaded", |l| !l.service.status().loaded);
    let loads = l.model.loads.load(Ordering::SeqCst);
    l.indexing.store(true, Ordering::SeqCst);

    assert!(l.projector.rebuild(&CancelToken::default()).is_err());
    assert_eq!(
        l.model.loads.load(Ordering::SeqCst),
        loads,
        "a model loaded"
    );
    assert_eq!(l.state(&id).map(|(v, _)| v), Some(6));

    l.forget_note_files();
    assert!(l.projector.rebuild(&CancelToken::default()).is_err());
    assert_eq!(
        l.state(&id).map(|(v, _)| v),
        Some(6),
        "the vectors were cleared"
    );
    assert!(l.head(&id).is_some());
}

#[test]
fn a_reconcile_drops_the_vectors_of_a_note_gone() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);
    l.settled();

    l.forget_note_files();
    l.reconcile();
    assert_eq!(l.state(&id), None);
    assert!(l.head(&id).is_none());
}

#[test]
fn a_reopen_with_unchanged_files_embeds_nothing() {
    let mut l = lane();
    let ids: Vec<String> = [("a.md", ALPHA), ("b.md", BETA)]
        .into_iter()
        .map(|(rel, text)| l.write(rel, text))
        .collect();
    for id in &ids {
        l.embedded(id);
    }
    l.settled();
    let (embeds, loads) = (l.embeds(), l.model.loads.load(Ordering::SeqCst));

    l.e.close();
    l.e.open();
    l.e.facts_until(indexed);
    l.settled();
    assert_eq!(l.embeds(), embeds, "the reopen embedded again");
    assert_eq!(l.model.loads.load(Ordering::SeqCst), loads);
    for id in &ids {
        assert_eq!(l.state(id).map(|(v, _)| v), Some(6));
    }
}
