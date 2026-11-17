//! The Readwise planners against the vectors the TypeScript writes
//! (`apps/desktop/src/main/readwise/__vectors__/readwise-vectors.test.ts`). Every output is
//! compared whole, byte for byte. A failure means the Rust diverged from the vault format: fix
//! the Rust, never the vector.
//!
//! `reader-full-text.json` has no Rust reader yet: its converter is Step 32's `html_md.rs`
//! (the core BlockNote converter fails it, PR #3550 33b).

use std::collections::HashSet;
use std::path::PathBuf;

use chrono_tz::Tz;
use memry_desktop::readwise::highlights::{LinkedIds, image_highlight_url, linked_highlight_ids};
use memry_desktop::readwise::images::image_file_stem;
use memry_desktop::readwise::journal::{
    JournalBook, JournalWrite, highlight_day, highlight_instant, plan_journal_append,
    plan_journal_day, plan_journal_write, read_day_section,
};
use memry_desktop::readwise::plan_append::{PlanAppendOptions, plan_append};
use memry_desktop::readwise::plan_note::{BookPlan, NotePlan, PlanNoteOptions, plan_note};
use memry_desktop::readwise::reader::{PlanReaderNoteOptions, plan_reader_note};
use memry_desktop::readwise::section::{
    EndMarker, MarkerHash, SectionRead, hash_section_body, read_section, seal_section,
    write_end_marker,
};
use memry_desktop::readwise::types::{
    FolderLayout, Frontmatter, FrontmatterValue, ReaderDocument, ReadwiseBook, ReadwiseHighlight,
    SavedImages,
};
use serde_json::{Value, json};

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/readwise")
        .join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    serde_json::from_str(&text).expect("vector json")
}

fn str_of(value: &Value) -> &str {
    value.as_str().expect("string")
}

fn opt_str(value: &Value) -> Option<&str> {
    value.as_str()
}

fn tz(value: &Value) -> Tz {
    str_of(value).parse().expect("time zone")
}

