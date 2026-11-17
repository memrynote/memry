//! Untrusted-input guards of the Readwise planners (`memry_desktop::readwise`): Readwise payloads
//! and note bodies are peer and vault data. Depth on a 2 MiB thread, linear step counts, output
//! bounds, and properties of the section reader and its damaged-marker rules.

use memry_core::markdown::bn::html_to_blocks::markdown_to_blocks;
use memry_desktop::readwise::highlights::{LinkedIds, highlight_url};
use memry_desktop::readwise::journal::{
    JournalBook, JournalWrite, plan_journal_write, read_day_section,
};
use memry_desktop::readwise::plan_append::{PlanAppendOptions, plan_append};
use memry_desktop::readwise::plan_note::{BookPlan, PlanNoteOptions, plan_note};
use memry_desktop::readwise::reader::{PlanReaderNoteOptions, plan_reader_note};
use memry_desktop::readwise::section::{
    SECTION_START, SectionProblem, SectionRead, hash_section_body, read_section, seal_section,
};
use memry_desktop::readwise::text::escape_paragraphs;
use memry_desktop::readwise::types::FrontmatterValue;
use memry_desktop::readwise::types::{
    CategorySwitches, FolderLayout, PublishedDate, ReaderDocument, ReadwiseBook, ReadwiseHighlight,
    ReadwiseTag, SavedImages,
};
use memry_desktop::readwise::{PlanError, planner_steps};
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;
use serde_json::{Value, json};
use std::collections::HashSet;

const END: &str = "<!-- readwise:end v1 last=2026-10-22T18:05:00.001Z hash=0badf00d -->";

fn highlight(id: i64, text: String) -> ReadwiseHighlight {
    ReadwiseHighlight {
        id,
        text: Some(text),
        location: Some(id as f64),
        created_at: Some("2026-10-22T18:05:00Z".into()),
        ..Default::default()
    }
}

fn plan(book: &ReadwiseBook) -> String {
    let images = SavedImages::new();
    let options = PlanNoteOptions {
        root: "Readwise",
        folder_layout: FolderLayout::ByCategory,
        categories: CategorySwitches::default(),
        time_zone: chrono_tz::UTC,
        images: &images,
    };
    match plan_note(book, &options).expect("plan") {
        BookPlan::Note(note) => note.section,
        other => panic!("not a note: {other:?}"),
    }
}

/// The planners hold no recursion: a megabyte of nesting-shaped text in a highlight and in a
/// note body plans on a 2 MiB thread.
#[test]
fn nesting_shaped_input_plans_on_a_small_stack() {
    on_small_stack(|| {
        let shapes = [
            "[[".repeat(500_000),
            "> ".repeat(500_000),
            "<a".repeat(500_000),
        ];
        for (id, text) in shapes.into_iter().enumerate() {
            let book = ReadwiseBook {
                user_book_id: 1,
                highlights: Some(vec![highlight(id as i64, text)]),
                ..Default::default()
            };
            assert!(plan(&book).starts_with(SECTION_START));
        }
        let body = format!("{SECTION_START}\n").repeat(200_000);
        assert!(matches!(
            read_section(&body),
            SectionRead::Missing {
                problem: SectionProblem::DuplicateMarkers,
                ..
            }
        ));
    });
}

/// TypeScript dedupes image URLs with `imageUrls.includes`, quadratic in the image count; the
/// port dedupes through a set.
#[test]
fn image_urls_dedupe_in_linear_steps() {
    let n = 20_000;
    let book = ReadwiseBook {
        user_book_id: 1,
        cover_image_url: Some("https://cdn.example.com/cover.png".into()),
        highlights: Some(
            (0..n)
                .map(|i| highlight(i, format!("![](https://cdn.example.com/{i}.png)")))
                .collect(),
        ),
        ..Default::default()
    };
    // One step per URL (cover included) and one per rendered highlight.
    assert_steps_at_most(
        "plan_note image urls",
        planner_steps,
        2 * n as usize + 10,
        || {
            plan(&book);
        },
    );
}

