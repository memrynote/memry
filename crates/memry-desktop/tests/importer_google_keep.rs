//! The Google Keep importer over real temp folders and zips: attachments, archived and trashed
//! notes, checklists, labels as tags, timestamps, and exports it refuses before anything is
//! written. The byte-for-byte agreement with Electron is in `importer_vectors.rs`.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_desktop::attachments::{self, SavedAttachment};
use memry_desktop::import::google_keep::{
    GoogleKeepImporter, body_bytes_copied, map_keep_note, parse_keep_note,
};
use memry_desktop::import::zip::{MAX_NESTED_ZIP_BYTES, MAX_ZIP_NESTING, Zips};
use memry_desktop::import::{
    ImportContext, ImportInput, ImportSink, ImportSummary, ImportedBookmark, ImportedJournalEntry,
    ImportedNote, ImportedTask, Importer, JournalEntry, MAX_NOTE_JSON_BYTES, MAX_SOURCE_BYTES,
    SinkError,
};
use memry_test_kit::{assert_steps_at_most, on_small_stack, output_bound, proptest_config};
use proptest::prelude::*;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use zip::write::SimpleFileOptions;

/// Every write the importer asks for, in order: `id` for a minted id, `save <note> <name>`,
/// `note <id>`.
#[derive(Default)]
struct Sink {
    ids: AtomicUsize,
    calls: Mutex<Vec<String>>,
    notes: Mutex<Vec<ImportedNote>>,
}

impl Sink {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn notes(&self) -> Vec<ImportedNote> {
        self.notes.lock().unwrap().clone()
    }

    fn note(&self, title: &str) -> ImportedNote {
        self.notes()
            .into_iter()
            .find(|note| note.title == title)
            .unwrap_or_else(|| panic!("no note {title}"))
    }
}

impl ImportSink for Sink {
    fn new_note_id(&self) -> String {
        let id = format!("note-{}", self.ids.fetch_add(1, Ordering::SeqCst) + 1);
        self.calls.lock().unwrap().push(format!("id {id}"));
        id
    }

    fn save_attachment(
        &self,
        note_id: &str,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<SavedAttachment, SinkError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("save {note_id} {file_name}"));
        if !attachments::is_allowed_extension(attachments::extension(file_name)) {
            return Err(SinkError("refused".to_owned()));
        }
        Ok(SavedAttachment {
            path: format!("attachments/{note_id}/{file_name}"),
            name: file_name.to_owned(),
            size: bytes.len(),
            mime_type: attachments::mime_type(file_name),
            kind: attachments::kind_of(file_name),
            disk_path: Default::default(),
        })
    }

    fn create_note(&self, note: ImportedNote) -> Result<(), SinkError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("note {}", note.id.clone().unwrap_or_default()));
        self.notes.lock().unwrap().push(note);
        Ok(())
    }

    fn create_note_as_written(&self, _: ImportedNote) -> Result<(), SinkError> {
        unreachable!("Google Keep notes go through create_note")
    }

    fn inbox_project_id(&self) -> Option<String> {
        unreachable!("Google Keep creates no tasks")
    }

    fn nested_subtasks(&self) -> bool {
        unreachable!("Google Keep creates no tasks")
    }

    fn create_task(&self, _: ImportedTask) -> Result<String, SinkError> {
        unreachable!("Google Keep creates no tasks")
    }

    fn complete_task(&self, _: &str, _: Option<&str>) -> Result<(), SinkError> {
        unreachable!("Google Keep creates no tasks")
    }

    fn archive_task(&self, _: &str) -> Result<(), SinkError> {
        unreachable!("Google Keep creates no tasks")
    }

    fn journal_entry_id(&self, _: &str) -> Result<String, SinkError> {
        unreachable!("Google Keep writes no journal entries")
    }

    fn read_journal_entry(&self, _: &str) -> Result<Option<JournalEntry>, SinkError> {
        unreachable!("Google Keep writes no journal entries")
    }

    fn create_journal_entry(&self, _: ImportedJournalEntry) -> Result<(), SinkError> {
        unreachable!("Google Keep writes no journal entries")
    }

    fn save_bookmark(&self, _: ImportedBookmark) -> Result<(), SinkError> {
        unreachable!("Google Keep saves no bookmarks")
    }
}

