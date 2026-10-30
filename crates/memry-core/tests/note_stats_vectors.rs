//! The `markdown-convert/note-stats.json` conformance file: what Electron's `syncNoteToCache`
//! measures in a vault file, reproduced by `domain::note_stats::measure`.

#![cfg(feature = "markdown")]

mod support;

use memry_core::domain::note_stats::measure;
use serde_json::json;
use support::vector_file;

#[test]
fn every_note_stats_case_matches_the_oracle() {
    let file = vector_file("markdown-convert/note-stats");
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(file["meta"]["caseCount"].as_u64(), Some(cases.len() as u64));
    for case in cases {
        let id = case["id"].as_str().expect("id");
        assert_eq!(case["expected"]["status"], "ok", "{id}: the oracle threw");
        let stats = measure(case["input"]["text"].as_str().expect("text"));
        let got = json!({
            "wordCount": stats.word_count,
            "characterCount": stats.character_count,
            "snippet": stats.snippet,
            "cover": stats.cover,
            "taskIds": stats.task_ids,
            "headerTags": stats.header_tags,
        });
        assert_eq!(got, case["expected"]["output"], "{id}");
    }
}