/// Each highlight is looked up in the note's linked ids twice: a set, not a scan.
#[test]
fn linked_ids_are_looked_up_in_linear_steps() {
    let n = 20_000;
    let highlights: Vec<_> = (0..n).map(|i| highlight(i, format!("h{i}"))).collect();
    let linked = LinkedIds::from_ids(0..n);
    let images = SavedImages::new();
    let options = PlanAppendOptions {
        last: Some("2026-10-22T00:00:00.000Z"),
        note_created: "2026-10-21T00:00:00.000Z",
        linked_ids: &linked,
        time_zone: chrono_tz::UTC,
        images: &images,
    };
    assert_steps_at_most(
        "plan_append linked ids",
        planner_steps,
        3 * n as usize + 10,
        || {
            assert_eq!(plan_append(&highlights, &options).unwrap().markdown, "");
        },
    );
}

#[test]
fn section_reading_visits_each_line_once() {
    let lines = 100_000;
    let body = format!("{SECTION_START}\n{}{END}", "- a line\n".repeat(lines));
    assert_steps_at_most("read_section lines", planner_steps, lines + 10, || {
        assert!(matches!(read_section(&body), SectionRead::Found { .. }));
    });
}

#[test]
fn escaping_stays_within_the_output_bound() {
    for unit in ["[[", "<a", "#a ", "[ ]", "![", "- ", "1. "] {
        let text = unit.repeat(10_000);
        assert_output_bounded(unit, text.len(), escape_paragraphs(&text).len());
    }
}

/// A line of a note body, weighted toward markers and their damaged forms.
fn marker_line() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(SECTION_START.to_string()),
        Just(format!("  {SECTION_START}\r")),
        Just(END.to_string()),
        Just("<!-- readwise:end v2 last=x hash=0 -->".to_string()),
        Just("<!-- readwise:end v1 last=x hash=XYZ -->".to_string()),
        Just("text <!-- readwise:start".to_string()),
        Just("<!-- readwise-day:start -->".to_string()),
        Just("<!-- readwise-day:end v1 hash=0 -->".to_string()),
        Just(String::new()),
        "[ -~\u{a0}\u{1F600}\r\t]{0,12}",
    ]
}

/// Text an untrusted payload field could hold to break out of a `[label](url)` link: line
/// breaks, link syntax, a code span or escape, a forged end marker, a remote image, a wiki
/// link, a tag, a frontmatter fence.
fn hostile() -> impl Strategy<Value = String> {
    let piece = prop_oneof![
        Just("\n".to_string()),
        Just("\r\n".to_string()),
        Just("\u{2028}".to_string()),
        Just(")".to_string()),
        Just("(".to_string()),
        Just("<!--".to_string()),
        Just(" readwise:end v1 last=x hash=0 -->".to_string()),
        Just(format!("\n{SECTION_START}\n")),
        Just("](http://evil.example/x)".to_string()),
        Just("![](https://evil.example/p.png)".to_string()),
        Just("[[Wiki]]".to_string()),
        Just("`".to_string()),
        Just("\\".to_string()),
        Just("[".to_string()),
        Just("]".to_string()),
        Just(" #tag".to_string()),
        Just("\n---\ntitle: x\n---\n".to_string()),
        Just("https://".to_string()),
        Just("http://ok.example/a".to_string()),
        "[ -~\u{a0}\t]{0,6}",
    ];
    prop::collection::vec(piece, 0..8).prop_map(|pieces| pieces.concat())
}

/// Highlight text that pairs with a backtick or backslash in a field after it: an open code
/// span, an escape, a wiki link. No `(`, so it holds no link of its own.
fn hostile_text() -> impl Strategy<Value = String> {
    let piece = prop_oneof![
        Just("a `b".to_string()),
        Just("`".to_string()),
        Just("\\".to_string()),
        Just("[[Secret]]".to_string()),
        "[ -'*-~]{0,6}",
    ];
    prop::collection::vec(piece, 0..6).prop_map(|pieces| pieces.concat())
}

/// A highlight whose text, Readwise link and location type are untrusted.
fn hostile_highlight(
    text: String,
    readwise_url: String,
    location_type: String,
) -> ReadwiseHighlight {
    ReadwiseHighlight {
        readwise_url: Some(readwise_url),
        location_type: Some(location_type),
        ..highlight(7, text)
    }
}