fn input(sources: &[&Path]) -> ImportInput {
    ImportInput {
        source_paths: sources
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        options: None,
    }
}

fn run(sources: &[&Path]) -> (ImportSummary, Sink) {
    let sink = Sink::default();
    let mut ctx = ImportContext::new("keep", CancellationToken::new(), Box::new(|_| {}));
    GoogleKeepImporter
        .run(&input(sources), &mut ctx, &sink)
        .unwrap();
    (ctx.summary(), sink)
}

/// A Keep note's JSON with both timestamps set; `extra` adds or overrides fields.
fn keep(extra: Value) -> Vec<u8> {
    let mut note = json!({
        "title": "",
        "textContent": "",
        "createdTimestampUsec": 1_609_459_200_000_000_i64,
        "userEditedTimestampUsec": 1_609_459_200_000_000_i64,
    });
    note.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::to_vec(&note).unwrap()
}

fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        if name.ends_with('/') {
            zip.add_directory(*name, SimpleFileOptions::default())
                .unwrap();
        } else {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
    }
    zip.finish().unwrap().into_inner()
}

fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    fs::write(path, zip_bytes(entries)).unwrap();
}

fn skip_reasons(summary: &ImportSummary) -> Vec<(String, usize)> {
    summary
        .skipped_reasons
        .iter()
        .flatten()
        .map(|group| (group.reason.text().to_owned(), group.count))
        .collect()
}

#[test]
fn attachments_are_saved_under_the_id_the_note_is_created_with() {
    let dir = tempfile::tempdir().unwrap();
    let a = keep(json!({ "title": "Zipped", "textContent": "body",
        "attachments": [{ "filePath": "photo.png", "mimetype": "image/png" },
                        { "filePath": "gone.png", "mimetype": "image/png" }] }));
    write_zip(
        &dir.path().join("Takeout.zip"),
        &[
            ("Takeout/Keep/Zipped.json", &a),
            // Keyed by file name wherever the entry sits.
            ("Takeout/Keep/media/photo.png", b"png-bytes"),
        ],
    );
    fs::create_dir(dir.path().join("loose")).unwrap();
    let b = keep(json!({ "title": "Loose", "textContent": "text",
        "attachments": [{ "filePath": "doc.pdf", "mimetype": "application/pdf" }] }));
    fs::write(dir.path().join("loose/Loose.json"), b).unwrap();
    fs::write(dir.path().join("loose/doc.pdf"), b"%PDF").unwrap();

    let (summary, sink) = run(&[
        &dir.path().join("Takeout.zip"),
        &dir.path().join("loose/Loose.json"),
    ]);

    assert_eq!(summary.imported, 2);
    assert_eq!(summary.attachments, 2);
    assert_eq!(
        skip_reasons(&summary),
        [("Attachment file not found".to_owned(), 1)]
    );
    assert_eq!(
        sink.calls(),
        [
            "id note-1",
            "save note-1 photo.png",
            "note note-1",
            "id note-2",
            "save note-2 doc.pdf",
            "note note-2"
        ]
    );
    let zipped = sink.note("Zipped");
    assert_eq!(zipped.id.as_deref(), Some("note-1"));
    assert_eq!(
        zipped.content,
        "body\n\n![photo.png](attachments/note-1/photo.png)"
    );
    assert!(
        sink.note("Loose")
            .content
            .starts_with("text\n\n<!-- file:{\"url\":\"attachments/note-2/doc.pdf\"")
    );
}

