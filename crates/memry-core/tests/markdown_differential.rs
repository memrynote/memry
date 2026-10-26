//! The Rust converter against the Electron one on mutated inputs. Ignored by
//! default (it starts the Vitest oracle per batch); the nightly job and
//! `cargo test -p memry-core --features markdown --release --test
//! markdown_differential -- --ignored --nocapture` run it.
//!
//! Inputs: the markdown of the `memry-parse` vectors, mutated by structure-aware
//! operators. Each input is seeded and read back on both sides and compared as
//! `roundtrip.json` compares it (markdown bytes, outcome, house style, note
//! body, unrepresentable nodes). A mismatch is minimised by deleting lines and
//! written to `target/markdown-fuzz/<hash>.json`; the fix adds the input to the
//! vectors (`apps/desktop/scripts/markdown-oracle/cases-parse.ts`) and
//! regenerates the class.
//!
//! `MEMRY_DIFF_INPUTS` (default 20000), `MEMRY_DIFF_BATCH` (500) and
//! `MEMRY_DIFF_SEED` (0x1848) tune a run.

#![cfg(feature = "markdown")]

mod support;

use std::collections::HashSet;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::PathBuf;

use serde_json::Value as Json;
use support::doc_case::{compare_roundtrip, roundtrip_of};
use support::oracle::doc_serialize;
use support::vector_file;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

const MARKERS: &[&str] = &[
    "- ",
    "1. ",
    "> ",
    "# ",
    "## ",
    "- [ ] ",
    "- [x] ",
    "```",
    "~~~",
    "$$",
    "---",
    "***",
    "| a | b |",
    "| --- | --- |",
    "<!-- c -->",
    "%% c %%",
    "> [!note] ",
    "> [!warning]",
    "[[Link]]",
    "#tag",
    "![[embed]]",
    "[^1]",
    "[^1]: note",
    "[a]: https://x.y",
    "\\",
    "    ",
    "\t",
    "- ",
    "  - ",
];

const HOSTILE: &[&str] = &[
    "\u{2028}",
    "\u{feff}",
    "\0",
    "\\",
    "\r\n",
    "\r",
    "\u{a0}",
    "\u{200b}",
    "😀",
    "é",
    "<",
    "&",
    "*",
    "_",
    "`",
    "~",
    "|",
    "[",
    "]",
    "(",
    ")",
    "!",
    "$",
    "{",
    "}",
    "^",
    "file:///C|/x",
    "file://h/C|/",
    "file:////s/x",
    "x-y://@",
    "![](x-y://h:\\)",
    "<img src=\"file:///C|/^\">",
];

fn mutate(rng: &mut Rng, seeds: &[String], pool: &[String]) -> String {
    let mut text = seeds[rng.below(seeds.len())].clone();
    for _ in 0..1 + rng.below(3) {
        let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
        let at = rng.below(lines.len());
        match rng.below(9) {
            0 => {
                lines.remove(at);
            }
            1 => lines.insert(at, lines[at].clone()),
            2 => {
                let other = rng.below(lines.len());
                lines.swap(at, other);
            }
            3 => lines[at] = format!("> {}", lines[at]),
            4 => lines[at] = format!("- {}", lines[at]),
            5 => lines.insert(at, MARKERS[rng.below(MARKERS.len())].to_owned()),
            6 => {
                let marker = MARKERS[rng.below(MARKERS.len())];
                lines[at] = format!("{marker}{}", lines[at]);
            }
            7 => {
                let chars: Vec<char> = lines[at].chars().collect();
                let cut = rng.below(chars.len() + 1);
                let hostile = HOSTILE[rng.below(HOSTILE.len())];
                lines[at] = format!(
                    "{}{hostile}{}",
                    chars[..cut].iter().collect::<String>(),
                    chars[cut..].iter().collect::<String>()
                );
            }
            _ => {
                let donor = &pool[rng.below(pool.len())];
                let donor: Vec<&str> = donor.split('\n').collect();
                lines.insert(at, donor[rng.below(donor.len())].to_owned());
            }
        }
        text = lines.join("\n");
        if rng.below(20) == 0 {
            // Truncate inside whatever construct is open.
            let keep: usize = text.chars().count().saturating_sub(rng.below(40));
            text = text.chars().take(keep).collect();
        }
        if rng.below(15) == 0 {
            text = text.replace('\n', "\r\n");
        }
    }
    text
}