/// The hrefs of the links in BlockNote blocks, and the text runs outside links and code.
fn links_and_prose(blocks: &Value, links: &mut Vec<String>, prose: &mut Vec<String>) {
    match blocks {
        Value::Array(items) => items
            .iter()
            .for_each(|item| links_and_prose(item, links, prose)),
        Value::Object(item) => match item.get("type").and_then(Value::as_str) {
            Some("link") => links.push(item["href"].as_str().unwrap_or_default().to_string()),
            Some("text") if item["styles"]["code"] != json!(true) => {
                prose.push(item["text"].as_str().unwrap_or_default().to_string());
            }
            Some("text") => {}
            _ => item
                .values()
                .for_each(|value| links_and_prose(value, links, prose)),
        },
        _ => {}
    }
}

/// TypeScript's `HEADING_TAGS[name]` and `name in HEADING_TAGS` read `Object.prototype`, so a
/// tag named `constructor` or `__proto__` is a heading marker to it. Here they are ordinary tags
/// (module docs, Departures).
#[test]
fn prototype_named_tags_are_ordinary_tags() {
    let mut h = highlight(1, "text".into());
    h.tags = Some(
        ["constructor", "__proto__"]
            .map(|name| ReadwiseTag { name: name.into() })
            .to_vec(),
    );
    let book = ReadwiseBook {
        user_book_id: 1,
        highlights: Some(vec![h]),
        ..Default::default()
    };
    let section = plan(&book);
    let line = section
        .lines()
        .find(|line| line.starts_with("- text "))
        .expect("a list item, not a heading");
    assert!(line.ends_with(" #constructor #proto__"), "{line}");
}