#[test]
fn a_sibling_attachment_outside_the_json_folder_is_not_read() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("export")).unwrap();
    fs::write(dir.path().join("secret.png"), b"not yours").unwrap();
    let note = keep(json!({ "title": "Escape", "attachments": [
        { "filePath": "../secret.png", "mimetype": "image/png" },
        { "filePath": dir.path().join("secret.png").to_string_lossy(), "mimetype": "image/png" }] }));
    fs::write(dir.path().join("export/Escape.json"), note).unwrap();

    let (summary, sink) = run(&[&dir.path().join("export/Escape.json")]);

    assert_eq!(summary.imported, 1);
    assert_eq!(summary.attachments, 0);
    assert_eq!(
        skip_reasons(&summary),
        [("Attachment file not found".to_owned(), 2)]
    );
    assert_eq!(sink.calls(), ["id note-1", "note note-1"]);
}

#[test]
fn archived_and_trashed_notes_import_with_their_tags() {
    let dir = tempfile::tempdir().unwrap();
    write_zip(
        &dir.path().join("k.zip"),
        &[
            (
                "Archived.json",
                &keep(json!({ "title": "Old", "isArchived": true })),
            ),
            (
                "Trashed.json",
                &keep(json!({ "title": "Bin", "isTrashed": true })),
            ),
        ],
    );
    let (summary, sink) = run(&[&dir.path().join("k.zip")]);
    assert_eq!(summary.imported, 2);
    assert_eq!(sink.note("Old").tags, ["Keep/Archived"]);
    assert_eq!(sink.note("Bin").tags, ["Keep/Deleted"]);
    assert!(
        sink.notes()
            .iter()
            .all(|n| n.folder.as_deref() == Some("Google Keep"))
    );
}

#[test]
fn checklists_become_checkbox_lines_without_empty_items() {
    let raw = json!({ "title": "", "textContent": "ignored", "listContent": [
        { "text": " ", "isChecked": false }, { "text": "Milk", "isChecked": false },
        { "text": "Eggs", "isChecked": true }, { "text": "Jam", "isChecked": "yes" },
        { "text": 3, "isChecked": true }, "junk"],
        "createdTimestampUsec": 0, "userEditedTimestampUsec": 0 });
    let mapped = map_keep_note(&parse_keep_note(&raw).unwrap()).unwrap();
    assert_eq!(mapped.body, "- [ ] Milk\n- [x] Eggs\n- [ ] Jam");
    assert_eq!(
        mapped.title, "ignored",
        "the text's first line titles it before the list"
    );
}

#[test]
fn labels_color_and_pinned_become_keep_tags() {
    let raw = json!({ "title": " T ", "color": "RED", "isPinned": true,
        "labels": [{ "name": "work" }, "home", { "other": 1 }, 4],
        "attachments": [{ "filePath": "a.png", "mimetype": "image/png" }],
        "createdTimestampUsec": 0, "userEditedTimestampUsec": 0 });
    let mapped = map_keep_note(&parse_keep_note(&raw).unwrap()).unwrap();
    assert_eq!(mapped.title, "T");
    assert_eq!(
        mapped.tags,
        [
            "Keep/Color/RED",
            "Keep/Label/work",
            "Keep/Label/home",
            "Keep/Pinned",
            "Keep/Attachment"
        ]
    );
    let plain =
        json!({ "color": "DEFAULT", "createdTimestampUsec": 0, "userEditedTimestampUsec": 0 });
    let mapped = map_keep_note(&parse_keep_note(&plain).unwrap()).unwrap();
    assert!(mapped.tags.is_empty());
    assert_eq!(mapped.title, "Untitled");
}

