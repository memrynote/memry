//! Real and synthetic vaults through the Rust converter, against what the
//! Electron converter answered for the same bodies. Ignored by default.
//!
//! 1. Run the oracle (`apps/desktop/scripts/markdown-oracle/corpus.oracle.ts`):
//!    `MEMRY_CORPUS_OUT=/tmp/corpus.jsonl MEMRY_CORPUS_DIRS=<dir>:<dir>
//!    [MEMRY_CORPUS_SYNTHETIC=<empty dir>] pnpm --filter @memry/desktop exec
//!    vitest run --config config/vitest.config.ts --project markdown-oracle`.
//! 2. `MEMRY_CORPUS_JSONL=/tmp/corpus.jsonl MEMRY_CORPUS_DIRS=<same list, the
//!    synthetic dir included> cargo test -p memry-core --features markdown
//!    --release --test markdown_corpus -- --ignored --nocapture`.
//!
//! The output carries counts, the `pathHash` of a failing file, the field that
//! differs and the oracle's outcome, never note text (`MEMRY_CORPUS_SHOW=1`
//! adds the byte offset of the first difference when the oracle ran with
//! `MEMRY_CORPUS_WITH_CONTENT=1`). A panic in the converter is a failure of
//! that file.

#![cfg(feature = "markdown")]

mod support;

use std::collections::HashMap;
use std::panic::catch_unwind;
use std::path::{Path, PathBuf};

use memry_core::markdown::frontmatter::parse_markdown_note;
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use support::doc_case::roundtrip_of;

fn sha(data: &str) -> String {
    hex::encode(Sha256::digest(data.as_bytes()))
}

fn markdown_files(dir: &Path, found: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .expect("read_dir")
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".memry" || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            markdown_files(&path, found);
        } else if name.ends_with(".md") {
            found.push(path);
        }
    }
}

fn first_difference(want: &str, got: &str) -> usize {
    want.bytes()
        .zip(got.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| want.len().min(got.len()))
}

#[test]
#[ignore = "needs MEMRY_CORPUS_JSONL and MEMRY_CORPUS_DIRS: see the module docs"]
fn markdown_corpus() {
    let jsonl = std::env::var("MEMRY_CORPUS_JSONL").expect("MEMRY_CORPUS_JSONL");
    let dirs = std::env::var("MEMRY_CORPUS_DIRS").expect("MEMRY_CORPUS_DIRS");
    let show = std::env::var("MEMRY_CORPUS_SHOW").is_ok_and(|v| v == "1");
    let expected: HashMap<(String, String), Json> = std::fs::read_to_string(&jsonl)
        .expect("corpus jsonl")
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str::<Json>(l).expect("line"))
        .map(|r| {
            (
                (
                    r["pathHash"].as_str().unwrap_or("").to_owned(),
                    r["sha256"].as_str().unwrap_or("").to_owned(),
                ),
                r,
            )
        })
        .collect();

    let (mut files, mut failures, mut panics) = (0usize, Vec::new(), 0usize);
    let mut matched = std::collections::HashSet::new();
    for root in dirs.split(':').filter(|d| !d.is_empty()) {
        let root = Path::new(root);
        let mut found = Vec::new();
        markdown_files(root, &mut found);
        for path in found {
            let raw = std::fs::read_to_string(&path).expect("read");
            let relative = path.strip_prefix(root).expect("relative");
            let path_hash = sha(&relative.to_string_lossy())[..12].to_owned();
            let key = (path_hash.clone(), sha(&raw));
            let Some(want) = expected.get(&key) else {
                failures.push(format!(
                    "{path_hash}: not in the oracle output (stale jsonl?)"
                ));
                continue;
            };
            matched.insert(key);
            files += 1;
            let body = parse_markdown_note(&raw).expect("frontmatter").content;
            let ran = catch_unwind(|| roundtrip_of(&body));
            let got = match ran {
                Err(_) => {
                    panics += 1;
                    failures.push(format!("{path_hash}: the converter panicked"));
                    continue;
                }
                Ok(got) => got,
            };
            let oracle_outcome = want["outcome"].as_str().unwrap_or("-");
            match (want["seeded"] == Json::Bool(true), got) {
                (false, Err(_)) => {}
                (false, Ok(_)) => failures.push(format!(
                    "{path_hash}: the oracle failed closed, the Rust did not"
                )),
                (true, Err(e)) => failures.push(format!(
                    "{path_hash}: the Rust failed closed ({e}), oracle outcome {oracle_outcome}"
                )),
                (true, Ok(got)) => {
                    for (field, hash_key, text_key) in [
                        ("markdown", "expectedSha256", "expected"),
                        ("canonical", "canonicalSha256", "canonical"),
                    ] {
                        let ours = got[field].as_str();
                        let want_hash = want[hash_key].as_str();
                        if ours.map(sha).as_deref() != want_hash {
                            let at = match (show, want[text_key].as_str(), ours) {
                                (true, Some(w), Some(g)) => {
                                    format!(", first difference at byte {}", first_difference(w, g))
                                }
                                _ => String::new(),
                            };
                            failures.push(format!(
                                "{path_hash}: {field} differs (oracle outcome {oracle_outcome}){at}"
                            ));
                        }
                    }
                    if got["outcome"].as_str() != want["outcome"].as_str() {
                        failures.push(format!(
                            "{path_hash}: outcome {:?} vs oracle {oracle_outcome}",
                            got["outcome"]
                        ));
                    }
                }
            }
        }
    }
    let missing = expected.len() - matched.len();
    println!(
        "markdown_corpus: {files} files, {} mismatches, {panics} panics, {missing} oracle lines without a file",
        failures.len()
    );
    assert!(
        failures.is_empty() && missing == 0,
        "{}",
        failures.join("\n")
    );
}
