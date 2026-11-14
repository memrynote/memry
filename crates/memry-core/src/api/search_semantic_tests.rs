use std::fs;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use super::*;
use crate::api::vault::Vault;
use crate::domain::notes::{self, NewNote};
use crate::domain::search::SearchFilter;
use crate::semantic::fakes::{Cdn, Scratch, Wifi, files, manifest};
use crate::semantic::{
    DIMENSION, Embed, ReleaseReason, SemanticError, Threads, Vector, truncate_renormalize,
};
use crate::storage::vector_db::{self, NoteState, VectorBytes, VectorStore};

const NOW: i64 = 1_760_000_000_000;

/// A unit vector at `cosine` to the one the fake embeds every query as.
fn at(cosine: f32) -> Vector {
    let mut values = [0.0; DIMENSION];
    values[0] = cosine;
    values[1] = (1.0 - cosine * cosine).sqrt();
    truncate_renormalize(&values).expect("finite")
}

struct Fake {
    embeds: Arc<AtomicUsize>,
}

impl Embed for Fake {
    fn threads(&self) -> Threads {
        Threads::Foreground
    }
    fn embed(&self, _: &str) -> Result<Vector, SemanticError> {
        Ok(at(1.0))
    }
    fn try_embed(&self, _: &str) -> Result<Option<Vector>, SemanticError> {
        self.embeds.fetch_add(1, Ordering::SeqCst);
        Ok(Some(at(1.0)))
    }
}

struct Setup {
    _scratch: Scratch,
    semantic: Arc<SemanticSearch>,
    vault: Arc<Vault>,
    loads: Arc<AtomicUsize>,
    embeds: Arc<AtomicUsize>,
}

/// An opted-in device with the model downloaded, and a vault holding
/// "Cardamom buns" (tagged `baking`) and "Spice cabinet".
async fn setup() -> Setup {
    setup_gated(None).await
}

/// [`setup`] whose model load blocks until `gate` receives.
async fn setup_gated(gate: Option<Receiver<()>>) -> Setup {
    let gate = gate.map(Mutex::new);
    let scratch = Scratch::new();
    let files = files();
    let (loads, embeds) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (counted, made) = (loads.clone(), embeds.clone());
    let semantic = Arc::new(SemanticSearch::with_loader(
        scratch.models(manifest(&files)),
        Cdn::new(&files),
        Wifi::on(),
        Arc::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            if let Some(gate) = &gate {
                gate.lock().unwrap().recv().unwrap();
            }
            Ok(Arc::new(Fake {
                embeds: made.clone(),
            }) as Arc<dyn Embed>)
        }),
    ));
    semantic.enable(1 << 40).await.expect("the model downloads");
    let dir = scratch.0.join("vault");
    fs::create_dir_all(&dir).unwrap();
    let vault = Arc::new(Vault::open("v1".into(), dir.to_string_lossy().into()).unwrap());
    vault
        .db_handle()
        .call_blocking(|conn| {
            for (id, title, tags) in [
                ("buns", "Cardamom buns", vec!["baking".to_owned()]),
                ("spices", "Spice cabinet", vec![]),
            ] {
                let note = NewNote {
                    id,
                    title,
                    folder_path: None,
                    content: "",
                    tags: &tags,
                    properties: None,
                    emoji: None,
                };
                notes::create(conn, &note, "device-a", NOW)?;
            }
            Ok(())
        })
        .unwrap();
    Setup {
        _scratch: scratch,
        semantic,
        vault,
        loads,
        embeds,
    }
}

impl Setup {
    fn vectors(&self, notes: &[(&str, VectorBytes)]) {
        let db = vector_db::open(&self.vault.directory().join("vectors.db"), true)
            .unwrap()
            .unwrap();
        db.call_blocking(|conn| {
            for (note_id, vector) in notes {
                let state = NoteState {
                    note_id: (*note_id).into(),
                    vector_key: "test-key".into(),
                    input_version: 6,
                    source_key: [0; 32],
                    window_count: 1,
                };
                VectorStore::new(conn).replace_note(&state, &[*vector], NOW)?;
            }
            Ok(())
        })
        .unwrap();
    }

    fn search(&self) -> Arc<Search> {
        let search = self.vault.search(Some(self.semantic.clone())).unwrap();
        search.reindex().unwrap();
        search
    }