#[test]
fn timestamps_are_iso_instants_of_the_microseconds() {
    let at = |usec: Value| {
        let raw = json!({ "createdTimestampUsec": usec, "userEditedTimestampUsec": 1_500 });
        map_keep_note(&parse_keep_note(&raw).unwrap()).map(|m| (m.created, m.modified))
    };
    assert_eq!(
        at(json!(1_609_459_200_000_000_i64)).unwrap(),
        (
            "2021-01-01T00:00:00.000Z".to_owned(),
            "1970-01-01T00:00:00.001Z".to_owned()
        )
    );
    assert_eq!(at(json!(-1500)).unwrap().0, "1969-12-31T23:59:59.998Z");
    assert_eq!(
        at(json!(-62_198_755_200_000_000_i64)).unwrap().0,
        "-000001-01-01T00:00:00.000Z"
    );
    assert_eq!(
        at(json!(253_402_300_800_000_000_i64)).unwrap().0,
        "+010000-01-01T00:00:00.000Z"
    );
    assert_eq!(at(json!(8.64e18)).unwrap().0, "+275760-09-13T00:00:00.000Z");
    assert_eq!(
        at(json!(8.640_000_000_001e18)).unwrap_err(),
        "Invalid time value"
    );
    assert!(
        parse_keep_note(&json!({ "createdTimestampUsec": "1", "userEditedTimestampUsec": 1 }))
            .is_none()
    );

    // The note record carries both instants; a note out of range fails alone.
    let dir = tempfile::tempdir().unwrap();
    write_zip(
        &dir.path().join("k.zip"),
        &[
            (
                "Far.json",
                &keep(json!({ "title": "Far", "createdTimestampUsec": 9e18 })),
            ),
            (
                "Near.json",
                &keep(
                    json!({ "title": "Near", "userEditedTimestampUsec": 1_609_545_600_123_456_i64 }),
                ),
            ),
        ],
    );
    let (summary, sink) = run(&[&dir.path().join("k.zip")]);
    assert_eq!(summary.failed.len(), 1);
    assert_eq!(summary.failed[0].item, "Far.json");
    assert_eq!(summary.failed[0].error, "Invalid time value");
    let near = sink.note("Near");
    assert_eq!(near.created.as_deref(), Some("2021-01-01T00:00:00.000Z"));
    assert_eq!(near.modified.as_deref(), Some("2021-01-02T00:00:00.123Z"));
    assert_eq!(sink.calls(), ["id note-1", "note note-1"]);
}

#[test]
fn malformed_json_is_refused_without_writing_anything() {
    let dir = tempfile::tempdir().unwrap();
    let bad = dir.path().join("bad.json");
    fs::write(&bad, b"{\"title\": ").unwrap();
    let (summary, sink) = run(&[&bad]);
    assert_eq!(summary.failed.len(), 1);
    assert_eq!(summary.failed[0].error, "Invalid JSON");
    assert!(sink.calls().is_empty());

    write_zip(
        &dir.path().join("bad.zip"),
        &[("broken.json", b"{not json"), ("list.json", b"[1, 2]")],
    );
    let (summary, sink) = run(&[&dir.path().join("bad.zip")]);
    assert_eq!(summary.imported, 0);
    assert_eq!(
        skip_reasons(&summary),
        [
            ("Invalid JSON".to_owned(), 1),
            ("Not a Google Keep note".to_owned(), 1)
        ]
    );
    assert!(sink.calls().is_empty());
}

#[test]
fn an_unreadable_export_fails_the_run_before_any_note_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let good = keep(json!({ "title": "Good" }));
    let unsafe_zip = dir.path().join("slip.zip");
    write_zip(
        &unsafe_zip,
        &[("Good.json", &good), ("../evil.json", &good)],
    );
    let not_zip = dir.path().join("fake.zip");
    fs::write(&not_zip, b"PK not really").unwrap();
    let loose = dir.path().join("Loose.json");
    fs::write(&loose, &good).unwrap();

    for broken in [&unsafe_zip, &not_zip] {
        let sink = Sink::default();
        let mut ctx = ImportContext::new("keep", CancellationToken::new(), Box::new(|_| {}));
        let result = GoogleKeepImporter.run(&input(&[&loose, broken]), &mut ctx, &sink);
        assert!(result.is_err(), "{broken:?} fails the run");
        assert!(sink.calls().is_empty(), "{broken:?}: {:?}", sink.calls());
    }
}

