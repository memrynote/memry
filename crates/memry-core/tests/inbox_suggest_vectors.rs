//! `tests/vectors/inbox_suggest.json`, written by Electron's folder scorer
//! (`apps/desktop/scripts/inbox-suggest-oracle/generate.ts`), reproduced by
//! `domain::inbox::suggest`. Paths, order, support, titles and every signal
//! are exact; numbers to 1e-12, because V8's `Math.pow` and the platform's
//! `powf` may round the ancestor decay differently in the last bit.

use memry_core::domain::inbox::suggest::{
    FolderHit, FolderSignals, corroborated_similarity, score_folders,
};
use serde_json::Value;

const VECTORS: &str = include_str!("vectors/inbox_suggest.json");

fn close(actual: f64, expected: &Value, what: &str) {
    let expected = expected.as_f64().expect("a number");
    assert!(
        (actual - expected).abs() < 1e-12,
        "{what}: {actual} vs {expected}"
    );
}

fn pairs(case: &Value, key: &str) -> Vec<(String, f64)> {
    case.get(key)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|pair| {
                    (
                        pair[0].as_str().expect("a folder").to_owned(),
                        pair[1].as_f64().expect("a score"),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn folder_scores_match_the_electron_oracle() {
    let vectors: Value = serde_json::from_str(VECTORS).expect("json");
    let cases = vectors["scores"].as_array().expect("cases");
    assert!(cases.len() >= 19);
    for case in cases {
        let name = case["name"].as_str().expect("a name");
        let hits = case
            .get("hits")
            .and_then(Value::as_array)
            .map(|hits| {
                hits.iter()
                    .map(|h| FolderHit {
                        folder: h["folder"].as_str().expect("folder").to_owned(),
                        similarity: h["similarity"].as_f64().expect("similarity"),
                        note_title: h
                            .get("noteTitle")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let signals = FolderSignals {
            hits,
            name_matches: pairs(case, "nameMatches"),
            tag_matches: pairs(case, "tagMatches"),
            exclude: case
                .get("exclude")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .map(|f| f.as_str().expect("folder").to_owned())
                        .collect()
                })
                .unwrap_or_default(),
            min_confidence: case
                .get("minConfidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            limit: case
                .get("limit")
                .and_then(Value::as_u64)
                .map(|l| usize::try_from(l).expect("a limit")),
        };
        let actual = score_folders(&signals);
        let expected = case["expected"].as_array().expect("expected");
        let paths: Vec<&str> = actual.iter().map(|s| s.path.as_str()).collect();
        let want: Vec<&str> = expected
            .iter()
            .map(|e| e["path"].as_str().expect("path"))
            .collect();
        assert_eq!(paths, want, "{name}");
        for (score, e) in actual.iter().zip(expected) {
            let what = format!("{name} / {}", score.path);
            close(score.confidence, &e["confidence"], &what);
            close(score.sim, &e["components"]["sim"], &what);
            close(score.name, &e["components"]["name"], &what);
            close(score.tag, &e["components"]["tag"], &what);
            assert_eq!(
                score.support as u64,
                e["support"].as_u64().expect("support"),
                "{what}"
            );
            assert_eq!(
                score.top_note_title.as_deref(),
                e.get("topNoteTitle").and_then(Value::as_str),
                "{what}"
            );
        }
    }
}

#[test]
fn corroboration_matches_the_electron_oracle() {
    let vectors: Value = serde_json::from_str(VECTORS).expect("json");
    for case in vectors["corroboration"].as_array().expect("cases") {
        let sims: Vec<f64> = case["sims"]
            .as_array()
            .expect("sims")
            .iter()
            .map(|s| s.as_f64().expect("a number"))
            .collect();
        close(
            corroborated_similarity(&sims),
            &case["expected"],
            &format!("{sims:?}"),
        );
    }
}
