use std::time::{Duration, Instant};

use super::*;
use crate::domain::search::{HitKind, SnippetSegment};
use crate::semantic::{DIMENSION, truncate_renormalize};
use crate::storage::vector_db::{self, NoteState, VectorStore};

/// A unit vector at `cosine` to [`query`].
fn at(cosine: f32) -> Vector {
    let mut values = [0.0; DIMENSION];
    values[0] = cosine;
    values[1] = (1.0 - cosine * cosine).sqrt();
    truncate_renormalize(&values).expect("finite")
}

fn query() -> Vector {
    at(1.0)
}

fn row(note_id: &str, window: u32, cosine: f32) -> (String, u32, VectorBytes) {
    (note_id.to_owned(), window, at(cosine).to_le_bytes())
}

fn ids(hits: &[SemanticHit]) -> Vec<&str> {
    hits.iter().map(|hit| hit.note_id.as_str()).collect()
}

#[test]
fn the_semantic_leg_skips_short_queries_operators_and_phrases() {
    for (query, wanted) in [
        ("ab", false),
        ("  ab  ", false),
        ("abc", true),
        ("???", false),
        ("cats AND dogs", false),
        ("cats OR dogs", false),
        ("NOT dogs", false),
        ("cats and dogs", true),
        ("NOTES on dogs", true),
        ("say \"hello\"", false),
        ("an \"\" empty quote", true),
        ("one \" quote", true),
    ] {
        assert_eq!(wants_semantic(query), wanted, "{query:?}");
    }
}

#[test]
fn each_window_class_keeps_its_nearest_thirty_before_collapsing_to_notes() {
    let mut rows: Vec<_> = (1..=NEIGHBOURS as u32)
        .map(|window| row("crowded", window, 0.99))
        .collect();
    rows.push(row("late-chunk", 1, 0.9));
    rows.push(row("head", 0, 0.7));

    let hits = nearest(&query(), rows).unwrap();

    assert_eq!(
        ids(&hits),
        ["crowded", "head"],
        "the 31st chunk is cut before the collapse"
    );
}

#[test]
fn the_floor_applies_to_a_note_best_window() {
    let rows = vec![
        row("weak-head-strong-chunk", 0, 0.5),
        row("weak-head-strong-chunk", 1, 0.8),
        row("over", 0, 0.66),
        row("under", 0, 0.64),
        row("under", 1, 0.6),
    ];

    let hits = nearest(&query(), rows).unwrap();

    assert_eq!(ids(&hits), ["weak-head-strong-chunk", "over"]);
    assert!((hits[0].cosine - 0.8).abs() < 1e-5);
}

#[test]
fn an_unreadable_vector_fails_the_leg() {
    let mut bytes = at(0.9).to_le_bytes();
    bytes[..4].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(nearest(&query(), vec![("n".into(), 0, bytes)]).is_err());
}

fn hit(id: &str) -> SearchHit {
    SearchHit {
        id: id.into(),
        title: id.into(),
        kind: HitKind::Note {
            emoji: None,
            folder_path: None,
        },
        score: -1.0,
        snippet: vec![SnippetSegment {
            text: id.into(),
            highlighted: true,
        }],
        match_kind: MatchKind::Body,
        matched_name: None,
    }
}

fn semantic(id: &str) -> SearchHit {
    SearchHit {
        snippet: Vec::new(),
        match_kind: MatchKind::Semantic,
        ..hit(id)
    }
}

#[test]
fn fusion_sums_both_legs_and_breaks_ties_in_fts_then_semantic_order() {
    let fts = vec![hit("a"), hit("b"), hit("c")];
    let both = vec![Ranked::Listed("c"), Ranked::New(semantic("d"))];

    let fused = rrf(fts, both, 10);

    let order: Vec<_> = fused.iter().map(|hit| hit.id.as_str()).collect();
    assert_eq!(order, ["c", "a", "b", "d"]);
    assert_eq!(
        fused[0],
        hit("c"),
        "a hit both legs found keeps its FTS row"
    );
    assert_eq!(fused[3].match_kind, MatchKind::Semantic);
}

#[test]
fn fusion_cuts_to_the_limit() {
    let fused = rrf(
        vec![hit("a"), hit("b")],
        vec![Ranked::New(semantic("c"))],
        2,
    );
    let order: Vec<_> = fused.iter().map(|hit| hit.id.as_str()).collect();
    assert_eq!(order, ["a", "c"]);
}

/// `cargo test -p memry-core --release scan_bench -- --ignored --nocapture`.
/// Times what a query pays on a real `vectors.db`: the scan and the ranking,
/// the brute force the design picked over `sqlite-vec`.
#[test]
#[ignore]
fn scan_bench_ten_thousand_windows() {
    let path = std::env::temp_dir().join(format!("memry-scan-bench-{}.db", std::process::id()));
    let db = vector_db::open(&path, true).unwrap().expect("opted in");
    let mut seed = 0x2545_f491_4f6c_dd1d_u64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 40) as f32 / (1u64 << 24) as f32 - 0.5
    };
    let (notes, windows) = (1_250, 8);
    db.call_blocking(|conn| {
        for note in 0..notes {
            let vectors: Vec<VectorBytes> = (0..windows)
                .map(|_| {
                    let values: Vec<f32> = (0..DIMENSION).map(|_| next()).collect();
                    truncate_renormalize(&values).unwrap().to_le_bytes()
                })
                .collect();
            let state = NoteState {
                note_id: format!("note-{note}"),
                vector_key: "bench".into(),
                input_version: 6,
                source_key: [0; 32],
                window_count: windows,
            };
            VectorStore::new(conn).replace_note(&state, &vectors, 0)?;
        }
        Ok(())
    })
    .unwrap();

    let runs = 20;
    let (mut scanning, mut ranking) = (Duration::ZERO, Duration::ZERO);
    for _ in 0..runs {
        let started = Instant::now();
        let rows = db
            .call_blocking(|conn| VectorStore::new(conn).scan("bench"))
            .unwrap();
        let scanned = Instant::now();
        std::hint::black_box(nearest(&query(), rows).unwrap());
        scanning += scanned - started;
        ranking += scanned.elapsed();
    }
    drop(db);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    println!(
        "{} windows, per query: scan {:?}, nearest {:?}",
        notes * windows,
        scanning / runs,
        ranking / runs
    );
}