#[test]
fn nested_root_zips_import_up_to_the_nesting_cap() {
    let note = keep(json!({ "title": "Inner" }));
    let mut archive = zip_bytes(&[("Inner.json", &note)]);
    for _ in 1..MAX_ZIP_NESTING {
        archive = zip_bytes(&[("part.zip", &archive), ("sub/kept.zip", b"an attachment")]);
    }
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("ok.zip"), &archive).unwrap();
    let (summary, sink) = run(&[&dir.path().join("ok.zip")]);
    assert_eq!(summary.imported, 1);
    assert_eq!(sink.note("Inner").title, "Inner");

    fs::write(
        dir.path().join("deep.zip"),
        zip_bytes(&[("part.zip", &archive)]),
    )
    .unwrap();
    let sink = Sink::default();
    let mut ctx = ImportContext::new("keep", CancellationToken::new(), Box::new(|_| {}));
    let result = GoogleKeepImporter.run(&input(&[&dir.path().join("deep.zip")]), &mut ctx, &sink);
    assert!(result.is_err());
    assert!(sink.calls().is_empty());
}

#[test]
fn a_cancelled_import_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    write_zip(&dir.path().join("k.zip"), &[("A.json", &keep(json!({})))]);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let sink = Sink::default();
    let mut ctx = ImportContext::new("keep", cancel, Box::new(|_| {}));
    GoogleKeepImporter
        .run(&input(&[&dir.path().join("k.zip")]), &mut ctx, &sink)
        .unwrap();
    assert!(sink.calls().is_empty());
}

#[test]
fn an_entry_over_the_read_limit_is_refused_from_its_size() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("k.zip");
    write_zip(&path, &[("big.json", &[b'x'; 64])]);
    let mut zips = Zips::default();
    let mut seen = Vec::new();
    zips.walk(&path, &CancellationToken::new(), &mut |zips, entry| {
        seen.push(entry.name.clone());
        assert!(zips.read(entry.at, 63).is_err());
        assert_eq!(zips.read(entry.at, 64)?.len(), 64);
        Ok(())
    })
    .unwrap();
    assert_eq!(seen, ["big.json"]);
}

#[test]
fn deep_json_is_skipped_on_a_small_stack() {
    let dir = tempfile::tempdir().unwrap();
    let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
    write_zip(
        &dir.path().join("k.zip"),
        &[
            ("deep.json", deep.as_bytes()),
            ("ok.json", &keep(json!({ "title": "Ok" }))),
        ],
    );
    let path = dir.path().join("k.zip");
    let (summary, titles) = on_small_stack(move || {
        let (summary, sink) = run(&[&path]);
        (
            summary,
            sink.notes()
                .into_iter()
                .map(|n| n.title)
                .collect::<Vec<_>>(),
        )
    });
    assert_eq!(skip_reasons(&summary), [("Invalid JSON".to_owned(), 1)]);
    assert_eq!(titles, ["Ok"]);
}

#[test]
fn the_body_is_built_in_one_pass_over_many_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let count = 2_000;
    let refs: Vec<Value> = (0..count)
        .map(|_| json!({ "filePath": "p.png", "mimetype": "image/png" }))
        .collect();
    let body = "x".repeat(200_000);
    write_zip(
        &dir.path().join("k.zip"),
        &[
            (
                "N.json",
                &keep(json!({ "title": "N", "textContent": body, "attachments": refs })),
            ),
            ("p.png", b"png"),
        ],
    );
    let path = dir.path().join("k.zip");
    // One copy of the body plus each attachment's line; a rebuild per attachment copies the
    // body 2,000 times (400 MB).
    assert_steps_at_most(
        "body bytes",
        body_bytes_copied,
        2 * 200_000 + count * 64,
        || {
            let (summary, _) = run(&[&path]);
            assert_eq!(summary.attachments, count);
        },
    );
}

/// The run's error, with nothing written.
fn refused(sources: &[&Path]) -> String {
    let sink = Sink::default();
    let mut ctx = ImportContext::new("keep", CancellationToken::new(), Box::new(|_| {}));
    let error = GoogleKeepImporter
        .run(&input(sources), &mut ctx, &sink)
        .expect_err("the run is refused")
        .to_string();
    assert!(sink.calls().is_empty(), "{:?}", sink.calls());
    error
}