fn seed_inputs() -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for file in ["markdown-convert/memry-parse", "markdown-convert/roundtrip"] {
        for case in vector_file(file)["cases"].as_array().expect("cases") {
            if let Some(markdown) = case["input"]["markdown"].as_str()
                && markdown.len() < 4000
                && seen.insert(markdown.to_owned())
            {
                out.push(markdown.to_owned());
            }
        }
    }
    out
}

/// The masking tokens end up in the output when a comment sits inside a math
/// fence (`MEMRYCMT`, `MEMRYEMO`...), each with a word drawn at random per
/// process on both sides. The word is not a contract, so it is blanked.
fn blank_process_words(value: &Json) -> Json {
    match value {
        Json::String(text) => {
            let mut out = String::new();
            let mut rest = text.as_str();
            while let Some(at) = rest.find("MEMRY") {
                // `MEMRY` plus three more bytes; a non-ASCII byte there is not a token.
                let Some((head, tail)) =
                    rest.is_char_boundary(at + 8).then(|| rest.split_at(at + 8))
                else {
                    out.push_str(&rest[..at + 5]);
                    rest = &rest[at + 5..];
                    continue;
                };
                out.push_str(head);
                let word = tail.bytes().take_while(u8::is_ascii_uppercase).count();
                if head.ends_with("CMT") || head[at..].starts_with("MEMRYEM") {
                    out.push('W');
                    rest = &tail[word..];
                } else {
                    rest = tail;
                }
            }
            out.push_str(rest);
            Json::String(out)
        }
        Json::Array(items) => Json::Array(items.iter().map(blank_process_words).collect()),
        Json::Object(map) => Json::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), blank_process_words(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `Err` carries what differs; `Ok` means both sides agree.
fn disagreement(input: &str, oracle: &Option<Json>) -> Result<(), String> {
    match (oracle, roundtrip_of(input)) {
        (None, Err(_)) => Ok(()),
        (None, Ok(_)) => Err("the oracle failed closed, the Rust seeded".to_owned()),
        (Some(_), Err(e)) => Err(format!("the oracle seeded, the Rust did not: {e}")),
        (Some(want), Ok(got)) => {
            compare_roundtrip(&blank_process_words(want), &blank_process_words(&got))
        }
    }
}

/// Deletes lines while the two sides still disagree.
fn minimise(input: &str, tag: &str) -> String {
    let mut best = input.to_owned();
    for round in 0..12 {
        let lines: Vec<&str> = best.split('\n').collect();
        if lines.len() < 2 {
            break;
        }
        let candidates: Vec<String> = (0..lines.len())
            .map(|skip| {
                lines
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| *i != skip)
                    .map(|(_, l)| *l)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect();
        let Ok(answers) = doc_serialize(&candidates, &format!("{tag}-min{round}")) else {
            break;
        };
        match candidates
            .iter()
            .zip(&answers)
            .find(|(c, a)| disagreement(c, a).is_err())
        {
            Some((smaller, _)) => best = smaller.clone(),
            None => break,
        }
    }
    best
}

fn env_number(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[test]
#[ignore = "starts the Electron oracle: run by the nightly markdown-fuzz job"]
fn markdown_differential() {
    let total = env_number("MEMRY_DIFF_INPUTS", 20_000) as usize;
    let batch = env_number("MEMRY_DIFF_BATCH", 500) as usize;
    let seed = env_number("MEMRY_DIFF_SEED", 0x1848);
    let seeds = seed_inputs();
    let mut rng = Rng(seed);
    let mut mismatches = Vec::new();
    let mut checked = 0;
    while checked < total {
        let size = batch.min(total - checked);
        let inputs: Vec<String> = (0..size)
            .map(|_| mutate(&mut rng, &seeds, &seeds))
            .collect();
        let answers = doc_serialize(&inputs, "diff").expect("oracle batch");
        for (input, answer) in inputs.iter().zip(&answers) {
            if let Err(why) = disagreement(input, answer) {
                let small = minimise(input, "diff");
                let mut hasher = DefaultHasher::new();
                small.hash(&mut hasher);
                let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../target/markdown-fuzz")
                    .join(format!("{:016x}.json", hasher.finish()));
                std::fs::create_dir_all(path.parent().expect("dir")).expect("mkdir");
                let report = serde_json::json!({ "input": small, "original": input, "why": why });
                std::fs::write(&path, serde_json::to_string_pretty(&report).expect("json"))
                    .expect("write");
                mismatches.push(format!("{}: {why}", path.display()));
            }
        }
        checked += size;
        println!(
            "markdown_differential: {checked}/{total}, {} mismatches",
            mismatches.len()
        );
    }
    println!(
        "markdown_differential: {checked} inputs, {} mismatches",
        mismatches.len()
    );
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
