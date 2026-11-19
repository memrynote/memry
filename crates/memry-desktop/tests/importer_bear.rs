//! The Bear importer over `.bear2bk` zips built in a temp folder: tags, attachments, archived and
//! trashed notes, timestamps, and a malformed export refused before anything is written.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use std::collections::HashMap;

use memry_desktop::import::bear::{BearImporter, BearInfo, map_note, rewrite_bear_links};
use memry_desktop::import::{ImportContext, ImportError, ImportInput, Importer};
use memry_test_kit::{on_small_stack, output_bound, proptest_config};
use proptest::prelude::*;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use zip::write::SimpleFileOptions;

use crate::import_support::{RecordingSink, Timeline};

const ROOT: &str = "Bear Notes Backup/";

/// Writes a zip of `(entry name, bytes)` at `path`, entries in the given order.
fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
    for (name, bytes) in entries {
        zip.start_file(*name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

fn info(inner: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "net.shinyfrog.bear": inner })).unwrap()
}

/// Runs the importer over `paths` and returns its result and every sink write.
fn run(paths: &[PathBuf]) -> (Result<(), ImportError>, Vec<Value>) {
    let timeline = Timeline::default();
    let sink = RecordingSink::new(timeline.clone());
    let mut ctx = ImportContext::new("bear", CancellationToken::new(), Box::new(|_| {}));
    let input = ImportInput {
        source_paths: paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        options: None,
    };
    let result = BearImporter.run(&input, &mut ctx, &sink);
    let writes = timeline.lock().unwrap().clone();
    (result, writes)
}

fn notes(writes: &[Value]) -> Vec<&Value> {
    writes.iter().filter(|w| w["op"] == "createNote").collect()
}

fn note<'a>(writes: &'a [Value], title: &str) -> &'a Value {
    notes(writes)
        .into_iter()
        .find(|n| n["title"] == title)
        .unwrap_or_else(|| panic!("no note titled {title}"))
}

#[test]
fn bear_tags_become_note_tags_nested_and_enclosed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tags.bear2bk");
    let md =
        "# Tagged\n#a/b and #[x  y]# then #a/b again, #work/2026/q1.\n## Heading #not\nmail a#b";
    write_zip(
        &path,
        &[(&format!("{ROOT}Tagged.textbundle/text.md"), md.as_bytes())],
    );

    let (result, writes) = run(&[path]);

    result.unwrap();
    let tagged = note(&writes, "Tagged");
    assert_eq!(tagged["tags"], json!(["a/b", "work/2026/q1", "x_y"]));
    assert_eq!(tagged["content"], md, "the body is imported as written");
}

#[test]
fn bear_attachments_are_saved_under_the_note_and_linked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("assets.bear2bk");
    let bundle = format!("{ROOT}Pics.textbundle/");
    let md = "# Pics\n![a pic](assets/my%20pic.png)\n![doc](assets/spec.pdf)\n![exe](assets/run.exe)\n![gone](assets/none.png)";
    write_zip(
        &path,
        &[
            (&format!("{bundle}text.md"), md.as_bytes()),
            (&format!("{bundle}assets/my pic.png"), b"png"),
            (&format!("{bundle}assets/spec.pdf"), b"pdf"),
            (&format!("{bundle}assets/run.exe"), b"exe"),
        ],
    );

    let (result, writes) = run(&[path]);

    result.unwrap();
    let saved: Vec<(&str, &str)> = writes
        .iter()
        .filter(|w| w["op"] == "saveAttachment" && w["refused"].is_null())
        .map(|w| (w["noteId"].as_str().unwrap(), w["name"].as_str().unwrap()))
        .collect();
    assert_eq!(saved, [("note-1", "my pic.png"), ("note-1", "spec.pdf")]);
    let pics = note(&writes, "Pics");
    assert_eq!(pics["id"], "note-1");
    assert_eq!(
        pics["content"],
        "# Pics\n![a pic](attachments/note-1/my%20pic.png)\n\
         <!-- file:{\"url\":\"attachments/note-1/spec.pdf\",\"name\":\"spec.pdf\",\"size\":3,\"mimeType\":\"application/pdf\"} -->\n\
         ![exe](assets/run.exe)\n![gone](assets/none.png)"
    );
}

#[test]
fn archived_and_trashed_bear_notes_land_in_their_folders() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.bear2bk");
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for (name, state) in [
        ("Plain", json!({ "archived": 0, "trashed": 0 })),
        ("Archived", json!({ "archived": 1 })),
        ("ArchivedText", json!({ "archived": "1" })),
        ("Trashed", json!({ "trashed": true })),
        ("Both", json!({ "archived": true, "trashed": 1 })),
        ("NotOne", json!({ "archived": 2, "trashed": "true" })),
    ] {
        let bundle = format!("{ROOT}{name}.textbundle/");
        entries.push((format!("{bundle}text.md"), format!("# {name}").into_bytes()));
        entries.push((format!("{bundle}info.json"), info(state)));
    }
    let refs: Vec<(&str, &[u8])> = entries
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    write_zip(&path, &refs);

    let (result, writes) = run(&[path]);

    result.unwrap();
    for (title, folder) in [
        ("Plain", "Bear"),
        ("Archived", "Bear/Archived"),
        ("ArchivedText", "Bear/Archived"),
        ("Trashed", "Bear/Trash"),
        ("Both", "Bear/Trash"),
        ("NotOne", "Bear"),
    ] {
        assert_eq!(note(&writes, title)["folder"], folder, "{title}");
    }
}

