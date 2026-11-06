//! The local fold reproduces `packages/contracts/test-vectors/note-fold.json`, which the
//! Electron fold engine generates (`apps/desktop/scripts/note-fold-oracle/`): the
//! detected language, the text after inline tokens, sections, chunk hashes, skipped blocks,
//! sentences and their Markdown, the Brief pick and the word counts of Full and Brief.
//!
//! Word segments (`srcTokens`, `srcSentenceStart`) are compared for non-CJK notes only. For
//! Japanese, Chinese and Korean, `Intl.Segmenter` splits words with ICU's dictionary and
//! `unicode-segmentation` with the UAX #29 rules, so the segments differ while their text is
//! the same; they only drive the word slide between levels, so a CJK case checks that they
//! rebuild the paragraph and that each sentence starts on a segment.

use memry_desktop::fold::engine::{assemble, local_brief, prepare};
use memry_desktop::fold::text::is_cjk;
use memry_desktop::fold::tokens::Zone;
use serde_json::{Value, json};

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/note-fold.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("note-fold.json")).expect("json")
}

fn actual(markdown: &str) -> (Value, bool) {
    let prepared = prepare(markdown, Zone::Utc);
    let layers = assemble("note", &prepared, |chunk| {
        local_brief(chunk, &prepared.language)
    });
    let cjk = is_cjk(&prepared.language);
    let layers = serde_json::to_value(&layers).expect("layers");
    let sections: Vec<Value> = layers["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .zip(&prepared.sections)
        .map(|(section, parsed)| {
            let paragraphs: Vec<Value> = section["paragraphs"]
                .as_array()
                .expect("paragraphs")
                .iter()
                .map(|p| {
                    let mut p = p.clone();
                    if cjk {
                        segments_rebuild(&p);
                        let object = p.as_object_mut().expect("paragraph");
                        object.remove("srcTokens");
                        object.remove("srcSentenceStart");
                    }
                    p
                })
                .collect();
            json!({
                "hash": section["hash"],
                "heading": section["heading"],
                "skipped": section["skipped"],
                "chunks": parsed.chunks.iter().map(|c| c.hash.clone()).collect::<Vec<_>>(),
                "paragraphs": paragraphs,
            })
        })
        .collect();
    let value = json!({
        "language": prepared.language,
        "source": prepared.source,
        "sourceHash": layers["sourceHash"],
        "foldable": layers["foldable"],
        "totalWords": layers["totalWords"],
        "wordsByLevel": layers["wordsByLevel"],
        "sections": sections,
    });
    (value, cjk)
}

fn segments_rebuild(paragraph: &Value) {
    let tokens: Vec<&str> = paragraph["srcTokens"]
        .as_array()
        .expect("srcTokens")
        .iter()
        .map(|t| t.as_str().expect("token"))
        .collect();
    assert_eq!(tokens.concat(), paragraph["text"].as_str().expect("text"));
    let starts = paragraph["srcSentenceStart"].as_array().expect("starts");
    assert_eq!(
        starts.len(),
        paragraph["sentences"].as_array().expect("s").len()
    );
    let mut offsets = vec![0usize];
    for token in &tokens {
        offsets.push(offsets.last().expect("offset") + token.len());
    }
    let text = paragraph["text"].as_str().expect("text");
    for (start, sentence) in starts
        .iter()
        .zip(paragraph["sentences"].as_array().expect("s"))
    {
        let at = offsets[start.as_u64().expect("start") as usize];
        assert!(
            text[at..].starts_with(sentence.as_str().expect("sentence")),
            "a sentence does not start on its segment: {sentence}"
        );
    }
}

fn strip_cjk_segments(expected: &Value) -> Value {
    let mut expected = expected.clone();
    for section in expected["sections"].as_array_mut().expect("sections") {
        for p in section["paragraphs"].as_array_mut().expect("paragraphs") {
            let object = p.as_object_mut().expect("paragraph");
            object.remove("srcTokens");
            object.remove("srcSentenceStart");
        }
    }
    expected
}

#[test]
fn the_local_fold_reproduces_every_vector() {
    let file = vectors();
    assert_eq!(file["levels"], json!(["full", "brief"]));
    assert_eq!(file["timeZone"], "UTC");
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 40);
    let mut failed = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let (got, cjk) = actual(case["markdown"].as_str().expect("markdown"));
        let want = if cjk {
            strip_cjk_segments(&case["expected"])
        } else {
            case["expected"].clone()
        };
        if got != want {
            failed.push(format!(
                "{name}:\n  want {}\n  got  {}",
                serde_json::to_string(&want).expect("json"),
                serde_json::to_string(&got).expect("json")
            ));
        }
    }
    assert!(
        failed.is_empty(),
        "{} cases differ:\n{}",
        failed.len(),
        failed.join("\n")
    );
}

#[test]
fn the_vectors_cover_english_turkish_and_japanese_and_both_sides_of_the_threshold() {
    let file = vectors();
    let cases = file["cases"].as_array().expect("cases");
    for written in ["en", "tr", "ja"] {
        let of = |foldable: bool| {
            cases
                .iter()
                .filter(|c| c["written"] == written && c["expected"]["foldable"] == foldable)
                .count()
        };
        assert!(of(true) >= 8, "{written}: too few folding notes");
        assert!(of(false) >= 1, "{written}: no note under the threshold");
    }
}
