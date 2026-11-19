//! The Raindrop importer over CSV exports written to a temp folder: Electron's bookmark mapping
//! (title, content, tags, collection, created time), skipped and failed rows, Raindrop's CSV
//! dialect, the preview, and exports refused before any of their bookmarks is saved.

use std::path::{Path, PathBuf};

use memry_desktop::import::raindrop::{MAX_PLANNED_BYTES, RaindropImporter, steps};
use memry_desktop::import::{FailedItem, ImportContext, ImportInput, ImportSummary, Importer};
use memry_test_kit::{assert_steps_at_most, proptest_config};
use proptest::prelude::*;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::import_support::{RecordingSink, Timeline};

const HEADER: &str = "id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite";
const AT: &str = "2024-05-01T10:00:00.000Z";
const TOO_MANY: &str = "The picked Raindrop files hold more bookmarks than one import can take. \
                        Import fewer files at a time, or split the export into smaller files.";

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

fn export(dir: &Path, rows: &[&str]) -> PathBuf {
    write(dir, "export.csv", &format!("{HEADER}\n{}", rows.join("\n")))
}

fn input(paths: &[PathBuf]) -> ImportInput {
    ImportInput {
        source_paths: paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        options: None,
    }
}

struct Run {
    bookmarks: Vec<Value>,
    summary: ImportSummary,
}

fn run_full(
    importer: &RaindropImporter,
    paths: &[PathBuf],
    fail_url: Option<&str>,
    cancel: CancellationToken,
) -> Run {
    let timeline = Timeline::default();
    let mut sink = RecordingSink::new(timeline.clone());
    sink.fail_bookmark_url = fail_url.map(str::to_owned);
    let mut ctx = ImportContext::new("raindrop", cancel, Box::new(|_| {}));
    importer.run(&input(paths), &mut ctx, &sink).unwrap();
    let bookmarks = timeline
        .lock()
        .unwrap()
        .iter()
        .filter(|w| w["op"] == "saveBookmark")
        .cloned()
        .collect();
    Run {
        bookmarks,
        summary: ctx.summary(),
    }
}

fn run(paths: &[PathBuf]) -> Run {
    run_full(
        &RaindropImporter::default(),
        paths,
        None,
        CancellationToken::new(),
    )
}

fn urls(run: &Run) -> Vec<&str> {
    run.bookmarks
        .iter()
        .map(|b| b["sourceUrl"].as_str().unwrap())
        .collect()
}

fn failed(item: &str, error: &str) -> FailedItem {
    FailedItem {
        item: item.to_owned(),
        error: error.to_owned(),
    }
}

#[test]
fn a_full_row_becomes_a_link_bookmark() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(
        dir.path(),
        &[&format!(
            "1,My Title,My note,My excerpt,https://example.com,Reading,\"a,b\",{AT},https://cover,some highlight,true"
        )],
    );
    let run = run(&[path]);
    assert_eq!(
        run.bookmarks,
        vec![json!({
            "op": "saveBookmark",
            "title": "My Title",
            "content": "My note\n\nMy excerpt",
            "sourceUrl": "https://example.com",
            "createdAt": AT,
            "tags": ["a", "b", "Reading"],
            "metadata": {
                "url": "https://example.com",
                "excerpt": "My excerpt",
                "note": "My note",
                "folder": "Reading",
                "favorite": true,
                "heroImage": "https://cover",
                "highlights": "some highlight",
            },
        })]
    );
    assert_eq!(run.summary.imported, 1);
}

#[test]
fn quoted_cells_keep_their_commas_and_tags_are_trimmed_and_lowercased() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(
        dir.path(),
        &[&format!(
            "1,\"Hello, world\",\"a note\",\"an excerpt\",https://x.com,Reading,\"tag1, Tag2\",{AT},https://img,,TRUE "
        )],
    );
    let run = run(&[path]);
    let b = &run.bookmarks[0];
    assert_eq!(b["title"], "Hello, world");
    assert_eq!(b["tags"], json!(["tag1", "tag2", "Reading"]));
    assert_eq!(b["metadata"]["favorite"], true);
}

#[test]
fn an_empty_title_is_the_url_and_no_note_or_excerpt_is_no_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(
        dir.path(),
        &[&format!(
            "1,  ,  ,,https://no-title.com,Unsorted,,{AT},,,false"
        )],
    );
    let run = run(&[path]);
    assert_eq!(run.bookmarks[0]["title"], "https://no-title.com");
    assert_eq!(run.bookmarks[0]["content"], Value::Null);
}

#[test]
fn the_unsorted_collection_is_dropped_and_the_folder_tag_dedupes_against_the_tags() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(
        dir.path(),
        &[
            &format!("1,t,,,https://u.com,Unsorted,unsorted,{AT},,,false"),
            &format!("2,t,,,https://r.com,Reading,reading,{AT},,,false"),
            &format!("3,t,,,https://s.com, UNSORTED ,,{AT},,,false"),
        ],
    );
    let run = run(&[path]);
    let tags: Vec<&Value> = run.bookmarks.iter().map(|b| &b["tags"]).collect();
    assert_eq!(
        tags,
        [&json!(["unsorted"]), &json!(["reading"]), &json!([])]
    );
}