/// A small zip whose root holds one deflated copy of `content` under each of `names`: the
/// content is compressed once and copied raw.
fn copies(names: &[String], content: &[u8]) -> Vec<u8> {
    let one = zip_bytes(&[("x", content)]);
    let mut source = zip::ZipArchive::new(std::io::Cursor::new(one)).unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for name in names {
        zip.raw_copy_file_rename(source.by_index_raw(0).unwrap(), name)
            .unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn nested_zips_past_the_memory_cap_refuse_the_import() {
    let part = (MAX_NESTED_ZIP_BYTES / 3 + 1024 * 1024) as usize;
    let inner = stored_zip(&[("pad.bin", &vec![0; part])]);
    let names: Vec<String> = (0..3).map(|n| format!("Part-{n}.zip")).collect();
    let archive = copies(&names, &inner);
    assert!(archive.len() < 2 * 1024 * 1024, "{} bytes", archive.len());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bomb.zip");
    fs::write(&path, archive).unwrap();

    let error = refused(&[&path]);
    assert!(error.contains("nested zips"), "{error}");
    assert!(
        error.contains("Extract the inner zips and pick them directly"),
        "{error}"
    );
}

#[test]
fn nesting_past_the_cap_is_refused_before_the_nested_zip_is_read() {
    // The innermost `part.zip` fails its checksum, so reading it gives a different error.
    let mut archive = stored_zip(&[("part.zip", b"PK not really")]);
    let at = archive
        .windows(10)
        .position(|w| w == b"not really")
        .unwrap();
    archive[at] = b'N';
    for _ in 1..MAX_ZIP_NESTING {
        archive = zip_bytes(&[("part.zip", &archive)]);
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deep.zip");
    fs::write(&path, archive).unwrap();

    let error = refused(&[&path]);
    assert!(error.contains("nested more than"), "{error}");
}

#[test]
fn note_files_past_the_memory_cap_refuse_the_import() {
    let count = MAX_NOTE_JSON_BYTES / MAX_SOURCE_BYTES + 1;
    let names: Vec<String> = (0..count).map(|n| format!("n{n}.json")).collect();
    let archive = copies(&names, &vec![0; MAX_SOURCE_BYTES as usize]);
    assert!(archive.len() < 2 * 1024 * 1024, "{} bytes", archive.len());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.zip");
    fs::write(&path, archive).unwrap();

    let error = refused(&[&path]);
    assert!(error.contains("MB of notes"), "{error}");
    assert!(error.contains("in smaller parts"), "{error}");
}

#[test]
fn note_files_count_against_the_memory_cap_across_picked_zips() {
    // Each zip stays under the cap on its own; the two together pass it.
    let per_zip = MAX_NOTE_JSON_BYTES / MAX_SOURCE_BYTES / 2 + 1;
    assert!(per_zip * MAX_SOURCE_BYTES < MAX_NOTE_JSON_BYTES);
    assert!(2 * per_zip * MAX_SOURCE_BYTES > MAX_NOTE_JSON_BYTES);
    let names: Vec<String> = (0..per_zip).map(|n| format!("n{n}.json")).collect();
    let archive = copies(&names, &vec![0; MAX_SOURCE_BYTES as usize]);
    let dir = tempfile::tempdir().unwrap();
    let (first, second) = (dir.path().join("a.zip"), dir.path().join("b.zip"));
    fs::write(&first, &archive).unwrap();
    fs::write(&second, &archive).unwrap();

    let (summary, _) = run(&[&first]);
    assert_eq!(
        skip_reasons(&summary),
        [("Invalid JSON".to_owned(), names.len())]
    );

    let error = refused(&[&first, &second]);
    assert!(error.contains("MB of notes"), "{error}");
}

/// A header's declared size is only a hint. One that understates an entry passes the check
/// before inflating; zip 9 then refuses the read as a broken archive once the inflated bytes pass
/// the declared size, before they reach the caller's limit.
#[test]
fn an_entry_whose_header_understates_its_size_is_refused_while_inflating() {
    let mut archive = zip_bytes(&[("big.json", &[b'x'; 4096])]);
    // The uncompressed size sits at byte 22 of the local header and 24 of the central one.
    for (signature, at) in [(b"PK\x03\x04", 22), (b"PK\x01\x02", 24)] {
        let header = archive.windows(4).position(|w| w == signature).unwrap();
        archive[header + at..header + at + 4].copy_from_slice(&10u32.to_le_bytes());
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("liar.zip");
    fs::write(&path, archive).unwrap();
    let mut zips = Zips::default();
    let mut seen = 0;
    zips.walk(&path, &CancellationToken::new(), &mut |zips, entry| {
        seen += 1;
        let error = zips
            .read(entry.at, 64)
            .expect_err("4096 bytes inflate past a limit of 64");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData, "{error}");
        assert!(
            error.to_string().contains("declared uncompressed size"),
            "{error}"
        );
        Ok(())
    })
    .unwrap();
    assert_eq!(seen, 1);
}

/// The zip crate keys entries by name, so of two entries with one name only the last is seen,
/// at the first one's place. Electron's yauzl imported both. Pinned as a known departure.
#[test]
fn of_two_entries_with_one_name_only_the_last_is_imported() {
    let mut archive = zip_bytes(&[
        ("A.json", &keep(json!({ "title": "First" }))),
        ("B.json", &keep(json!({ "title": "Second" }))),
    ]);
    while let Some(at) = archive.windows(6).position(|w| w == b"B.json") {
        archive[at] = b'A';
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dup.zip");
    fs::write(&path, archive).unwrap();

    let (summary, sink) = run(&[&path]);
    assert_eq!(summary.imported, 1);
    let titles: Vec<String> = sink.notes().into_iter().map(|n| n.title).collect();
    assert_eq!(titles, ["Second"]);
}

/// The importer reads entries into memory and never extracts, so a symlink entry is read as the
/// text of its target, and the file it names is never opened.
#[test]
fn a_symlink_entry_is_read_as_its_target_text() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret.txt");
    fs::write(&secret, b"host file content").unwrap();
    let target = secret.to_str().unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.add_symlink("photo.jpg", target, SimpleFileOptions::default())
        .unwrap();
    let path = dir.path().join("link.zip");
    fs::write(&path, zip.finish().unwrap().into_inner()).unwrap();

    let mut zips = Zips::default();
    let mut read = Vec::new();
    zips.walk(&path, &CancellationToken::new(), &mut |zips, entry| {
        read.push((entry.name.clone(), zips.read(entry.at, 1024)?));
        Ok(())
    })
    .unwrap();
    assert_eq!(read, [("photo.jpg".to_owned(), target.as_bytes().to_vec())]);
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn a_mapped_note_stays_within_the_output_bound(
        title in ".{0,40}",
        text in ".{0,200}",
        items in proptest::collection::vec((".{0,20}", any::<bool>()), 0..20),
        labels in proptest::collection::vec(".{0,12}", 0..10),
        created in any::<i64>(),
    ) {
        let raw = json!({
            "title": title, "textContent": text,
            "listContent": items.iter().map(|(t, c)| json!({ "text": t, "isChecked": c })).collect::<Vec<_>>(),
            "labels": labels, "createdTimestampUsec": created, "userEditedTimestampUsec": 0,
        });
        let input_len = serde_json::to_string(&raw).unwrap().len();
        if let Ok(mapped) = map_keep_note(&parse_keep_note(&raw).unwrap()) {
            let out = mapped.title.len() + mapped.body.len()
                + mapped.tags.iter().map(String::len).sum::<usize>();
            prop_assert!(out <= output_bound(input_len), "{out} bytes from {input_len}");
        }
    }
}
