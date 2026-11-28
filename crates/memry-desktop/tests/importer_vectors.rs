//! The importers against `packages/contracts/test-vectors/importers/`, which the TypeScript
//! importers recorded (`apps/desktop/src/main/import/__vectors__/importer-vectors.test.ts`):
//! the same inputs, copied to a temp folder with every file modified at one instant, give the
//! same sink calls and progress snapshots in the same order, the same summary and the same CSV
//! preview. A difference is a bug in the Rust: fix the Rust, not the vector.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use memry_core::markdown::frontmatter::{YamlValue, json_to_yaml};
use memry_desktop::import::context::MAX_SKIPPED_REASON_GROUPS;
use memry_desktop::import::messages::{
    IMPORTING_ITEM_CODE, ONENOTE_DOWNLOADING_ATTACHMENT_CODE, STATUS, codes, importing_item,
    onenote_downloading_attachment,
};
use memry_desktop::import::todoist::TodoistImporter;
use memry_desktop::import::{ImportContext, ImportInput, Importer, JournalEntry, Registry};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::import_support::{RecordingSink, Timeline, record_progress};

const VECTORS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/contracts/test-vectors/importers"
);
/// `FIXED_TIME`: 2026-01-14T12:00:00.000Z.
const FIXED_TIME_MS: u64 = 1_768_392_000_000;

fn load(rel: &str) -> Value {
    let text = fs::read_to_string(Path::new(VECTORS).join(rel)).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// `fs.cpSync` of the inputs, then `setTimes`.
fn copy_inputs(from: &Path, to: &Path) {
    let fixed = SystemTime::UNIX_EPOCH + Duration::from_millis(FIXED_TIME_MS);
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            fs::create_dir(&target).unwrap();
            copy_inputs(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
            fs::File::options()
                .write(true)
                .open(&target)
                .unwrap()
                .set_times(fs::FileTimes::new().set_accessed(fixed).set_modified(fixed))
                .unwrap();
        }
    }
}

fn unroot(text: &str, roots: &[PathBuf]) -> String {
    let mut text = text.to_owned();
    for root in roots {
        text = text.replace(&*root.to_string_lossy(), "<input>");
    }
    text.replace('\\', "/")
}

/// `runCase`: the record the generator writes for one case.
fn run_case(source: &str, importer: &dyn Importer, case: &Value) -> Value {
    let work = tempfile::Builder::new()
        .prefix("memry-import-vectors-")
        .tempdir()
        .unwrap();
    copy_inputs(&Path::new(VECTORS).join(source).join("input"), work.path());
    let roots = [
        fs::canonicalize(work.path()).unwrap(),
        work.path().to_path_buf(),
    ];

    let input = ImportInput {
        source_paths: case["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|rel| {
                let mut path = work.path().to_path_buf();
                path.extend(rel.as_str().unwrap().split('/'));
                path.to_string_lossy().into_owned()
            })
            .collect(),
        options: None,
    };
    let cancel = CancellationToken::new();
    let timeline = Timeline::default();
    let preview = case["preview"]
        .as_bool()
        .unwrap_or(false)
        .then(|| serde_json::to_value(importer.preview(&input, &cancel).unwrap()).unwrap());
    let recorder = Arc::clone(&timeline);
    let mut ctx = ImportContext::new(
        "vector",
        cancel,
        Box::new(move |snapshot| record_progress(&recorder, &snapshot)),
    );
    let mut sink = RecordingSink::new(Arc::clone(&timeline));
    configure_tasks(&mut sink, case);
    sink.exact_created = case["exactCreated"].as_bool().unwrap_or(false);
    importer.run(&input, &mut ctx, &sink).unwrap();

    let unroot_summary = |summary: &mut Value| {
        for failed in summary["failed"].as_array_mut().unwrap() {
            failed["item"] = json!(unroot(failed["item"].as_str().unwrap(), &roots));
        }
    };
    let mut summary = serde_json::to_value(ctx.summary()).unwrap();
    unroot_summary(&mut summary);
    let mut entries = timeline.lock().unwrap().clone();
    // A `done` snapshot the importer emits carries the summary too.
    for entry in &mut entries {
        if let Some(summary) = entry.get_mut("summary") {
            unroot_summary(summary);
        }
    }
    let mut record = case.as_object().unwrap().clone();
    if let Some(preview) = preview {
        record.insert("preview".to_owned(), preview);
    }
    record.insert("timeline".to_owned(), Value::Array(entries));
    record.insert("summary".to_owned(), summary);
    Value::Object(record)
}

