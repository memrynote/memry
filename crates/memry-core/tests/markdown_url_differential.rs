//! Random `<img src>` values through the oracle (jsdom 27.4, whatwg-url 15.1)
//! and through the Rust reflection of `rules/url.rs`, compared on the block the
//! parse produces. Seeded, so a failure replays. Ignored: it starts the Electron
//! oracle, and the nightly `markdown-fuzz` job runs it.
//!
//! `MEMRY_URL_INPUTS` (default 20000), `MEMRY_URL_SEED`. A mismatch lists the
//! input and both answers; the fix adds the class to
//! `apps/desktop/scripts/markdown-oracle/cases-url.ts`.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::bn::html_to_blocks::html_to_blocks;
use serde_json::{Value as Json, json};
use support::oracle::run_jobs;
use support::vector_compare::json_equal;

const SCHEMES: &[&str] = &[
    "http",
    "HTTPS",
    "file",
    "ftp",
    "ws",
    "wss",
    "x-y",
    "mailto",
    "tel",
    "data",
    "blob",
    "about",
    "javascript",
    "memry-file",
    "",
];
const SEPARATORS: &[&str] = &[":", "://", ":///", ":////", "://///", "//", ":\\\\", "/"];
const HOSTS: &[&str] = &[
    "a.com",
    "A.COM:80",
    "[::1]",
    "[::1]:8080",
    "[2001:db8::1]",
    "host",
    "localhost",
    "1.2.3.4",
    "0x7f.1",
    "b\u{fc}cher.de",
    "",
    "@",
    "u:p@h",
    "h:",
    "h:\\",
    "C:",
    "C|",
    "host:99999",
    "%41",
];
const PIECES: &[&str] = &[
    "/", "/a", "/..", "/./", "/../", "./", "../", "/C|", "/C:", "/C|/", "/c|/x", "\\", "//", "///",
    "^", " ", "%20", "%zz", "{", "}", "|", "`", "\u{e9}", "\u{65e5}", "\t", ".", "..", "/a b",
    "/a^b",
];
const TAILS: &[&str] = &[
    "",
    "?q=1",
    "? q",
    "#f",
    "# f",
    " ?x",
    " #x",
    "?a^b",
    "#a^b",
    " ",
    "?\\",
    "#\\",
    "?a\\b#c\\d",
    "\\?x\\y",
];

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
    let mut url = String::new();
    if !rng.next().is_multiple_of(8) {
        url.push_str(rng.pick(SCHEMES));
        url.push_str(rng.pick(SEPARATORS));
    }
    if !rng.next().is_multiple_of(4) {
        url.push_str(rng.pick(HOSTS));
    }
    for _ in 0..rng.next() % 4 {
        url.push_str(rng.pick(PIECES));
    }
    url.push_str(rng.pick(TAILS));
    url
}

fn html_of(url: &str) -> String {
    let escaped = url
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;");
    format!("<img src=\"{escaped}\">")
}

#[test]
#[ignore = "starts the Electron oracle: run by the nightly markdown-fuzz job"]
fn img_src_matches_jsdom() {
    let total: usize = std::env::var("MEMRY_URL_INPUTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20_000);
    let seed: u64 = std::env::var("MEMRY_URL_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x1848);
    let mut rng = Rng(seed);
    let mut mismatches = Vec::new();
    let mut done = 0;
    while done < total {
        let size = 2_000.min(total - done);
        let urls: Vec<String> = (0..size).map(|_| random_url(&mut rng)).collect();
        let jobs: Vec<Json> = urls.iter().map(|u| json!({ "html": html_of(u) })).collect();
        let answers = run_jobs("html-to-blocks", &jobs, "url").expect("oracle batch");
        for (url, answer) in urls.iter().zip(answers) {
            let rust = html_to_blocks(&html_of(url)).ok();
            let same = match (&rust, &answer) {
                (None, None) => true,
                (Some(r), Some(o)) => json_equal(o, r).is_ok(),
                _ => false,
            };
            if !same {
                let url_of =
                    |blocks: &Option<Json>| blocks.as_ref().map(|b| b[0]["props"]["url"].clone());
                mismatches.push(format!(
                    "{url:?}\n  oracle {:?}\n  rust   {:?}",
                    url_of(&answer),
                    url_of(&rust)
                ));
            }
        }
        done += size;
        println!(
            "url differential: {done}/{total}, {} mismatches",
            mismatches.len()
        );
    }
    mismatches.truncate(40);
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