#[test]
fn a_created_time_that_is_not_an_iso_instant_is_the_import_time() {
    let dir = tempfile::tempdir().unwrap();
    let created = [
        "not-a-date",
        "2024-05-01",
        "2024-13-45T00:00:00Z",
        " 2024-05-01T10:00:00+02:00 ",
        "2024-05-01T10:00",
    ];
    let rows: Vec<String> = created
        .iter()
        .enumerate()
        .map(|(at, c)| format!("{at},t,,,https://d{at}.com,,,\"{c}\",,,false"))
        .collect();
    let rows: Vec<&str> = rows.iter().map(String::as_str).collect();
    let run = run(&[export(dir.path(), &rows)]);
    let got: Vec<&Value> = run.bookmarks.iter().map(|b| &b["createdAt"]).collect();
    assert_eq!(
        got,
        [
            &json!("<now>"),
            &json!("<now>"),
            &json!("<now>"),
            &json!("2024-05-01T10:00:00+02:00"),
            &json!("2024-05-01T10:00"),
        ]
    );
}

#[test]
fn rows_without_a_url_are_skipped_and_the_rest_imported() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(
        dir.path(),
        &[
            &format!("1,A,,,https://a.com,Reading,,{AT},,,false"),
            &format!("2,B,,,https://b.com,Unsorted,,{AT},,,false"),
            &format!("3,no url,,,  ,Unsorted,,{AT},,,false"),
        ],
    );
    let run = run(&[path]);
    assert_eq!(urls(&run), ["https://a.com", "https://b.com"]);
    assert_eq!(run.summary.imported, 2);
    assert_eq!(run.summary.skipped, 1);
    assert!(run.summary.failed.is_empty());
}

#[test]
fn a_bookmark_the_sink_refuses_fails_alone() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(
        dir.path(),
        &[
            &format!("1,A,,,https://a.com,Reading,,{AT},,,false"),
            &format!("2,B,,,https://b.com,Reading,,{AT},,,false"),
        ],
    );
    let run = run_full(
        &RaindropImporter::default(),
        &[path],
        Some("https://a.com"),
        CancellationToken::new(),
    );
    assert_eq!(urls(&run), ["https://b.com"]);
    assert_eq!(run.summary.imported, 1);
    assert_eq!(run.summary.failed, [failed("A", "db boom")]);
}

#[test]
fn a_file_that_is_not_a_raindrop_export_fails_and_the_others_import() {
    let dir = tempfile::tempdir().unwrap();
    let bad = write(dir.path(), "bad.csv", "a,b,c\n1,2,3");
    let empty = write(dir.path(), "empty.csv", "");
    let good = export(
        dir.path(),
        &[&format!("1,A,,,https://a.com,Reading,,{AT},,,false")],
    );
    let run = run(&[bad, empty, good]);
    assert_eq!(urls(&run), ["https://a.com"]);
    assert_eq!(
        run.summary.failed,
        [
            failed(
                "bad.csv",
                "Raindrop CSV header row (\"url\" column) not found"
            ),
            failed("empty.csv", "Raindrop CSV is empty"),
        ]
    );
}

#[test]
fn the_csv_dialect_is_raindrops_own() {
    let dir = tempfile::tempdir().unwrap();
    // BOM, a padded header, a repeated `url` column (the first wins), CRLF rows, a lone CR
    // outside quotes dropped and one inside quotes kept, a row of empty cells dropped and a
    // row of blank cells skipped as having no URL.
    let text = "\u{FEFF}title, url ,url,note\r\n\
                A,https://a.co\rm,https://second.com,\"one\rtwo\"\r\n\
                ,,,\r\n\
                \x20,\x20,,\r\n\
                B,https://b.com,,";
    let run = run(&[write(dir.path(), "dialect.csv", text)]);
    assert_eq!(urls(&run), ["https://a.com", "https://b.com"]);
    assert_eq!(run.bookmarks[0]["metadata"]["note"], "one\rtwo");
    assert_eq!(run.summary.skipped, 1);
}

#[test]
fn preview_counts_each_file_and_saves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let good = export(
        dir.path(),
        &[
            &format!("1,A,,,https://a.com,Reading,,{AT},,,false"),
            &format!("2,B,,,https://b.com,Unsorted,,{AT},,,false"),
        ],
    );
    let bad = write(dir.path(), "bad.csv", "a,b\n1,2");
    let preview = RaindropImporter::default()
        .preview(&input(&[good, bad]), &CancellationToken::new())
        .unwrap();
    assert_eq!(
        serde_json::to_value(preview).unwrap(),
        json!({ "groups": [
            {
                "label": "export.csv",
                "counts": [
                    { "labelKey": "import.stats.bookmarks", "value": 2 },
                    { "labelKey": "import.stats.withTags", "value": 1 },
                    { "labelKey": "import.stats.skipped", "value": 0 },
                ],
                "sampleTitles": ["A", "B"],
                "warnings": [],
            },
            {
                "label": "bad.csv",
                "counts": [],
                "error": {
                    "code": "raindrop.headerNotFound",
                    "message": "Raindrop CSV header row (\"url\" column) not found",
                },
            },
        ]})
    );
}

