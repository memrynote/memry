//! The model levels of the fold reproduce `packages/contracts/test-vectors/note-fold-model.json`,
//! which the Electron fold engine generates (`apps/desktop/scripts/note-fold-oracle/model.ts`):
//! the fallback Key, Takeaway and Topic lines, the lines of a model reply where one is cached,
//! the section lines, the levels ready, the words of each level, the word maps of the morph,
//! the prompt of every chunk, and which model replies the reply check accepts.
//!
//! Word maps are compared exactly for the notes whose word segments agree with ICU's
//! (`note_fold_vectors.rs` says which); for the others each map must rebuild its line. An
//! English note with dictionary-script runs counts more words here, as in `note_fold_vectors.rs`.

use std::collections::HashMap;

use memry_desktop::fold::FoldKey;
use memry_desktop::fold::FoldLayers;
use memry_desktop::fold::engine::{Prepared, assemble, prepare};
use memry_desktop::fold::model::{ChunkAi, ChunkParagraphAi, build_chunk_prompt, chunk_ai};
use memry_desktop::fold::sections::ParsedChunk;
use memry_desktop::fold::text::is_cjk;
use memry_desktop::fold::tokens::Zone;
use serde_json::{Value, json};

use crate::note_fold_text_vectors::dictionary;

fn read(file: &str) -> Value {
    let path = format!(
        "{}/../../packages/contracts/test-vectors/{file}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).expect(file)).expect("json")
}

/// The markdown of every document, by name, from `note-fold.json`.
fn documents() -> HashMap<String, String> {
    read("note-fold.json")["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|c| {
            (
                c["name"].as_str().expect("name").to_owned(),
                c["markdown"].as_str().expect("markdown").to_owned(),
            )
        })
        .collect()
}

/// `fakeReply` of `model.ts`.
fn fake_reply(chunk: &ParsedChunk) -> ChunkAi {
    ChunkAi {
        section_takeaway: format!(
            "{}: {} paragraphs",
            chunk.heading.as_deref().unwrap_or("Untitled"),
            chunk.paragraphs.len()
        ),
        paragraphs: chunk
            .paragraphs
            .iter()
            .map(|p| {
                let n = p.sentences.len() as u32;
                let first = p.sentences.first().unwrap_or(&p.text);
                let last = p.sentences.last().unwrap_or(&p.text);
                let words: Vec<&str> = first.split_whitespace().collect();
                ChunkParagraphAi {
                    brief: if n > 1 { vec![n - 1, 0] } else { vec![0] },
                    key: FoldKey {
                        takeaway: first.clone(),
                        reason: format!("Because {last}"),
                    },
                    takeaway: first.to_uppercase(),
                    topic: words
                        .iter()
                        .take(3)
                        .rev()
                        .copied()
                        .collect::<Vec<_>>()
                        .join(" "),
                    evidence: if n > 1 { vec![0, n - 1] } else { vec![0] },
                }
            })
            .collect(),
    }
}

/// `modelFields` of `model.ts`; `exact` false leaves the word maps out after checking that each
/// rebuilds its line.
fn model_fields(layers: &FoldLayers, exact: bool) -> Value {
    let sections: Vec<Value> = layers
        .sections
        .iter()
        .map(|s| {
            let paragraphs: Vec<Value> = s
                .paragraphs
                .iter()
                .map(|p| {
                    let lines = [
                        (
                            "keyTakeaway",
                            &p.morph.key_takeaway,
                            p.key.as_ref().map(|k| &k.takeaway),
                        ),
                        (
                            "keyReason",
                            &p.morph.key_reason,
                            p.key.as_ref().map(|k| &k.reason),
                        ),
                        ("takeaway", &p.morph.takeaway, Some(&p.takeaway)),
                        ("topic", &p.morph.topic, Some(&p.topic)),
                    ];
                    let mut morph = serde_json::Map::new();
                    for (name, tokens, line) in lines {
                        let encoded = tokens.as_ref().map(|tokens| {
                            let rebuilt: String = tokens.iter().map(|t| t.text.as_str()).collect();
                            assert_eq!(Some(&rebuilt), line, "{name} rebuilds its line");
                            tokens
                                .iter()
                                .map(|t| {
                                    let src = t.src.map(|s| s.to_string()).unwrap_or_default();
                                    format!("{src}|{}", t.text)
                                })
                                .collect::<Vec<_>>()
                        });
                        morph.insert(name.to_owned(), json!(encoded));
                    }
                    let mut value = json!({
                        "briefIdx": p.brief_idx,
                        "key": p.key,
                        "takeaway": p.takeaway,
                        "topic": p.topic,
                        "evidence": p.evidence,
                    });
                    if exact {
                        value["morph"] = Value::Object(morph);
                    }
                    value
                })
                .collect();
            json!({ "takeaway": s.takeaway, "paragraphs": paragraphs })
        })
        .collect();
    json!({
        "wordsByLevel": layers.words_by_level,
        "ready": layers.ready,
        "sections": sections,
    })
}

