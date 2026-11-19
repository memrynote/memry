//! The importers read files from other apps' exports, so they hold the untrusted-input guards:
//! a deep frontmatter fails its note instead of the stack, the CSV and asset passes stay linear
//! in the input (counted in steps, never timed), a file too large to read is refused from its
//! size, and properties over arbitrary input keep the output within the kit's bound.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use memry_core::markdown::frontmatter::{YamlMap, YamlValue};
use memry_desktop::attachments::MAX_FILE_SIZE;
use memry_desktop::import::assets::{bytes_scanned, extract_asset_refs, rewrite_asset_refs};
use memry_desktop::import::csv::{CsvImporter, map_rows, parse_csv, steps};
use memry_desktop::import::markdown::{MarkdownImporter, parse_frontmatter};
use memry_desktop::import::{
    ImportContext, ImportInput, ImportSummary, Importer, MAX_SOURCE_BYTES,
};
use memry_test_kit::{assert_steps_at_most, on_small_stack, output_bound, proptest_config};
use proptest::prelude::*;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::import_support::{RecordingSink, Timeline};

/// Runs `importer` over `sources` into a recording sink: the summary and every sink call.
fn run(importer: &dyn Importer, sources: &[&Path]) -> (ImportSummary, Vec<Value>) {
    let input = ImportInput {
        source_paths: sources
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        options: None,
    };
    let timeline = Timeline::default();
    let sink = RecordingSink::new(Arc::clone(&timeline));
    let mut ctx = ImportContext::new("untrusted", CancellationToken::new(), Box::new(|_| {}));
    importer.run(&input, &mut ctx, &sink).unwrap();
    let calls = timeline.lock().unwrap().clone();
    (ctx.summary(), calls)
}

fn ops(calls: &[Value], op: &str) -> usize {
    calls.iter().filter(|call| call["op"] == op).count()
}

/// A file of `len` bytes that takes no disk space where the file system supports holes.
fn sparse(path: &Path, len: u64) {
    fs::File::create(path).unwrap().set_len(len).unwrap();
}

#[test]
fn deep_frontmatter_fails_its_note_on_a_small_stack() {
    let dir = tempfile::tempdir().unwrap();
    let deep = format!("---\nk: {}\n---\nbody\n", "[".repeat(100_000));
    fs::write(dir.path().join("deep.md"), &deep).unwrap();
    fs::write(dir.path().join("fine.md"), "# fine\n").unwrap();
    let root = dir.path().to_path_buf();

    let (summary, calls) = on_small_stack(move || {
        assert!(
            parse_frontmatter(&deep).is_err(),
            "a deep frontmatter is an error"
        );
        run(&MarkdownImporter, &[&root])
    });
    assert_eq!(summary.failed.len(), 1, "{summary:?}");
    assert!(summary.failed[0].item.ends_with("deep.md"));
    assert_eq!(summary.imported, 1, "the other note still imports");
    assert_eq!(ops(&calls, "createNote"), 1);
}

/// Only YAML frontmatter imports. A file whose opening line names another language (any case,
/// any space gray-matter trims) fails with unreadable frontmatter, as in Electron's patched
/// gray-matter (#5154): its block is never parsed as JSON nor run as JavaScript.
#[test]
fn a_non_yaml_frontmatter_language_fails_its_note() {
    let refused = [
        "---json",
        "---JSON",
        "---json  ",
        "--- json",
        "---json\r",
        "---js",
        "---JS",
        "--- javascript",
        "---Javascript ",
        "---coffee",
        "---toml",
    ];
    let dir = tempfile::tempdir().unwrap();
    for (at, open) in refused.iter().enumerate() {
        let file = format!("{open}\n{{\"title\": \"T\", \"k\": 1}}\n---\nbody\n");
        fs::write(dir.path().join(format!("refused-{at}.md")), file).unwrap();
    }
    for (at, open) in ["---", "---yaml", "--- YML "].iter().enumerate() {
        let file = format!("{open}\nk: 1\n---\nbody\n");
        fs::write(dir.path().join(format!("yaml-{at}.md")), file).unwrap();
    }

    let (summary, calls) = run(&MarkdownImporter, &[dir.path()]);
    let mut failed: Vec<&str> = summary
        .failed
        .iter()
        .map(|f| f.item.rsplit(['/', '\\']).next().unwrap())
        .collect();
    failed.sort_unstable();
    let mut expected: Vec<String> = (0..refused.len())
        .map(|at| format!("refused-{at}.md"))
        .collect();
    expected.sort_unstable();
    assert_eq!(failed, expected, "{summary:?}");
    assert!(
        summary
            .failed
            .iter()
            .all(|f| f.error.contains("is not supported")),
        "{summary:?}"
    );
    assert_eq!(summary.imported, 3, "the YAML files import");
    assert_eq!(ops(&calls, "createNote"), 3);
}