/// A file of `rows` one-letter bookmarks.
fn tiny_rows(dir: &Path, name: &str, rows: usize) -> PathBuf {
    write(dir, name, &format!("url\n{}", "x\n".repeat(rows)))
}

#[test]
fn an_export_past_the_budget_fails_in_the_summary_and_saves_none_of_its_bookmarks() {
    let dir = tempfile::tempdir().unwrap();
    let small = export(
        dir.path(),
        &[&format!("1,A,,,https://a.com,Reading,,{AT},,,false")],
    );
    let big = tiny_rows(dir.path(), "big.csv", 10_000);
    let importer = RaindropImporter { budget: 64 * 1024 };
    let run = run_full(&importer, &[small, big], None, CancellationToken::new());
    assert_eq!(urls(&run), ["https://a.com"]);
    assert_eq!(run.summary.failed, [failed("big.csv", TOO_MANY)]);
}

#[test]
fn the_budget_spans_every_picked_file() {
    let dir = tempfile::tempdir().unwrap();
    let first = tiny_rows(dir.path(), "first.csv", 60);
    let second = tiny_rows(dir.path(), "second.csv", 60);
    let importer = RaindropImporter { budget: 64 * 1024 };
    let alone = run_full(
        &importer,
        std::slice::from_ref(&second),
        None,
        CancellationToken::new(),
    );
    assert_eq!(alone.summary.imported, 60, "one file fits the budget");
    let both = run_full(&importer, &[first, second], None, CancellationToken::new());
    assert_eq!(both.summary.imported, 60);
    assert_eq!(both.summary.failed, [failed("second.csv", TOO_MANY)]);
}

#[test]
fn preview_refuses_an_export_past_the_budget() {
    let dir = tempfile::tempdir().unwrap();
    let big = tiny_rows(dir.path(), "big.csv", 10_000);
    let preview = RaindropImporter { budget: 64 * 1024 }
        .preview(&input(&[big]), &CancellationToken::new())
        .unwrap();
    let group = serde_json::to_value(&preview.groups[0]).unwrap();
    assert_eq!(group["error"], json!({ "message": TOO_MANY }));
}

#[test]
fn the_importer_runs_with_the_default_budget() {
    assert_eq!(RaindropImporter::default().budget, MAX_PLANNED_BYTES);
}

#[test]
fn a_cancelled_import_saves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(
        dir.path(),
        &[&format!("1,A,,,https://a.com,Reading,,{AT},,,false")],
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    let run = run_full(&RaindropImporter::default(), &[path], None, cancel);
    assert!(run.bookmarks.is_empty());
}

#[test]
fn reading_takes_steps_linear_in_the_export() {
    let dir = tempfile::tempdir().unwrap();
    let n = 200_000;
    let inputs = [
        format!("url\n{}", "\"".repeat(n)),
        format!("url,tags\n{}", ",".repeat(n)),
        format!("url,tags\nx,\"{}\"", "a,".repeat(n)),
        format!("url\n{}", "\"\"\"\r".repeat(n / 4)),
        format!("url,{}\nx", "url,".repeat(n / 4)),
    ];
    for (at, text) in inputs.iter().enumerate() {
        let path = write(dir.path(), &format!("steps{at}.csv"), text);
        assert_steps_at_most(&format!("input {at}"), steps, 2 * text.len(), || {
            run(&[path]);
        });
    }
}

fn quoted(cell: &str) -> String {
    format!("\"{}\"", cell.replace('"', "\"\""))
}

proptest! {
    #![proptest_config(proptest_config(64))]

    #[test]
    fn quoted_cells_read_back_as_written(
        rows in prop::collection::vec(("[a-z ,\"\r\n]{0,6}", "[a-z ,\"\r\n]{0,6}"), 0..12),
        crlf in any::<bool>(),
    ) {
        let dir = tempfile::tempdir().unwrap();
        let end = if crlf { "\r\n" } else { "\n" };
        let mut text = format!("title,url{end}");
        for (title, url) in &rows {
            text.push_str(&format!("{},{}{end}", quoted(title), quoted(url)));
        }
        let run = run(&[write(dir.path(), "p.csv", &text)]);
        let want: Vec<(String, String)> = rows
            .iter()
            .filter(|(_, url)| !url.trim().is_empty())
            .map(|(title, url)| {
                let url = url.trim().to_owned();
                let title = match title.trim() { "" => url.clone(), t => t.to_owned() };
                (title, url)
            })
            .collect();
        let got: Vec<(String, String)> = run
            .bookmarks
            .iter()
            .map(|b| (b["title"].as_str().unwrap().to_owned(), b["sourceUrl"].as_str().unwrap().to_owned()))
            .collect();
        prop_assert_eq!(got, want);
        let blank = rows.iter().filter(|(t, u)| t.is_empty() && u.is_empty()).count();
        prop_assert_eq!(run.summary.skipped, rows.len() - blank - run.bookmarks.len());
    }
}