fn strip_morph(expected: &mut Value) {
    for section in expected["sections"].as_array_mut().expect("sections") {
        for p in section["paragraphs"].as_array_mut().expect("paragraphs") {
            p.as_object_mut().expect("paragraph").remove("morph");
        }
    }
}

/// A dictionary-script note counts at least Electron's words here; the counts are then taken
/// as equal.
fn bound_words(got: &mut Value, want: &Value, name: &str) {
    for level in ["full", "brief", "key", "takeaway", "topic"] {
        let pointer = format!("/wordsByLevel/{level}");
        let (here, icu) = (
            got.pointer(&pointer).and_then(Value::as_u64),
            want.pointer(&pointer).and_then(Value::as_u64),
        );
        assert!(here >= icu, "{name}{pointer}: {here:?} < {icu:?}");
        *got.pointer_mut(&pointer).expect("count") = want.pointer(&pointer).expect("count").clone();
    }
}

fn chunks(prepared: &Prepared) -> Vec<&ParsedChunk> {
    prepared.sections.iter().flat_map(|s| &s.chunks).collect()
}

fn actual(markdown: &str, exact: bool) -> Value {
    let prepared = prepare(markdown, Zone::Utc);
    let all = chunks(&prepared);
    let local = assemble("note", &prepared, |_| None);
    let written = assemble("note", &prepared, |chunk| {
        let index = all
            .iter()
            .position(|c| c.hash == chunk.hash && std::ptr::eq(*c, chunk));
        (index.expect("a chunk of the note") % 3 != 1).then(|| fake_reply(chunk))
    });
    let mut written_fields = model_fields(&written.layers, exact);
    written_fields["missing"] = json!(written.missing.iter().map(|c| &c.hash).collect::<Vec<_>>());
    json!({
        "local": model_fields(&local.layers, exact),
        "written": written_fields,
        "prompts": all
            .iter()
            .map(|chunk| build_chunk_prompt(chunk, &prepared.language))
            .collect::<Vec<_>>(),
    })
}

#[test]
fn the_model_levels_reproduce_every_vector() {
    let file = read("note-fold-model.json");
    let documents = documents();
    let cases = file["cases"].as_array().expect("cases");
    assert!(
        cases.len() >= 40,
        "too few folding documents: {}",
        cases.len()
    );
    let mut failed = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let markdown = &documents[name];
        let language = prepare(markdown, Zone::Utc).language;
        let mixed = !is_cjk(&language) && dictionary(markdown).is_some();
        let exact = !is_cjk(&language) && !mixed;
        let mut got = actual(markdown, exact);
        let mut want = case["expected"].clone();
        if !exact {
            strip_morph(&mut want["local"]);
            strip_morph(&mut want["written"]);
        }
        if mixed {
            bound_words(&mut got["local"], &want["local"], name);
            bound_words(&mut got["written"], &want["written"], name);
        }
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
fn the_reply_check_accepts_and_refuses_what_zod_does() {
    let file = read("note-fold-model.json");
    let documents = documents();
    let markdown = &documents[file["replyDocument"].as_str().expect("document")];
    let prepared = prepare(markdown, Zone::Utc);
    let chunk = chunks(&prepared)[0];
    let replies = file["replies"].as_array().expect("replies");
    assert!(replies.len() >= 15);
    for case in replies {
        let name = case["name"].as_str().expect("name");
        let got = chunk_ai(&case["reply"], chunk);
        assert_eq!(
            got.is_ok(),
            case["accepted"].as_bool().expect("accepted"),
            "{name}: {got:?}"
        );
        if let Ok(value) = got {
            assert_eq!(
                serde_json::to_value(&value).expect("json"),
                case["value"],
                "{name}"
            );
        }
    }
}
