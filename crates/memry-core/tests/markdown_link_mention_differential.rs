//! Random `((mention:…))` tokens through the Electron seed (the oracle) and the
//! Rust seed, compared on the blocks each builds. Both must make the same
//! promote-or-text decision and give the same `domain` for every token, or two
//! devices seeding one note merge two chips (#3871, #4685). Seeded, so a
//! failure replays. Ignored: it starts the Electron oracle, and the nightly
//! `markdown-fuzz` job runs it.
//!
//! `cargo test -p memry-core --features markdown --release --test
//! markdown_link_mention_differential -- --ignored --nocapture`, tuned by
//! `MEMRY_MENTION_INPUTS` (default 20000) and `MEMRY_MENTION_SEED`. A mismatch
//! lists the markdown and both answers; the fix adds the row to `mention-host-*`
//! in `apps/desktop/scripts/markdown-oracle/cases-parse.ts`.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::bn::node_to_block::canonical_blocks;
use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::seed::{SeedEnv, prepare_fragment_seed};
use memry_core::markdown::convert::serialize::BlockNoteSerializer;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use serde_json::{Value as Json, json};
use support::oracle::run_jobs;
use support::vector_compare::json_equal;

const SCHEMES: &[&str] = &[
    "https://",
    "http://",
    "HTTPS://",
    "ftp://",
    "x-y+z.1://",
    "mailto:",
    "note:",
    "https:",
    "https:/",
    "https:///",
    "1a://",
    "://",
    "",
];
const USERINFO: &[&str] = &["", "", "", "u@", "u:p@", "@", ":@", "a@b@", "\u{5d0}@"];
/// Labels, the RTL corpus first: Arabic-Indic digits, Arabic, Hebrew, U+0640,
/// Thaana, NKo and Syriac, then LTR, punycode, digits and ASCII oddities.
const LABELS: &[&str] = &[
    "\u{661}\u{662}\u{663}",
    "shop\u{663}",
    "\u{663}shop",
    "\u{6f1}\u{6f2}",
    "\u{645}\u{62b}\u{627}\u{644}",
    "\u{627}\u{62e}\u{62a}\u{628}\u{627}\u{631}",
    "\u{5e9}\u{5dc}\u{5d5}\u{5dd}",
    "\u{5d0}",
    "Z\u{5d0}",
    "\u{5d0}1",
    "1\u{5d0}",
    "a\u{640}b",
    "\u{640}",
    "\u{780}\u{781}",
    "\u{7ca}\u{7cb}",
    "\u{710}\u{712}",
    "\u{5d0}\u{301}",
    "a\u{200d}b",
    "example",
    "Example",
    "WWW",
    "www",
    "xn--bcher-kva",
    "xn--mgbh0fb",
    "xn--",
    "B\u{fc}cher",
    "\u{65e5}\u{672c}",
    "\u{3002}",
    "\u{ff41}",
    "com",
    "co",
    "il",
    "123",
    "0x7f",
    "a-b",
    "-a",
    "a_b",
    "%41",
    "a b",
    "a^b",
    "a|b",
    "",
];
const PORTS: &[&str] = &[
    "",
    "",
    "",
    ":",
    ":80",
    ":0080",
    ":65535",
    ":65536",
    ":99999999999",
    ":8a",
];
const IP: &[&str] = &[
    "[::1]",
    "[2001:DB8::1]",
    "[::ffff:1.2.3.4]",
    "[::1",
    "[]",
    "[g::1]",
];
const TAILS: &[&str] = &["", "", "/", "/a_b", "?q=1", "#f", "/p?q#f", "\\x", " x"];

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn pick<'a>(&mut self, list: &[&'a str]) -> &'a str {
        list[(self.next() % list.len() as u64) as usize]
    }
}

fn random_url(rng: &mut Rng) -> String {
    let mut url = String::from(rng.pick(SCHEMES));
    url.push_str(rng.pick(USERINFO));
    if rng.next().is_multiple_of(10) {
        url.push_str(rng.pick(IP));
    } else {
        for i in 0..1 + rng.next() % 3 {
            if i > 0 {
                url.push('.');
            }
            url.push_str(rng.pick(LABELS));
        }
    }
    url.push_str(rng.pick(PORTS));
    url.push_str(rng.pick(TAILS));
    url
}

/// The token payload: every byte outside `[A-Za-z0-9.-]` percent-encoded, as
/// the serializer writes it, or with `_ * ~ ! '` left raw as older builds did.
fn encode(url: &str, legacy: bool) -> String {
    url.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' => char::from(b).to_string(),
            b'_' | b'*' | b'~' | b'!' | b'\'' if legacy => char::from(b).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// One paragraph: the token as written, and repaired (a stray space).
fn markdown_of(rng: &mut Rng) -> String {
    let url = random_url(rng);
    let payload = encode(&url, rng.next().is_multiple_of(3));
    format!("A ((mention:{payload})) B ((mention:{payload} )) C\n")
}

fn rust_blocks(markdown: &str) -> Json {
    let types = CalloutTypes::new(Vec::new());
    let env = SeedEnv {
        callout_types: &types,
        embeds: &NoEmbeds,
        serializer: &BlockNoteSerializer,
        html_comments: true,
    };
    match prepare_fragment_seed(&env, markdown, None, None) {
        Ok(seed) => canonical_blocks(&seed.blocks),
        Err(_) => Json::Null,
    }
}

#[test]
#[ignore = "starts the Electron oracle: run by the nightly markdown-fuzz job"]
fn link_mention_seed_matches_electron() {
    let total: usize = std::env::var("MEMRY_MENTION_INPUTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20_000);
    let seed: u64 = std::env::var("MEMRY_MENTION_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x4685);
    let mut rng = Rng(seed);
    let mut mismatches = Vec::new();
    let mut done = 0;
    while done < total {
        let size = 2_000.min(total - done);
        let inputs: Vec<String> = (0..size).map(|_| markdown_of(&mut rng)).collect();
        let jobs: Vec<Json> = inputs.iter().map(|m| json!({ "markdown": m })).collect();
        let answers = run_jobs("memry-parse", &jobs).expect("oracle batch");
        for (markdown, answer) in inputs.iter().zip(answers) {
            let oracle = answer.map_or(Json::Null, |a| a["seed"]["blocks"].clone());
            let rust = rust_blocks(markdown);
            if json_equal(&oracle, &rust).is_err() {
                let inline = |blocks: &Json| blocks[0]["content"].to_string();
                mismatches.push(format!(
                    "{markdown:?}\n  oracle {}\n  rust   {}",
                    inline(&oracle),
                    inline(&rust)
                ));
            }
        }
        done += size;
        println!(
            "link mention differential: {done}/{total}, {} mismatches",
            mismatches.len()
        );
    }
    mismatches.truncate(40);
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
