//! What a user gets when a note holds Chinese, Japanese or Korean text.
//!
//! The FTS tokenizer is `porter unicode61`, which keeps a run of CJK letters
//! as ONE token and never segments it. A search finds a whole run or a prefix
//! of it, and never a word in the middle or at the end. Desktop has the same
//! tokenizer and the same query builder, so this table is the one in
//! `apps/desktop/src/main/database/queries/search-cjk.test.ts`, run through
//! Electron's `searchAll`. A row changes in both files or in neither.
//!
//! Real SQLite, real FTS5, the notes written through the update log as
//! `api_search.rs` does.

use crate::api_search::{vault, write_note};
use memry_core::domain::search::MatchKind;

/// id, title, body.
const NOTES: &[(&str, &str, &str)] = &[
    ("zh", "Chinese study", "我喜欢学习中文"),
    ("ja", "Japanese study", "日本語の勉強"),
    ("ko", "Korean study", "한국어 공부"),
    ("latin-first", "Plan A", "memry笔记"),
    ("latin-last", "Plan B", "笔记memry"),
    ("spaced", "Plan C", "hello 世界 world"),
    ("glued", "Plan D", "meeting会议"),
    ("title-adjacent", "项目Plan", ""),
    ("title-spaced", "Memry 笔记 notes", ""),
    ("title-cjk", "学习中文", ""),
];

/// Query, then the hits as `id:kind`. `exact` is a full-text hit and `fuzzy`
/// the title fallback. Hits are compared as a set: bm25 ties between notes of
/// equal length are not what this pins.
const CASES: &[(&str, &[&str])] = &[
    // A whole run.
    ("我喜欢学习中文", &["zh:exact"]),
    ("日本語の勉強", &["ja:exact"]),
    ("한국어 공부", &["ko:exact"]),
    // A prefix of a run.
    ("我喜欢", &["zh:exact"]),
    ("日本語", &["ja:exact"]),
    ("한국", &["ko:exact"]),
    // A word inside a run is not a token. `学习` and `中文` do not find `zh`
    // (`我喜欢学习中文`); they find only the note TITLED `学习中文`, whose
    // whole run starts with `学习`, or its title by the fuzzy fallback for
    // `中文`.
    ("学习", &["title-cjk:exact"]),
    ("中文", &["title-cjk:fuzzy"]),
    ("勉強", &[]),
    ("국어", &[]),
    // A space ends a Korean token, so the second word of `한국어 공부` is one.
    ("공부", &["ko:exact"]),
    // A single character inside a title is found by the fuzzy title fallback.
    ("记", &["title-spaced:fuzzy"]),
    // A Latin word glued to CJK is part of the same token: `meeting` is a
    // prefix of `meeting会议`, but `会议` is not a word in it.
    ("meeting", &["glued:exact"]),
    ("meeting会议", &["glued:exact"]),
    ("会议", &[]),
    // The same prefix rule for the CJK side first: `笔记` is a prefix of the
    // token `笔记memry` but not of `memry笔记`.
    ("笔记", &["title-spaced:exact", "latin-last:exact"]),
    // `memry` does not find the body `memry笔记`. Porter stems the typed word
    // to `memri` and leaves the glued token `memry笔记` as it is, so the
    // prefix never lines up. A space-separated `Memry` in a title is stemmed
    // both ways.
    ("memry", &["title-spaced:exact"]),
    ("memry 笔记", &["title-spaced:exact"]),
    // A space-separated CJK word inside Latin text is a token of its own.
    ("世界", &["spaced:exact"]),
    ("hello", &["spaced:exact"]),
    // A Latin word glued to CJK in a title is one token: `项目` is its prefix,
    // and `plan` finds the four `Plan` notes but not `项目Plan`.
    ("项目", &["title-adjacent:exact"]),
    ("项目Plan", &["title-adjacent:exact"]),
    (
        "plan",
        &[
            "latin-first:exact",
            "latin-last:exact",
            "glued:exact",
            "spaced:exact",
        ],
    ),
];

fn kind(kind: MatchKind) -> &'static str {
    match kind {
        MatchKind::Body => "exact",
        MatchKind::Fuzzy => "fuzzy",
        MatchKind::Alias => "alias",
    }
}

#[test]
fn each_cjk_query_finds_what_desktop_finds() {
    let (db, vault) = vault("cjk");
    for (id, title, body) in NOTES {
        write_note(&db, id, title, body);
    }
    let search = vault.search().expect("the index");
    search.reindex().expect("the reindex");

    for (query, expected) in CASES {
        let groups = search
            .search((*query).to_string(), None, 10)
            .unwrap_or_else(|error| panic!("search {query:?}: {error:?}"));
        let mut found: Vec<String> = groups
            .notes
            .iter()
            .map(|hit| format!("{}:{}", hit.id, kind(hit.match_kind)))
            .collect();
        found.sort();
        let mut expected: Vec<String> = expected.iter().map(|hit| (*hit).to_owned()).collect();
        expected.sort();
        assert_eq!(found, expected, "hits for {query:?}");
    }
}