/// The generator's `recordingTaskDeps` and `readJournalEntry` for one case.
fn configure_tasks(sink: &mut RecordingSink, case: &Value) {
    match &case["inboxProjectId"] {
        Value::Null if case.get("inboxProjectId").is_some() => sink.inbox = None,
        Value::String(id) => sink.inbox = Some(id.clone()),
        _ => {}
    }
    if let Some(nested) = case["nestedSubtasks"].as_bool() {
        sink.nested_subtasks = nested;
    }
    for (date, entry) in case["journals"].as_object().into_iter().flatten() {
        let YamlValue::Map(properties) = json_to_yaml(&entry["properties"]) else {
            panic!("journal properties are an object")
        };
        let entry = JournalEntry {
            content: entry["content"].as_str().unwrap().to_owned(),
            tags: serde_json::from_value(entry["tags"].clone()).unwrap(),
            properties: (*properties).clone(),
        };
        sink.journals.insert(date.clone(), entry);
    }
}

fn assert_source(source: &str) {
    assert_importer(source, Registry::builtin().get(source).unwrap().as_ref());
}

/// Electron's preview warnings repeat their row as `row`, which the renderer never reads; the
/// Rust importers leave it out.
fn drop_warning_rows(preview: &mut Value) {
    for group in preview["groups"].as_array_mut().into_iter().flatten() {
        let warnings = group.get_mut("warnings").and_then(Value::as_array_mut);
        for warning in warnings.into_iter().flatten() {
            if let Some(warning) = warning.as_object_mut() {
                warning.remove("row");
            }
        }
    }
}

fn assert_importer(source: &str, importer: &dyn Importer) {
    let mut expected = load(&format!("{source}/expected.json"));
    for case in expected["cases"].as_array_mut().unwrap() {
        if let Some(preview) = case.get_mut("preview") {
            drop_warning_rows(preview);
        }
    }
    for case in expected["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        // The inputs of the case, without what the importer recorded.
        let mut inputs = case.as_object().unwrap().clone();
        for key in ["timeline", "summary"] {
            inputs.remove(key);
        }
        if inputs.remove("preview").is_some() {
            inputs.insert("preview".to_owned(), json!(true));
        }
        let actual = run_case(source, importer, &Value::Object(inputs));
        for key in ["timeline", "summary", "preview"] {
            let (want, got) = (&case[key], &actual[key]);
            if key == "timeline" {
                let (want, got) = (want.as_array().unwrap(), got.as_array().unwrap());
                for (at, (w, g)) in want.iter().zip(got).enumerate() {
                    assert_eq!(g, w, "{source}/{name}: timeline entry {at}");
                }
                assert_eq!(got.len(), want.len(), "{source}/{name}: timeline length");
            }
            assert_eq!(got, want, "{source}/{name}: {key}");
        }
    }
}

#[test]
fn bear_importer_matches_the_typescript_importer() {
    assert_source("bear");
}

#[test]
fn markdown_importer_matches_the_typescript_importer() {
    assert_source("markdown");
}

#[test]
fn csv_importer_matches_the_typescript_importer() {
    assert_source("csv");
}

#[test]
fn google_keep_importer_matches_the_typescript_importer() {
    assert_source("google-keep");
}

#[test]
fn noteplan_importer_matches_the_typescript_importer() {
    assert_source("noteplan");
}

#[test]
fn raindrop_importer_matches_the_typescript_importer() {
    assert_source("raindrop");
}

#[test]
fn roam_importer_matches_the_typescript_importer() {
    assert_source("roam");
}

#[test]
fn todoist_importer_matches_the_typescript_importer() {
    // The generator's `TODOIST_NOW`.
    let importer = TodoistImporter {
        today: chrono::NaiveDate::from_ymd_opt(2026, 1, 14),
        ..TodoistImporter::default()
    };
    assert_importer("todoist", &importer);
}

#[test]
fn html_importer_matches_the_typescript_importer() {
    assert_source("html");
}

#[test]
fn evernote_importer_matches_the_typescript_importer() {
    assert_source("evernote");
}

#[test]
fn apple_journal_importer_matches_the_typescript_importer() {
    assert_source("apple-journal");
}

#[test]
fn messages_match_the_typescript_module() {
    let expected = load("messages.json");
    let codes: Map<String, Value> = codes::ALL
        .iter()
        .map(|(name, code)| ((*name).to_owned(), json!(code)))
        .collect();
    let mut status_codes: Map<String, Value> = STATUS
        .iter()
        .map(|(name, code, _)| ((*name).to_owned(), json!(code)))
        .collect();
    status_codes.insert("importingItem".to_owned(), json!(IMPORTING_ITEM_CODE));
    status_codes.insert(
        "onenoteDownloadingAttachment".to_owned(),
        json!(ONENOTE_DOWNLOADING_ATTACHMENT_CODE),
    );
    let actual = json!({
        "codes": codes,
        "statusCodes": status_codes,
        "status": STATUS.iter().map(|(name, code, line)| json!([name, code, line])).collect::<Vec<_>>(),
        "importingItem": importing_item("T"),
        "onenoteDownloadingAttachment": onenote_downloading_attachment("N"),
        "maxSkippedReasonGroups": MAX_SKIPPED_REASON_GROUPS,
    });
    assert_eq!(actual, expected);
}