    /// Searches until the loaded model has embedded a query. The deadline
    /// only bounds a hang.
    fn loaded(&self, search: &Search, query: &str, filter: Option<SearchFilter>) -> SearchGroups {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let before = self.embeds.load(Ordering::SeqCst);
            let groups = search.search(query.into(), filter.clone(), 50).unwrap();
            if self.embeds.load(Ordering::SeqCst) > before {
                return groups;
            }
            assert!(Instant::now() < deadline, "the model never loaded");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

fn found(results: &[SearchResult]) -> Vec<(&str, MatchKind)> {
    results
        .iter()
        .map(|result| (result.id.as_str(), result.match_kind))
        .collect()
}

#[tokio::test]
async fn the_first_query_answers_from_fts_and_starts_a_load_and_the_next_fuses() {
    let s = setup().await;
    s.vectors(&[
        ("spices", at(0.9).to_le_bytes()),
        ("buns", at(0.8).to_le_bytes()),
    ]);
    let search = s.search();

    let first = search.search("cardamom".into(), None, 50).unwrap();
    assert_eq!(found(&first.notes), [("buns", MatchKind::Body)]);

    let fused = s.loaded(&search, "cardamom", None);
    assert_eq!(s.loads.load(Ordering::SeqCst), 1);
    assert_eq!(
        found(&fused.notes),
        [("buns", MatchKind::Body), ("spices", MatchKind::Semantic)],
        "both legs found the buns, so they keep their FTS row and lead"
    );
    let spices = &fused.notes[1];
    assert_eq!(spices.title, "Spice cabinet");
    assert!(spices.snippet.is_empty());
    assert!((spices.score - 0.9).abs() < 1e-5, "the cosine");
}

#[tokio::test]
async fn a_query_during_the_load_is_pending_and_its_rerun_after_the_load_fuses() {
    let (open, gate) = channel();
    let s = setup_gated(Some(gate)).await;
    s.vectors(&[("spices", at(0.9).to_le_bytes())]);
    let search = s.search();

    let first = search.search("cardamom".into(), None, 50).unwrap();
    assert_eq!(found(&first.notes), [("buns", MatchKind::Body)]);
    assert!(first.semantic_pending, "FTS alone because the model loads");

    open.send(()).unwrap();
    assert!(search.semantic_model_loaded().await);
    let rerun = search.search("cardamom".into(), None, 50).unwrap();

    assert_eq!(
        found(&rerun.notes),
        [("buns", MatchKind::Body), ("spices", MatchKind::Semantic)]
    );
    assert!(!rerun.semantic_pending);
    assert_eq!(s.loads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_memory_warning_mid_load_reports_no_model_so_the_shell_never_reloads() {
    let (open, gate) = channel();
    let s = setup_gated(Some(gate)).await;
    let search = s.search();

    assert!(
        search
            .search("cardamom".into(), None, 50)
            .unwrap()
            .semantic_pending
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.loads.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline, "the load never started");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    s.semantic.release(ReleaseReason::MemoryWarning);
    open.send(()).unwrap();

    assert!(!search.semantic_model_loaded().await);
    assert_eq!(s.loads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_query_without_a_semantic_leg_is_never_pending() {
    let (_open, gate) = channel();
    let s = setup_gated(Some(gate)).await;
    let search = s.search();

    let operators = search.search("cardamom OR spice".into(), None, 50).unwrap();

    assert!(!operators.semantic_pending);
    assert_eq!(s.loads.load(Ordering::SeqCst), 0, "no load started");
}

#[tokio::test]
async fn a_filter_drops_semantic_only_notes_and_a_tombstone_never_surfaces() {
    let s = setup().await;
    s.vectors(&[
        ("spices", at(0.9).to_le_bytes()),
        ("buns", at(0.8).to_le_bytes()),
    ]);
    let search = s.search();
    let baking = SearchFilter {
        tags: vec!["baking".into()],
        ..SearchFilter::default()
    };
    let filtered = s.loaded(&search, "cardamom", Some(baking));
    assert_eq!(found(&filtered.notes), [("buns", MatchKind::Body)]);

    s.vault
        .db_handle()
        .call_blocking(|conn| notes::delete(conn, "spices", "device-a", NOW).map(|_| ()))
        .unwrap();
    let after = s.loaded(&search, "cardamom", None);
    assert_eq!(found(&after.notes), [("buns", MatchKind::Body)]);
}

#[tokio::test]
async fn a_failing_semantic_leg_answers_from_fts() {
    let s = setup().await;
    let mut unreadable = at(0.9).to_le_bytes();
    unreadable[..4].copy_from_slice(&f32::NAN.to_le_bytes());
    s.vectors(&[("spices", unreadable)]);
    let search = s.search();

    let groups = s.loaded(&search, "cardamom", None);

    assert_eq!(found(&groups.notes), [("buns", MatchKind::Body)]);
}

#[tokio::test]
async fn opted_out_searches_fts_alone_and_leaves_no_vectors() {
    let s = setup().await;
    s.vectors(&[("spices", at(0.9).to_le_bytes())]);
    let search = s.search();
    s.loaded(&search, "cardamom", None);

    s.semantic.disable(s.vault.clone()).await.unwrap();
    let groups = search.search("cardamom".into(), None, 50).unwrap();

    assert_eq!(found(&groups.notes), [("buns", MatchKind::Body)]);
    assert!(!s.vault.directory().join("vectors.db").exists());
}
