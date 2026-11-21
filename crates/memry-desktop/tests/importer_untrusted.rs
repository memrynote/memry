//! The importers read files from other apps' exports, so they hold the untrusted-input guards:
//! a deep frontmatter fails its note instead of the stack, the CSV and asset passes stay linear
//! in the input (counted in steps, never timed), a file too large to read is refused from its
//! size, a FIFO is refused instead of blocking the run, a malformed `%` escape stays as written,
//! a cancel lands between notes, and properties over arbitrary input keep the output within
//! the kit's bound.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use memry_core::markdown::frontmatter::{YamlMap, YamlValue};
use memry_desktop::attachments::{MAX_FILE_SIZE, SavedAttachment};
use memry_desktop::import::assets::{
    bytes_scanned, extract_asset_refs, percent_decode_ref, rewrite_asset_refs,
};
use memry_desktop::import::csv::{CsvImporter, map_rows, parse_csv, steps};
use memry_desktop::import::markdown::{MarkdownImporter, parse_frontmatter};
use memry_desktop::import::{
    ImportContext, ImportInput, ImportSink, ImportSummary, ImportedBookmark, ImportedJournalEntry,
    ImportedNote, ImportedTask, Importer, JournalEntry, MAX_SOURCE_BYTES, SinkError,
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

/// The language line picks gray-matter's engine as in Electron: YAML and JSON (name trimmed,
/// `json` exact) import; `javascript` (refused, never run), an unregistered name and invalid JSON
/// fail the file with unreadable frontmatter.
#[test]
fn a_frontmatter_language_line_imports_as_gray_matter_reads_it() {
    let json = "{\"title\": \"T\", \"k\": 1}";
    let failing = [
        ("---JSON", json),
        ("---Json", json),
        ("---js", json),
        ("---JS", json),
        ("--- javascript", json),
        ("---Javascript ", json),
        ("---coffee", json),
        ("---toml", json),
        ("---json", "title: T"),
    ];
    let importing = [
        ("---json", json),
        ("---json  ", json),
        ("--- json", json),
        ("---json\r", json),
        ("---", "title: T\nk: 1"),
        ("---yaml", "title: T\nk: 1"),
        ("--- YML ", "title: T\nk: 1"),
    ];
    let dir = tempfile::tempdir().unwrap();
    let write = |name: String, (open, matter): &(&str, &str)| {
        let file = format!("{open}\n{matter}\n---\nbody\n");
        fs::write(dir.path().join(name), file).unwrap();
    };
    for (at, case) in failing.iter().enumerate() {
        write(format!("failing-{at}.md"), case);
    }
    for (at, case) in importing.iter().enumerate() {
        write(format!("importing-{at}.md"), case);
    }

    let (summary, calls) = run(&MarkdownImporter, &[dir.path()]);
    let mut failed: Vec<&str> = summary
        .failed
        .iter()
        .map(|f| f.item.rsplit(['/', '\\']).next().unwrap())
        .collect();
    failed.sort_unstable();
    let mut expected: Vec<String> = (0..failing.len())
        .map(|at| format!("failing-{at}.md"))
        .collect();
    expected.sort_unstable();
    assert_eq!(failed, expected, "{summary:?}");
    assert_eq!(summary.imported, importing.len(), "{summary:?}");
    let notes: Vec<&Value> = calls.iter().filter(|c| c["op"] == "createNote").collect();
    assert_eq!(notes.len(), importing.len());
    for note in notes {
        assert_eq!(note["title"], "T", "{note}");
        assert_eq!(note["properties"], serde_json::json!([["k", 1]]), "{note}");
    }
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

#[test]
fn a_percent_not_followed_by_two_hex_digits_leaves_the_ref_as_written() {
    // `decodeURIComponent` throws on each of these; `from_str_radix` alone takes the sign.
    for reference in ["a%+1.png", "a%+F.png", "a%2.png", "a%zz.png"] {
        assert_eq!(percent_decode_ref(reference), reference);
    }
    assert_eq!(percent_decode_ref("my%20pic%2B1.png"), "my pic+1.png");
}

#[cfg(unix)]
fn mkfifo(path: &Path) {
    let name = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    // SAFETY: the path is NUL-terminated and outlives the call.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "mkfifo");
}

/// A FIFO would block the read until something writes to it, holding the run and its vault.
/// The runs go against a deadline, so a read that blocks fails the test instead of hanging it.
#[cfg(unix)]
#[test]
fn a_fifo_source_or_asset_is_refused_without_blocking_the_run() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("export");
    fs::create_dir(&folder).unwrap();
    mkfifo(&folder.join("pipe.png"));
    fs::write(
        folder.join("note.md"),
        "![](pipe.png)
",
    )
    .unwrap();
    let (note, csv) = (dir.path().join("pipe.md"), dir.path().join("pipe.csv"));
    mkfifo(&note);
    mkfifo(&csv);

    let (done, result) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        done.send((
            run(&MarkdownImporter, &[&folder, &note]),
            run(&CsvImporter, &[&csv]),
        ))
        .unwrap()
    });
    let ((summary, calls), (csv_summary, csv_calls)) = result
        .recv_timeout(std::time::Duration::from_secs(60))
        .expect("the imports returned");

    assert_eq!(ops(&calls, "saveAttachment"), 0, "{calls:?}");
    assert_eq!((summary.imported, summary.skipped), (1, 1), "{summary:?}");
    let created = calls
        .iter()
        .find(|call| call["op"] == "createNote")
        .unwrap();
    assert_eq!(created["content"], "![](pipe.png)\n", "the reference stays");
    for (summary, name) in [(&summary, "pipe.md"), (&csv_summary, "pipe.csv")] {
        assert_eq!(summary.failed.len(), 1, "{summary:?}");
        assert!(summary.failed[0].item.ends_with(name), "{summary:?}");
        assert_eq!(summary.failed[0].error, "Not a regular file");
    }
    assert!(csv_calls.is_empty(), "{csv_calls:?}");
}