#[test]
fn csv_steps_are_linear_in_a_wide_header_over_short_rows() {
    // 2000 columns, then 2000 rows of one cell: a pass over every column of every row is 4
    // million steps.
    let header: Vec<String> = (0..2000).map(|at| format!("c{at}")).collect();
    let mut text = header.join(",");
    text.push('\n');
    text.push_str(&"x\n".repeat(2000));
    let bound = 2 * text.len() + 10;
    on_small_stack(move || {
        assert_steps_at_most("parse_csv + map_rows", steps, bound, || {
            let plan = map_rows(&parse_csv(&text));
            assert_eq!(plan.notes.len(), 2000);
        });
    });
}

#[test]
fn asset_ref_passes_are_linear_in_the_number_of_saved_refs() {
    let body: String = (0..1000)
        .map(|at| format!("![](img-{at}.png) ![[img-{at}.png|100]]\n"))
        .collect();
    let bound = 4 * body.len() + 10;
    on_small_stack(move || {
        assert_steps_at_most("extract + rewrite", bytes_scanned, bound, || {
            let refs = extract_asset_refs(&body);
            assert_eq!(refs.len(), 1000);
            let saved: HashMap<String, (usize, String)> = refs
                .into_iter()
                .enumerate()
                .map(|(order, reference)| (reference, (order, "x".to_owned())))
                .collect();
            let rewritten = rewrite_asset_refs(&body, &saved);
            assert_eq!(rewritten, "x x\n".repeat(1000));
        });
    });
}

#[test]
fn a_source_file_over_the_cap_fails_before_it_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let markdown = dir.path().join("big.md");
    let csv = dir.path().join("big.csv");
    sparse(&markdown, MAX_SOURCE_BYTES + 1);
    sparse(&csv, MAX_SOURCE_BYTES + 1);

    for (importer, path) in [
        (&MarkdownImporter as &dyn Importer, &markdown),
        (&CsvImporter, &csv),
    ] {
        let (summary, calls) = run(importer, &[path]);
        assert_eq!(summary.failed.len(), 1, "{summary:?}");
        assert_eq!(summary.failed[0].error, "File is larger than 100 MB");
        assert!(calls.is_empty(), "{calls:?}");
    }
}

#[test]
fn an_asset_over_the_attachment_cap_is_skipped_before_it_is_read() {
    let dir = tempfile::tempdir().unwrap();
    sparse(&dir.path().join("big.png"), MAX_FILE_SIZE as u64 + 1);
    fs::write(dir.path().join("note.md"), "![](big.png)\n").unwrap();

    let (summary, calls) = run(&MarkdownImporter, &[dir.path()]);
    assert_eq!(ops(&calls, "saveAttachment"), 0, "{calls:?}");
    assert_eq!((summary.imported, summary.skipped), (1, 1), "{summary:?}");
    let created = calls
        .iter()
        .find(|call| call["op"] == "createNote")
        .unwrap();
    assert_eq!(created["content"], "![](big.png)\n", "the reference stays");
}

/// Bytes a parsed frontmatter value holds: its strings and keys, one per node.
fn value_bytes(value: &YamlValue) -> usize {
    1 + match value {
        YamlValue::String(text) => text.len(),
        YamlValue::Binary(bytes) => bytes.len(),
        YamlValue::Seq(items) => items.iter().map(value_bytes).sum(),
        YamlValue::Map(map) => map_bytes(map),
        YamlValue::Null | YamlValue::Bool(_) | YamlValue::Number(_) | YamlValue::Date(_) => 0,
    }
}

fn map_bytes(map: &YamlMap) -> usize {
    map.iter()
        .map(|(key, value)| key.len() + value_bytes(value))
        .sum()
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn csv_notes_stay_within_the_output_bound(text in "[abc ,\"\r\n]{0,300}") {
        let before = steps();
        let parsed = parse_csv(&text);
        let plan = map_rows(&parsed);
        prop_assert!(steps() - before <= 2 * text.len() + 10);
        let out: usize = plan
            .notes
            .iter()
            .map(|note| note.title.len() + map_bytes(&note.properties))
            .sum();
        prop_assert!(out <= output_bound(text.len()), "{out} bytes from {}", text.len());
    }

    // Anchors, aliases and tags are left out: their expansion is the YAML loader's to bound,
    // and memry-core's frontmatter suites test it.
    #[test]
    fn frontmatter_and_asset_refs_stay_within_the_output_bound(
        yaml in "[a-z:\\- \n\\[\\]{},'\"#]{0,200}",
        body in "[a-z.!\\[\\]()|# /\n]{0,300}",
    ) {
        let source = format!("---\n{yaml}\n---\n{body}");
        if let Ok(parsed) = parse_frontmatter(&source) {
            let out = parsed.title.as_ref().map_or(0, String::len)
                + parsed.tags.iter().map(String::len).sum::<usize>()
                + map_bytes(&parsed.properties)
                + parsed.body.len();
            prop_assert!(out <= output_bound(source.len()), "{out} bytes from {}", source.len());
        }
        let before = bytes_scanned();
        let refs = extract_asset_refs(&body);
        prop_assert!(bytes_scanned() - before <= 2 * body.len());
        prop_assert!(refs.iter().map(String::len).sum::<usize>() <= body.len());
    }
}
