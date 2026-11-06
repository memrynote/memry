//! `FoldService` over a running vault (Step 14h, #3531): a long note and a journal day fold
//! from their files, each chunk's Brief is kept in `index.db`'s `note_fold_chunks` under the
//! writer `local`, an unreadable row is replaced, rows past the retention window go when the
//! vault opens, a short or unknown note does not fold, and the service lets go of the vault
//! when it closes.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::domain::fold_chunks::ChunkKey;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::fold::service::{CHUNK_RETENTION_MS, FoldRunState, FoldService};
use memry_desktop::fold::{FoldLayers, FoldLevel};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::session::OpenVault;
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

/// Every `note_fold_chunks` row: (writer, payload, written at).
fn rows(open: &OpenVault) -> Vec<(String, String, i64)> {
    open.search
        .index_handle()
        .read_blocking(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT model_id, payload, created_at FROM note_fold_chunks ORDER BY rowid",
                )
                .expect("select");
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .expect("rows")
                .map(Result::unwrap)
                .collect();
            Ok(rows)
        })
        .expect("read")
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
fn a_long_note_folds_and_keeps_its_brief_as_a_local_row() {
    let (e, fold) = opened(&[("plan.md", &long_note(8))]);
    let id = id_of(&e, "plan.md");
    let open = e.session.current().expect("open");

    let layers = fold.run(&id, FoldLevel::Brief).expect("fold");
    assert!(layers.foldable);
    assert_eq!(layers.note_id, id);
    assert_eq!(layers.sections[0].heading.as_deref(), Some("Plan"));
    assert_eq!(layers.sections[0].paragraphs.len(), 8);
    // Each paragraph's first sentence: first, a claim of 6 to 30 words, no question.
    assert!(briefs(&layers).iter().all(|b| b == &[0]));
    assert_eq!(layers.sections[0].paragraphs[0].sentences[0], SENTENCE);
    let kept = rows(&open);
    assert_eq!(kept.len(), 1, "one chunk, one row");
    assert_eq!(kept[0].0, "local");
    let payload: serde_json::Value = serde_json::from_str(&kept[0].1).expect("json");
    assert_eq!(
        payload["paragraphs"].as_array().expect("paragraphs").len(),
        8
    );
    assert_eq!(
        fold.last_run(),
        Some(FoldRunState {
            note_id: id.clone(),
            level: FoldLevel::Brief,
            ok: true,
            error: None,
        })
    );

    // Full folds the same snapshot and reads the row it already has.
    assert_eq!(fold.run(&id, FoldLevel::Full).expect("fold"), layers);
    assert_eq!(rows(&open), kept);
    assert_eq!(fold.last_run().expect("run").level, FoldLevel::Full);
}

#[test]
fn a_row_that_does_not_fit_its_chunk_is_written_again() {
    let (e, fold) = opened(&[("plan.md", &long_note(8))]);
    let id = id_of(&e, "plan.md");
    let open = e.session.current().expect("open");
    let layers = fold.run(&id, FoldLevel::Brief).expect("fold");
    let (_, good, _) = rows(&open).remove(0);
    let chunk_hash: String = open
        .search
        .index_handle()
        .read_blocking(|c| {
            Ok(
                c.query_row("SELECT chunk_hash FROM note_fold_chunks", [], |r| r.get(0))
                    .expect("hash"),
            )
        })
        .expect("read");
    let key = ChunkKey {
        chunk_hash,
        language: layers.language.clone(),
        model_id: "local".into(),
    };
    // A sentence index past the paragraph, then JSON that is not a row.
    for bad in [r#"{"paragraphs":[{"brief":[9]}]}"#, "not json"] {
        open.search.put_fold_chunk(&key, bad, 1).expect("put");
        assert_eq!(fold.run(&id, FoldLevel::Brief).expect("fold"), layers);
        assert_eq!(rows(&open)[0].1, good);
    }
}

#[test]
fn rows_past_the_retention_window_go_when_the_vault_opens() {
    let (mut e, fold) = opened(&[("plan.md", &long_note(8))]);
    let now = memry_desktop::telemetry::time::now_ms() as i64;
    let open = e.session.current().expect("open");
    let key = |hash: &str| ChunkKey {
        chunk_hash: hash.into(),
        language: "en".into(),
        model_id: "local".into(),
    };
    let payload = r#"{"paragraphs":[]}"#;
    open.search
        .put_fold_chunk(&key("old"), payload, now - CHUNK_RETENTION_MS - 60_000)
        .expect("put");
    open.search
        .put_fold_chunk(
            &key("recent"),
            payload,
            now - CHUNK_RETENTION_MS + 60 * 60_000,
        )
        .expect("put");
    drop(open);
    e.close();
    e.open();
    let open = e.session.current().expect("open");
    let hashes = |open: &OpenVault| -> Vec<String> {
        open.search
            .index_handle()
            .read_blocking(|c| {
                let mut s = c
                    .prepare("SELECT chunk_hash FROM note_fold_chunks")
                    .expect("q");
                Ok(s.query_map([], |r| r.get(0))
                    .expect("rows")
                    .map(Result::unwrap)
                    .collect())
            })
            .expect("read")
    };
    assert_eq!(hashes(&open), ["recent"]);
    drop(fold);
}

#[test]
fn a_short_or_unknown_note_does_not_fold_and_writes_no_row() {
    let (e, fold) = opened(&[("short.md", "A few words are not worth folding.\n")]);
    let id = id_of(&e, "short.md");
    let open = e.session.current().expect("open");
    for note in [id.as_str(), "no-such-note"] {
        let layers = fold.run(note, FoldLevel::Brief).expect("fold");
        assert!(!layers.foldable);
        assert!(layers.sections.is_empty());
        assert_eq!(layers.words_by_level.brief, 0);
    }
    assert!(rows(&open).is_empty());
}

#[test]
fn a_journal_day_folds_from_its_file() {
    let (_e, fold) = opened(&[("journal/2025-01-17.md", &long_note(8))]);
    let layers = fold.run("j2025-01-17", FoldLevel::Brief).expect("fold");
    assert!(layers.foldable);
    assert_eq!(layers.sections[0].paragraphs.len(), 8);
}

#[test]
fn the_service_lets_go_of_the_vault_when_it_closes() {
    let (mut e, fold) = opened(&[("plan.md", &long_note(8))]);
    let id = id_of(&e, "plan.md");
    fold.run(&id, FoldLevel::Brief).expect("fold");
    e.close();
    assert_eq!(fold.last_run(), None);
    assert!(matches!(
        fold.run(&id, FoldLevel::Brief),
        Err(NotesError::Closed)
    ));
    // Nothing of the closed vault is held: it opens again.
    e.open();
    assert!(fold.run(&id, FoldLevel::Brief).expect("fold").foldable);
}