/// Cancels the run as it saves its first attachment.
struct CancelOnSave {
    inner: RecordingSink,
    cancel: CancellationToken,
}

impl ImportSink for CancelOnSave {
    fn new_note_id(&self) -> String {
        self.inner.new_note_id()
    }

    fn save_attachment(
        &self,
        note_id: &str,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<SavedAttachment, SinkError> {
        self.cancel.cancel();
        self.inner.save_attachment(note_id, file_name, bytes)
    }

    fn create_note(&self, note: ImportedNote) -> Result<(), SinkError> {
        self.inner.create_note(note)
    }

    fn create_note_as_written(&self, note: ImportedNote) -> Result<(), SinkError> {
        self.inner.create_note_as_written(note)
    }

    fn inbox_project_id(&self) -> Option<String> {
        self.inner.inbox_project_id()
    }

    fn nested_subtasks(&self) -> bool {
        self.inner.nested_subtasks()
    }

    fn create_task(&self, task: ImportedTask) -> Result<String, SinkError> {
        self.inner.create_task(task)
    }

    fn complete_task(&self, id: &str, completed_at: Option<&str>) -> Result<(), SinkError> {
        self.inner.complete_task(id, completed_at)
    }

    fn archive_task(&self, id: &str) -> Result<(), SinkError> {
        self.inner.archive_task(id)
    }

    fn journal_entry_id(&self, date: &str) -> Result<String, SinkError> {
        self.inner.journal_entry_id(date)
    }

    fn read_journal_entry(&self, date: &str) -> Result<Option<JournalEntry>, SinkError> {
        self.inner.read_journal_entry(date)
    }

    fn create_journal_entry(&self, entry: ImportedJournalEntry) -> Result<(), SinkError> {
        self.inner.create_journal_entry(entry)
    }

    fn save_bookmark(&self, bookmark: ImportedBookmark) -> Result<(), SinkError> {
        self.inner.save_bookmark(bookmark)
    }
}

#[test]
fn a_cancel_lands_between_notes_never_inside_one() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.md"), "![](one.png) ![](two.png)\n").unwrap();
    fs::write(dir.path().join("b.md"), "# b\n").unwrap();
    fs::write(dir.path().join("one.png"), b"one").unwrap();
    fs::write(dir.path().join("two.png"), b"two").unwrap();
    let input = ImportInput {
        source_paths: vec![dir.path().to_string_lossy().into_owned()],
        options: None,
    };
    let (timeline, cancel) = (Timeline::default(), CancellationToken::new());
    let sink = CancelOnSave {
        inner: RecordingSink::new(Arc::clone(&timeline)),
        cancel: cancel.clone(),
    };
    let mut ctx = ImportContext::new("cancel", cancel, Box::new(|_| {}));

    MarkdownImporter.run(&input, &mut ctx, &sink).unwrap();

    let calls = timeline.lock().unwrap().clone();
    assert_eq!(ops(&calls, "saveAttachment"), 2, "{calls:?}");
    let created: Vec<&Value> = calls.iter().filter(|c| c["op"] == "createNote").collect();
    assert_eq!(created.len(), 1, "{calls:?}");
    assert_eq!(
        created[0]["content"],
        "![one.png](attachments/note-1/one.png) ![two.png](attachments/note-1/two.png)\n",
        "the note is written with every asset it references"
    );
    assert_eq!(ctx.summary().imported, 1);
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
