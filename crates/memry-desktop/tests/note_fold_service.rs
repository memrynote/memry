//! `FoldService` over a running vault (Step 14h, #3531): a long note and a journal day fold
//! from their files, a fold never waits on `index.db`'s writer (the Brief is picked again,
//! never cached), a short or unknown note does not fold, and the service lets go of the vault
//! when it closes.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::fold::service::FoldService;
use memry_desktop::fold::{FoldLayers, FoldLevel};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use vault_env::{Env, env, indexed};

const SENTENCE: &str = "The fold keeps the sentence that carries each paragraph of a long note.";

fn long_note(paragraphs: usize) -> String {
    let paragraph =
        format!("{SENTENCE} It drops the rest until the reader opens it again. Is that enough?");
    let mut text = String::from("# Plan\n\n");
    for _ in 0..paragraphs {
        text.push_str(&paragraph);
        text.push_str("\n\n");
    }
    text
}

fn opened(files: &[(&str, &str)]) -> (Env, Arc<FoldService>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (path, text) in files {
        e.write(path, text);
    }
    let notes = NotesService::new(e.tier.clone(), kept.expect("the store"));
    let fold = FoldService::new(notes);
    fold.register(&e.session);
    e.open();
    e.facts_until(indexed);
    (e, fold)
}

fn id_of(e: &Env, path: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .map(|(id, _)| id)
        .expect("the note's row")
}

fn briefs(layers: &FoldLayers) -> Vec<Vec<u32>> {
    layers
        .sections
        .iter()
        .flat_map(|s| &s.paragraphs)
        .map(|p| p.brief_idx.clone())
        .collect()
}

#[test]
fn a_long_note_folds_to_its_brief() {
    let (e, fold) = opened(&[("plan.md", &long_note(8))]);
    let id = id_of(&e, "plan.md");

    let layers = fold.run(&id, FoldLevel::Brief).expect("fold");
    assert!(layers.foldable);
    assert_eq!(layers.note_id, id);
    assert_eq!(layers.sections[0].heading.as_deref(), Some("Plan"));
    assert_eq!(layers.sections[0].paragraphs.len(), 8);
    // Each paragraph's first sentence: first, a claim of 6 to 30 words, no question.
    assert!(briefs(&layers).iter().all(|b| b == &[0]));
    assert_eq!(layers.sections[0].paragraphs[0].sentences[0], SENTENCE);

    // Full folds the same snapshot.
    assert_eq!(fold.run(&id, FoldLevel::Full).expect("fold"), layers);
}

#[test]
fn a_fold_never_waits_on_the_index_writer() {
    let (e, fold) = opened(&[("plan.md", &long_note(8))]);
    let id = id_of(&e, "plan.md");
    let open = e.session.current().expect("open");
    // The writer is held, as a reindex pass holds it for its whole transaction, until the
    // fold is back: a fold that wrote to `index.db` would wait for ever.
    let (held, writer_held) = mpsc::channel();
    let (folded, fold_done) = mpsc::channel::<()>();
    let search = open.search.clone();
    let writer = std::thread::spawn(move || {
        search
            .index_handle()
            .call_blocking(move |_| {
                held.send(()).expect("held");
                fold_done.recv_timeout(Duration::from_secs(30)).ok();
                Ok(())
            })
            .expect("hold");
    });
    writer_held.recv().expect("the writer is held");
    let (answer, answered) = mpsc::channel();
    let run = std::thread::spawn(move || answer.send(fold.run(&id, FoldLevel::Brief)).ok());
    let layers = answered
        .recv_timeout(Duration::from_secs(10))
        .expect("the fold answered with the writer held")
        .expect("fold");
    assert!(layers.foldable);
    folded.send(()).expect("release");
    writer.join().expect("writer");
    run.join().expect("run");
}

#[test]
fn a_short_or_unknown_note_does_not_fold() {
    let (e, fold) = opened(&[("short.md", "A few words are not worth folding.\n")]);
    let id = id_of(&e, "short.md");
    for note in [id.as_str(), "no-such-note"] {
        let layers = fold.run(note, FoldLevel::Brief).expect("fold");
        assert!(!layers.foldable);
        assert!(layers.sections.is_empty());
        assert_eq!(layers.words_by_level.brief, 0);
    }
}

#[test]
fn a_journal_day_folds_from_its_file() {
    let (_e, fold) = opened(&[("journal/2025-01-17.md", &long_note(8))]);
    let layers = fold.run("j2025-01-17", FoldLevel::Brief).expect("fold");
    assert!(layers.foldable);
    assert_eq!(layers.sections[0].paragraphs.len(), 8);
}

/// A deleted day reads as no day, as Electron's lookup of live days answers: its id does not
/// fold the file still at its date.
#[test]
fn a_deleted_journal_day_does_not_fold() {
    let (e, fold) = opened(&[("journal/2025-01-17.md", &long_note(8))]);
    let data = rusqlite::Connection::open(e.vault.join(".memry/core/data.db")).expect("data.db");
    data.execute(
        "UPDATE journal_entries SET deleted_at = 1 WHERE id = 'j2025-01-17'",
        [],
    )
    .expect("delete the day");
    let layers = fold.run("j2025-01-17", FoldLevel::Brief).expect("fold");
    assert!(!layers.foldable);
    assert!(layers.sections.is_empty());
}

#[test]
fn the_service_lets_go_of_the_vault_when_it_closes() {
    let (mut e, fold) = opened(&[("plan.md", &long_note(8))]);
    let id = id_of(&e, "plan.md");
    fold.run(&id, FoldLevel::Brief).expect("fold");
    e.close();
    assert!(matches!(
        fold.run(&id, FoldLevel::Brief),
        Err(NotesError::Closed)
    ));
    // Nothing of the closed vault is held: it opens again.
    e.open();
    assert!(fold.run(&id, FoldLevel::Brief).expect("fold").foldable);
}