#[test]
fn bear_timestamps_come_from_info_json() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("times.bear2bk");
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for (name, dates) in [
        (
            "Iso",
            json!({ "creationDate": "2024-01-01T10:00:00Z", "modificationDate": "2024-06-01T12:00:00.250Z" }),
        ),
        (
            "Millis",
            json!({ "creationDate": 1_700_000_000_000_i64, "modificationDate": 1_700_000_000_123.9 }),
        ),
        (
            "Invalid",
            json!({ "creationDate": "yesterday-ish", "modificationDate": true }),
        ),
    ] {
        let bundle = format!("{ROOT}{name}.textbundle/");
        entries.push((format!("{bundle}text.md"), format!("# {name}").into_bytes()));
        entries.push((format!("{bundle}info.json"), info(dates)));
    }
    let refs: Vec<(&str, &[u8])> = entries
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    write_zip(&path, &refs);

    let (result, writes) = run(&[path]);

    result.unwrap();
    let iso = note(&writes, "Iso");
    assert_eq!(iso["created"], "<birthtime>");
    assert_eq!(iso["modified"], "2024-06-01T12:00:00.250Z");
    let millis = note(&writes, "Millis");
    assert_eq!(millis["created"], "<birthtime>");
    assert_eq!(millis["modified"], "2023-11-14T22:13:20.123Z");
    let invalid = note(&writes, "Invalid");
    assert_eq!(invalid["created"], Value::Null);
    assert_eq!(invalid["modified"], Value::Null);
}

#[test]
fn bear_created_time_is_the_info_creation_date() {
    let created = memry_desktop::import::bear::parse_info(
        &memry_desktop::web::extract::utils::json::parse(
            r#"{"net.shinyfrog.bear":{"creationDate":"2024-01-01T10:00:00Z","uniqueIdentifier":"U"}}"#,
        )
        .unwrap(),
    );
    assert_eq!(created.created.as_deref(), Some("2024-01-01T10:00:00.000Z"));
    assert_eq!(created.unique_identifier.as_deref(), Some("U"));
}

#[test]
fn a_malformed_bear_export_is_refused_without_writing_anything() {
    let dir = tempfile::tempdir().unwrap();
    let good = dir.path().join("good.bear2bk");
    write_zip(
        &good,
        &[(&format!("{ROOT}Fine.textbundle/text.md"), b"# Fine")],
    );
    let garbage = dir.path().join("garbage.bear2bk");
    std::fs::write(&garbage, b"PK\x03\x04 this is not a zip").unwrap();
    let truncated = dir.path().join("truncated.bear2bk");
    let bytes = std::fs::read(&good).unwrap();
    std::fs::write(&truncated, &bytes[..bytes.len() / 2]).unwrap();
    let escaping = dir.path().join("escaping.bear2bk");
    write_zip(
        &escaping,
        &[
            (&format!("{ROOT}Fine.textbundle/text.md"), b"# Fine"),
            ("../escape.textbundle/text.md", b"# Escape"),
        ],
    );

    for picks in [
        vec![garbage.clone()],
        vec![truncated],
        vec![escaping],
        vec![good.clone(), garbage],
        vec![good, dir.path().join("missing.bear2bk")],
    ] {
        let (result, writes) = run(&picks);
        assert!(result.is_err(), "{picks:?} must fail the run");
        assert_eq!(writes, Vec::<Value>::new(), "{picks:?} wrote something");
    }
}

#[test]
fn a_deep_bear_export_imports_on_a_small_stack() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deep.bear2bk");
    let deep_info = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
    let deep_md = format!(
        "# Deep\n{}{}{}",
        "![".repeat(50_000),
        "#[".repeat(50_000),
        "[x](bear://x-callback-url/open-note?id=".repeat(20_000)
    );
    write_zip(
        &path,
        &[
            (
                &format!("{ROOT}Deep.textbundle/info.json"),
                deep_info.as_bytes(),
            ),
            (
                &format!("{ROOT}Deep.textbundle/text.md"),
                deep_md.as_bytes(),
            ),
        ],
    );

    let writes = on_small_stack(move || {
        let (result, writes) = run(&[path]);
        result.unwrap();
        writes
    });

    let deep = note(&writes, "Deep");
    assert_eq!(deep["folder"], "Bear");
    assert_eq!(deep["content"].as_str().unwrap().len(), deep_md.len());
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn bear_mapping_stays_within_the_output_bound(
        md in "[#\\[\\]()!a/_ \n]{0,80}(assets/x|bear://x-callback-url/open-note\\?id=U)?[#\\[\\]()!a ]{0,80}",
    ) {
        let mapped = map_note("Bundle", &md, &BearInfo::default());
        let tag_bytes: usize = mapped.tags.iter().map(String::len).sum();
        prop_assert!(tag_bytes <= md.len());
        prop_assert!(mapped.title.len() <= md.len().max("Bundle".len()));
        let titles = HashMap::from([("U".to_owned(), "T".to_owned())]);
        prop_assert!(rewrite_bear_links(&md, &titles).len() <= output_bound(md.len()));
    }
}