fn images(options: &Value) -> SavedImages {
    options["images"]
        .as_array()
        .map(|pairs| {
            pairs
                .iter()
                .map(|p| (str_of(&p[0]).to_string(), str_of(&p[1]).to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn layout(value: &Value) -> FolderLayout {
    serde_json::from_value(value.clone()).expect("layout")
}

/// UTF-16 offset of a byte offset, as TypeScript reports ranges.
fn utf16_at(body: &str, byte: usize) -> usize {
    body[..byte].encode_utf16().count()
}

fn range_json(body: &str, range: &std::ops::Range<usize>) -> Value {
    json!({ "start": utf16_at(body, range.start), "end": utf16_at(body, range.end) })
}

fn section_json<M: MarkerHash>(
    body: &str,
    read: &SectionRead<'_, M>,
    marker: impl Fn(&M) -> Value,
) -> Value {
    let marker_json = |m: &Option<M>| m.as_ref().map_or(Value::Null, &marker);
    match read {
        SectionRead::Found {
            range,
            text,
            marker,
            untouched,
        } => json!({
            "found": true,
            "range": range_json(body, range),
            "text": text,
            "marker": marker_json(marker),
            "untouched": untouched,
        }),
        SectionRead::Missing { problem, end } => {
            let mut out =
                json!({ "found": false, "untouched": false, "problem": problem.as_str() });
            if let Some(end) = end {
                out["end"] = json!({ "range": range_json(body, &end.range), "marker": marker_json(&end.marker) });
            }
            out
        }
    }
}

fn book_marker(m: &EndMarker) -> Value {
    json!({ "last": m.last, "hash": m.hash })
}

#[test]
fn section_vectors() {
    let v = load("section.json");
    for case in v["hash"].as_array().unwrap() {
        assert_eq!(
            hash_section_body(str_of(&case["input"])),
            case["hash"],
            "{case}"
        );
    }
    let big = &v["bigHash"];
    let body = str_of(&big["unit"]).repeat(big["times"].as_u64().unwrap() as usize);
    assert_eq!(hash_section_body(&body), big["hash"]);
    for case in v["seal"].as_array().unwrap() {
        let out = seal_section(str_of(&case["body"]), str_of(&case["last"]));
        assert_eq!(out, case["out"], "{case}");
    }
    for case in v["endMarker"].as_array().unwrap() {
        let marker = EndMarker {
            last: str_of(&case["last"]).into(),
            hash: str_of(&case["hash"]).into(),
        };
        assert_eq!(write_end_marker(&marker), case["out"]);
    }
    for case in v["read"].as_array().unwrap() {
        let body = str_of(&case["body"]);
        let out = section_json(body, &read_section(body), book_marker);
        assert_eq!(out, case["out"], "{}", case["name"]);
    }
    for case in v["readDay"].as_array().unwrap() {
        let body = str_of(&case["body"]);
        let out = section_json(body, &read_day_section(body), |m| json!({ "hash": m.hash }));
        assert_eq!(out, case["out"], "{}", case["name"]);
    }
}

/// The note written by the TypeScript planner and put through Electron's editor round trip
/// reads back as untouched.
#[test]
fn a_typescript_written_note_reads_untouched() {
    let v = load("section.json");
    let cases: Vec<&Value> = v["read"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| str_of(&c["name"]).starts_with("editor round trip"))
        .collect();
    assert_eq!(cases.len(), 2);
    for case in cases {
        assert!(
            read_section(str_of(&case["body"])).untouched(),
            "{}",
            case["name"]
        );
    }
}

fn frontmatter_json(frontmatter: &Frontmatter) -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in frontmatter {
        let value = match value {
            FrontmatterValue::Text(text) => json!(text),
            FrontmatterValue::List(list) => json!(list),
            FrontmatterValue::Number(n) => Value::Number(n.clone()),
        };
        map.insert((*key).to_string(), value);
    }
    Value::Object(map)
}

fn note_json(plan: &NotePlan) -> Value {
    json!({
        "folder": plan.folder,
        "title": plan.title,
        "frontmatter": frontmatter_json(&plan.frontmatter),
        "section": plan.section,
        "last": plan.last,
        "imageUrls": plan.image_urls,
    })
}

/// Key order is part of the frontmatter the writer emits; `Value` equality ignores it.
fn assert_key_order(actual: &Value, expected: &Value, name: &Value) {
    let keys = |v: &Value| v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>());
    assert_eq!(keys(actual), keys(expected), "frontmatter order {name}");
}

#[test]
fn plan_note_vectors() {
    let v = load("plan-note.json");
    for case in v.as_array().unwrap() {
        let book: ReadwiseBook = serde_json::from_value(case["book"].clone()).expect("book");
        let o = &case["options"];
        let saved = images(o);
        let options = PlanNoteOptions {
            root: str_of(&o["root"]),
            folder_layout: layout(&o["folderLayout"]),
            categories: serde_json::from_value(o["categories"].clone()).unwrap(),
            time_zone: tz(&o["timeZone"]),
            images: &saved,
        };
        let out = match plan_note(&book, &options) {
            Err(_) => json!({ "error": "RangeError" }),
            Ok(BookPlan::Skipped) => Value::Null,
            Ok(BookPlan::Deleted { readwise_url }) => {
                json!({ "deleted": true, "readwiseUrl": readwise_url })
            }
            Ok(BookPlan::Note(plan)) => note_json(&plan),
        };
        assert_eq!(out, case["out"], "{}", case["name"]);
        assert_key_order(
            &out["frontmatter"],
            &case["out"]["frontmatter"],
            &case["name"],
        );
    }
}

#[test]
fn plan_append_vectors() {
    let v = load("plan-append.json");
    for case in v["cases"].as_array().unwrap() {
        let highlights: Vec<ReadwiseHighlight> =
            serde_json::from_value(case["highlights"].clone()).unwrap();
        let o = &case["options"];
        let saved = images(o);
        let linked = LinkedIds::from_ids(
            o["linkedIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_i64().unwrap()),
        );
        let options = PlanAppendOptions {
            last: opt_str(&o["last"]),
            note_created: str_of(&o["noteCreated"]),
            linked_ids: &linked,
            time_zone: tz(&o["timeZone"]),
            images: &saved,
        };
        let out = match plan_append(&highlights, &options) {
            Ok(plan) => json!({ "markdown": plan.markdown, "last": plan.last }),
            Err(_) => json!({ "error": "RangeError" }),
        };
        assert_eq!(out, case["out"], "{}", case["name"]);
    }
    for case in v["linkedIds"].as_array().unwrap() {
        let ids = linked_highlight_ids(str_of(&case["markdown"]));
        let expected: Vec<f64> = case["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_f64().unwrap())
            .collect();
        assert_eq!(ids.ids(), expected.as_slice(), "{}", case["markdown"]);
    }
    for case in v["imageUrl"].as_array().unwrap() {
        let highlight = ReadwiseHighlight {
            id: 1,
            text: Some(str_of(&case["text"]).into()),
            ..Default::default()
        };
        assert_eq!(
            image_highlight_url(&highlight).map_or(Value::Null, Value::from),
            case["url"],
            "{}",
            case["text"]
        );
    }
}

fn journal_books(value: &Value) -> Vec<JournalBook> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|b| JournalBook {
            title: str_of(&b["title"]).into(),
            count: b["count"].as_u64().unwrap(),
            first: str_of(&b["first"]).into(),
        })
        .collect()
}

#[test]
fn journal_vectors() {
    let v = load("journal.json");
    for case in v["day"].as_array().unwrap() {
        assert_eq!(
            plan_journal_day(&journal_books(&case["books"])),
            case["out"],
            "{}",
            case["name"]
        );
    }
    for case in v["append"].as_array().unwrap() {
        assert_eq!(
            plan_journal_append(&journal_books(&case["books"])),
            case["out"],
            "{}",
            case["name"]
        );
    }
    for case in v["titles"].as_array().unwrap() {
        let book = JournalBook {
            title: str_of(&case["title"]).into(),
            count: 1,
            first: "2026-10-22T00:00:00.000Z".into(),
        };
        assert_eq!(
            plan_journal_append(&[book]),
            case["out"],
            "{}",
            case["title"]
        );
    }
    for case in v["write"].as_array().unwrap() {
        let out = match plan_journal_write(
            opt_str(&case["body"]),
            &journal_books(&case["day"]),
            &journal_books(&case["arrivals"]),
        ) {
            JournalWrite::Append { markdown } => json!({ "kind": "append", "markdown": markdown }),
            JournalWrite::Update { content } => json!({ "kind": "update", "content": content }),
            JournalWrite::Unchanged => json!({ "kind": "unchanged" }),
        };
        assert_eq!(out, case["out"], "{}", case["name"]);
    }
    for case in v["dates"].as_array().unwrap() {
        let d = &case["dates"];
        let (at, created) = (opt_str(&d["highlightedAt"]), opt_str(&d["createdAt"]));
        let day = highlight_day(at, created, tz(&case["timeZone"]));
        assert_eq!(day.map_or(Value::Null, Value::from), case["day"], "{case}");
        let instant = highlight_instant(at, created);
        assert_eq!(
            instant.map_or(Value::Null, Value::from),
            case["instant"],
            "{case}"
        );
    }
}

#[test]
fn reader_vectors() {
    let v = load("reader.json");
    for case in v.as_array().unwrap() {
        let document: ReaderDocument =
            serde_json::from_value(case["document"].clone()).expect("document");
        let o = &case["options"];
        let saved = images(o);
        let external: HashSet<String> = o["bookExternalIds"]
            .as_array()
            .map(|ids| ids.iter().map(|id| str_of(id).to_string()).collect())
            .unwrap_or_default();
        let options = PlanReaderNoteOptions {
            root: str_of(&o["root"]),
            folder_layout: layout(&o["folderLayout"]),
            images: &saved,
            full_text: opt_str(&o["fullText"]),
            book_external_ids: &external,
        };
        let out =
            plan_reader_note(&document, &options)
                .expect("plan")
                .map_or(Value::Null, |plan| {
                    let mut out = note_json(&plan.note);
                    out["fullText"] = plan.full_text.map_or(Value::Null, Value::from);
                    out
                });
        assert_eq!(out, case["out"], "{}", case["name"]);
        assert_key_order(
            &out["frontmatter"],
            &case["out"]["frontmatter"],
            &case["name"],
        );
    }
}

#[test]
fn image_vectors() {
    let v = load("images.json");
    for case in v.as_array().unwrap() {
        assert_eq!(
            image_file_stem(str_of(&case["url"])),
            case["stem"],
            "{case}"
        );
    }
}