/// A decimal `serde_json`'s fast float parser rounds one ULP off: production parsing must be
/// correctly rounded, as `JSON.parse` is (`float_roundtrip` in `[dependencies]`).
#[test]
fn payload_numbers_parse_correctly_rounded() {
    const HARD: &str = "8.36705911238380268e-6";
    let exact = HARD.parse::<f64>().unwrap().to_bits();
    let h: ReadwiseHighlight =
        serde_json::from_str(&format!(r#"{{"id":1,"location":{HARD}}}"#)).unwrap();
    assert_eq!(h.location.map(f64::to_bits), Some(exact));
    let d: ReaderDocument =
        serde_json::from_str(&format!(r#"{{"id":"d","published_date":{HARD}}}"#)).unwrap();
    assert!(matches!(d.published_date, Some(PublishedDate::Number(n)) if n.to_bits() == exact));
}

/// Cargo unifies dev-dependency features into this test binary, so the test above passes with
/// `float_roundtrip` in `[dev-dependencies]` only. This holds it on the production edge.
#[test]
fn float_roundtrip_is_a_production_feature() {
    let manifest = include_str!("../Cargo.toml");
    let dependencies = manifest
        .split("\n[")
        .find(|section| section.starts_with("dependencies]"))
        .expect("a [dependencies] table");
    let serde_json = dependencies
        .lines()
        .find(|line| line.starts_with("serde_json "))
        .expect("serde_json in [dependencies]");
    assert!(serde_json.contains("\"float_roundtrip\""), "{serde_json}");
}

/// Reader tag shapes against what `planReaderNote` does with each (measured in Node on the
/// frozen TypeScript): a `null` tag or a truthy non-string name throws `TypeError`, every other
/// shape plans. `Ok(None)` is a note without `tags`.
#[test]
fn reader_tag_shapes_plan_or_fail_as_typescript_does() {
    let cases = [
        (json!({ "k": null }), Err(PlanError::ReaderTag)),
        (json!({ "k": { "name": 5 } }), Err(PlanError::ReaderTag)),
        (json!({ "k": { "name": true } }), Err(PlanError::ReaderTag)),
        (json!({ "k": { "name": {} } }), Err(PlanError::ReaderTag)),
        (json!({ "k": { "name": ["a"] } }), Err(PlanError::ReaderTag)),
        (json!(["x", null]), Err(PlanError::ReaderTag)),
        (json!({ "k": { "name": 0 } }), Ok(Some(vec!["k"]))),
        (json!({ "k": { "name": false } }), Ok(Some(vec!["k"]))),
        (json!({ "k": { "name": null } }), Ok(Some(vec!["k"]))),
        (json!({ "k": "str" }), Ok(Some(vec!["k"]))),
        (json!({ "k": 5 }), Ok(Some(vec!["k"]))),
        (json!(["x", { "name": "y" }]), Ok(Some(vec!["0", "y"]))),
        (json!("ab"), Ok(Some(vec!["0", "1"]))),
        (json!([]), Ok(None)),
        (json!(5), Ok(None)),
        (json!(true), Ok(None)),
        (json!(null), Ok(None)),
    ];
    let images = SavedImages::new();
    let external = HashSet::new();
    let options = PlanReaderNoteOptions {
        root: "Readwise",
        folder_layout: FolderLayout::Flat,
        images: &images,
        full_text: None,
        book_external_ids: &external,
    };
    for (tags, expected) in cases {
        let document: ReaderDocument =
            serde_json::from_value(json!({ "id": "d", "tags": tags })).expect("document parses");
        let planned = plan_reader_note(&document, &options).map(|plan| {
            let plan = plan.expect("a note");
            plan.note
                .frontmatter
                .into_iter()
                .find(|(key, _)| *key == "tags")
                .map(|(_, value)| match value {
                    FrontmatterValue::List(names) => names,
                    other => panic!("tags as {other:?}"),
                })
        });
        let expected = expected.map(|names| {
            names.map(|names: Vec<&str>| names.into_iter().map(String::from).collect())
        });
        assert_eq!(planned, expected, "tags {tags}");
    }
}

fn exact(line: &str, marker: &str) -> bool {
    line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}') == marker
}

proptest! {
    #![proptest_config(proptest_config(256))]

    /// An untrusted `readwise_url` or `location_type`, after untrusted highlight text, never
    /// breaks the section: it reads back untouched, and parsed as the editor parses it the
    /// highlight's link is its only link, and no prose outside it holds a wiki link or the URL.
    #[test]
    fn untrusted_link_fields_stay_inside_their_link(
        text in hostile_text(),
        url in hostile(),
        location_type in hostile(),
    ) {
        let h = hostile_highlight(text.clone(), url.clone(), location_type);
        let href = highlight_url(&h);
        let section = plan(&ReadwiseBook {
            user_book_id: 1,
            highlights: Some(vec![h]),
            ..Default::default()
        });
        prop_assert!(
            matches!(read_section(&section), SectionRead::Found { untouched: true, .. }),
            "{section}"
        );
        prop_assert_eq!(section.matches("](http").count(), 1, "{}", section);
        let blocks = markdown_to_blocks(&section).expect("the section parses");
        let (mut links, mut prose) = (Vec::new(), Vec::new());
        links_and_prose(&blocks, &mut links, &mut prose);
        prop_assert_eq!(&links, &vec![href], "{}", section);
        for run in &prose {
            prop_assert!(!run.contains("[["), "wiki link in {run:?}: {section}");
            prop_assert!(
                !url.starts_with("http") || text.contains(&url) || !run.contains(&url),
                "URL as prose in {run:?}: {section}"
            );
        }
    }

    /// The damaged-marker rules against a model that only counts marker lines.
    #[test]
    fn damaged_markers_follow_the_rules(lines in prop::collection::vec(marker_line(), 0..12)) {
        let body = lines.join("\n");
        let starts = lines.iter().filter(|l| exact(l, SECTION_START)).count();
        let ends = lines.iter().filter(|l| {
            let t = l.trim();
            t.starts_with("<!-- readwise:end ") && t.ends_with(" -->")
        }).count();
        let inline = lines.iter().any(|l| {
            !exact(l, SECTION_START) && !l.trim().starts_with("<!-- readwise:end ")
                && (l.contains("<!-- readwise:start") || l.contains("<!-- readwise:end"))
        });
        match read_section(&body) {
            SectionRead::Found { range, text, untouched, marker } => {
                prop_assert!(!inline && starts == 1 && ends == 1);
                prop_assert!(body[range.clone()].contains(text));
                prop_assert_eq!(untouched, marker.is_some_and(|m| m.hash == hash_section_body(text)));
            }
            SectionRead::Missing { problem, end } => {
                let expected = if inline {
                    SectionProblem::InlineMarker
                } else if starts > 1 || ends > 1 {
                    SectionProblem::DuplicateMarkers
                } else if ends == 0 && starts == 0 {
                    SectionProblem::NoStart
                } else if ends == 0 {
                    SectionProblem::NoEnd
                } else if starts == 0 {
                    SectionProblem::NoStart
                } else {
                    SectionProblem::OutOfOrder
                };
                prop_assert_eq!(problem, expected);
                prop_assert_eq!(end.is_some(), ends == 1 && !inline && starts <= 1);
                if let Some(end) = end {
                    prop_assert!(body[end.range].trim().starts_with("<!-- readwise:end "));
                }
            }
        }
    }

    /// A sealed section of marker-free text reads back untouched, with its `last`.
    #[test]
    fn sealed_sections_read_back_untouched(body in "[ -~\u{a0}\u{1F600}\r\n\t]{0,80}", last in "[!-~]{1,24}") {
        prop_assume!(!body.contains("<!-- readwise"));
        let sealed = seal_section(&body, &last);
        let note = format!("intro\n\n{sealed}\n\noutro");
        match read_section(&note) {
            SectionRead::Found { untouched, marker, .. } => {
                prop_assert!(untouched);
                prop_assert_eq!(marker.map(|m| m.last), Some(last.clone()));
            }
            other => prop_assert!(false, "not found: {other:?}"),
        }
        prop_assert!(sealed.len() <= output_bound(body.len() + last.len()));
    }

    /// Line endings and trailing blanks the editor round trip may change leave the hash alone.
    #[test]
    fn the_hash_ignores_line_endings_and_trailing_blanks(lines in prop::collection::vec("[ -~\u{1F600}]{0,10}", 0..8)) {
        let lf = lines.join("\n");
        let crlf = lines.iter().map(|l| format!("{}  \t", l.trim_end())).collect::<Vec<_>>().join("\r\n");
        prop_assert_eq!(hash_section_body(&lf.lines().map(str::trim_end).collect::<Vec<_>>().join("\n")), hash_section_body(&crlf));
    }

    /// Escaping only inserts zero-width spaces, within the output bound.
    #[test]
    fn escaping_only_inserts_zero_width_spaces(text in "[#\\[\\]!<>xX =~`\\-+*0-9a-zA-Z\u{a0}\u{200b}\n]{0,60}") {
        let escaped = escape_paragraphs(&text);
        let strip = |s: &str| s.replace('\u{200b}', "");
        prop_assert_eq!(strip(&escaped), strip(&memry_desktop::readwise::text::normalize_paragraphs(&text)));
        prop_assert!(escaped.len() <= output_bound(text.len()));
    }

    /// Re-rendering an untouched day section is idempotent: the second plan changes nothing.
    #[test]
    fn day_rerender_is_idempotent(
        prefix in "[ -~\n]{0,30}",
        counts in prop::collection::vec(1u64..5, 1..4),
        later in 1u64..5,
    ) {
        prop_assume!(!prefix.contains("<!--"));
        let books = |extra: u64| -> Vec<JournalBook> {
            counts.iter().enumerate().map(|(i, c)| JournalBook {
                title: format!("Book {i}"),
                count: c + extra,
                first: format!("2026-10-22T0{i}:00:00.000Z"),
            }).collect()
        };
        let JournalWrite::Append { markdown } = plan_journal_write(None, &books(0), &[]) else {
            panic!("a missing entry gets the whole section");
        };
        let body = format!("{prefix}\n\n{markdown}\n");
        prop_assert!(read_day_section(&body).untouched());
        let JournalWrite::Update { content } = plan_journal_write(Some(&body), &books(later), &[]) else {
            panic!("new counts rewrite an untouched section");
        };
        prop_assert_eq!(plan_journal_write(Some(&content), &books(later), &[]), JournalWrite::Unchanged);
    }
}
