//! The committed sandbox template (`resources/sandbox/`, exported by
//! `apps/cli/src/sandbox/export-template.ts`) parses, matches the generator's
//! counts and assets, and rebases to what Electron's generator writes on
//! another day: `tests/fixtures/sandbox/rebase-2028-03-01.json` holds the
//! date facts of a real generator run on 2028-03-01, a Wednesday like the
//! template's 2026-01-14, whose past-year journal days cross Feb 29. The
//! `-<zone>` vectors are the same run in another zone, and the 2028-03-05
//! (Sunday) and 2028-03-07 (Tuesday) runs pin the repeating tasks' days.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use chrono::{DateTime, TimeZone, Utc};
use memry_desktop::sandbox::{
    Manifest, Rebase, SandboxError, TemplateInfo, device_zone_name,
    manifest::{MAX_TEMPLATE_BYTES, check_relative_path},
};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn template_dir() -> PathBuf {
    crate_dir().join("resources/sandbox")
}

fn load() -> (Manifest, TemplateInfo) {
    let dir = template_dir();
    let manifest = Manifest::parse(&fs::read(dir.join("seed.json")).unwrap()).unwrap();
    let info = TemplateInfo::parse(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    (manifest, info)
}

fn vault_files(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, root, out);
            } else {
                let relative = path.strip_prefix(root).unwrap();
                let parts: Vec<_> = relative.iter().map(|p| p.to_str().unwrap()).collect();
                out.push(parts.join("/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn str_column<'a>(rows: &'a [serde_json::Map<String, Value>], column: &str) -> Vec<&'a str> {
    rows.iter()
        .filter_map(|row| row.get(column)?.as_str())
        .collect()
}

#[test]
fn template_counts_match_the_generator() {
    let (manifest, info) = load();
    assert_eq!(manifest.generated_at, info.generated_at);
    let data = &manifest.data;
    let notes = &data["note_metadata"];
    let journal = notes
        .iter()
        .filter(|row| !row["journal_date"].is_null())
        .count();
    let markdown = notes
        .iter()
        .filter(|row| row["file_type"] == "markdown")
        .count();
    let rows = |table: &str| data[table].len() as u64;
    for (name, expected) in [
        ("notes", (markdown - journal) as u64),
        ("journal entries", journal as u64),
        ("files", (notes.len() - markdown) as u64),
        ("projects", rows("projects")),
        ("tasks", rows("tasks")),
        ("inbox items", rows("inbox_items")),
        ("calendar events", rows("calendar_events")),
        ("reminders", rows("reminders")),
        ("bookmarks", rows("bookmarks")),
        ("templates", rows("templates")),
        ("saved filters", rows("saved_filters")),
        ("tags", rows("tag_definitions")),
        ("task activity", rows("task_activity")),
        ("versions", manifest.index["note_snapshots"].len() as u64),
    ] {
        assert_eq!(info.count(name), Some(expected), "{name}");
    }
    let journal_files = vault_files(&template_dir().join("vault"))
        .into_iter()
        .filter(|path| path.starts_with("journal/"))
        .count();
    assert_eq!(journal_files, journal);
}

#[test]
fn template_paths_are_plain_and_assets_are_the_bundled_bytes() {
    let (manifest, _) = load();
    for path in vault_files(&template_dir().join("vault")) {
        check_relative_path(&path).unwrap();
    }
    let assets = crate_dir().join("../../apps/cli/src/sandbox/assets");
    for copy in &manifest.assets {
        let bytes = fs::read(assets.join(&copy.asset)).unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            copy.sha256,
            "{}",
            copy.asset
        );
    }
}

#[test]
fn hostile_templates_are_refused() {
    let seed = |patch: Value| {
        let mut value = json!({
            "version": 1, "generatedAt": "2026-01-14T12:00:00.000Z", "timezone": "UTC",
            "assets": [], "data": {}, "index": {}
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        Manifest::parse(value.to_string().as_bytes())
    };
    let asset = |path: &str, name: &str| json!({ "assets": [{ "path": path, "asset": name, "sha256": "a".repeat(64) }] });
    assert!(seed(json!({})).is_ok());
    assert!(matches!(
        seed(json!({ "version": 2 })),
        Err(SandboxError::UnsupportedVersion(2))
    ));
    assert!(matches!(
        seed(json!({ "timezone": "Europe/Istanbul" })),
        Err(SandboxError::UnsupportedTimezone(_))
    ));
    assert!(matches!(
        seed(json!({ "generatedAt": "yesterday" })),
        Err(SandboxError::BadGeneratedAt(_))
    ));
    assert!(matches!(
        seed(json!({ "data": { "sqlite_master": [] } })),
        Err(SandboxError::UnknownTable(_))
    ));
    assert!(matches!(
        seed(json!({ "index": { "note_metadata": [] } })),
        Err(SandboxError::UnknownTable(_))
    ));
    assert!(matches!(
        seed(json!({ "extra": 1 })),
        Err(SandboxError::Json(_))
    ));
    for path in [
        "../x.jpg",
        "/etc/x",
        "a/../../x",
        "C:/x",
        "a\\..\\x",
        "a//b",
        "./a",
        "",
    ] {
        assert!(
            matches!(seed(asset(path, "a.jpg")), Err(SandboxError::UnsafePath(_))),
            "{path}"
        );
    }
    for name in ["../a.jpg", "a/b.jpg", ".hidden", ""] {
        assert!(
            matches!(seed(asset("a/b.jpg", name)), Err(SandboxError::BadAsset(_))),
            "{name}"
        );
    }
    for (table, column) in [
        ("note_metadata", "path"),
        ("folder_configs", "path"),
        ("inbox_items", "attachment_path"),
        ("inbox_items", "thumbnail_path"),
        ("inbox_items", "filed_to"),
    ] {
        let row = |value: Value| json!({ "data": { table: [{ "id": "x", column: value }] } });
        assert!(seed(row(json!("Work/a b.md"))).is_ok(), "{table}.{column}");
        assert!(seed(row(Value::Null)).is_ok(), "{table}.{column}");
        for value in [json!("../x.md"), json!("/etc/x"), json!("C:/x"), json!(7)] {
            assert!(
                matches!(seed(row(value.clone())), Err(SandboxError::UnsafePath(_))),
                "{table}.{column} {value}"
            );
        }
    }
}

#[test]
fn oversized_templates_are_refused_before_parsing() {
    // Not JSON, so only the size check can refuse it with TooLarge.
    let bytes = vec![b' '; MAX_TEMPLATE_BYTES + 1];
    assert!(matches!(
        Manifest::parse(&bytes),
        Err(SandboxError::TooLarge(what)) if what.starts_with(&format!("{} bytes", MAX_TEMPLATE_BYTES + 1))
    ));
    assert!(matches!(
        TemplateInfo::parse(&bytes),
        Err(SandboxError::TooLarge(_))
    ));
    assert!(matches!(
        Manifest::parse(&bytes[..MAX_TEMPLATE_BYTES]),
        Err(SandboxError::Json(_))
    ));
}

/// The exporter's `dateFacts`: date tokens decoded, then every date or instant not inside a digit run.
fn date_facts(text: &str) -> Vec<String> {
    let token = Regex::new(r"\(\(date:([A-Za-z0-9,;]+)\)\)").unwrap();
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::Alphabet::new(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789,;",
        )
        .unwrap(),
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    let expanded = token.replace_all(text, |caps: &regex::Captures| {
        engine
            .decode(&caps[1])
            .unwrap()
            .iter()
            .map(|&b| char::from(b))
            .collect::<String>()
    });
    let fact = Regex::new(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z?)?",
    )
    .unwrap();
    let bytes = expanded.as_bytes();
    fact.find_iter(&expanded)
        .filter(|m| {
            !(m.start() > 0 && bytes[m.start() - 1].is_ascii_digit())
                && !bytes.get(m.end()).is_some_and(u8::is_ascii_digit)
        })
        .map(|m| m.as_str().to_owned())
        .collect()
}

const CLOCK_INSTANTS: &[&str] = &[
    "calendar_events.start_at",
    "calendar_events.end_at",
    "reminders.remind_at",
    "reminders.snoozed_until",
    "inbox_items.snoozed_until",
];
/// The exporter's `ZONE_COLUMNS`.
const ZONE_COLUMNS: &[&str] = &["calendar_events.timezone"];

fn vector(name: &str) -> Value {
    serde_json::from_slice(
        &fs::read(crate_dir().join("tests/fixtures/sandbox").join(name)).unwrap(),
    )
    .unwrap()
}

/// What the rebase of the committed template makes of the vector's sections.
#[derive(Clone, Copy, PartialEq)]
enum Sections {
    /// Every section: the generator ran on a Wednesday, as the template did.
    All,
    /// The repeating tasks and canvases: on another weekday the generator
    /// picks other workdays for the rest, which one template cannot follow.
    WeekdayFree,
}

fn check_vector<Tz: TimeZone>(name: &str, tz: Tz, zone: &str, sections: Sections) {
    let vector = vector(name);
    let now: DateTime<Utc> = vector["now"].as_str().unwrap().parse().unwrap();
    let (mut manifest, _) = load();
    let rebase = Rebase::for_manifest(&manifest, now, tz, zone);
    let template_notes = manifest.data["note_metadata"].clone();
    rebase.manifest(&mut manifest);

    let repeats: BTreeMap<String, Value> = manifest.data["tasks"]
        .iter()
        .filter(|task| !task["repeat_config"].is_null())
        .map(|task| {
            (
                task["title"].as_str().unwrap().to_owned(),
                task["due_date"].clone(),
            )
        })
        .collect();
    let expected_repeats: BTreeMap<String, Value> =
        serde_json::from_value(vector["repeats"].clone()).unwrap();
    assert_eq!(repeats, expected_repeats, "{name} repeats");

    // Two past-year journal days can land on one date (Feb 29 -> Feb 28); the
    // generator wrote that note once, and the later write won. Notes are in
    // creation order, so the later row of a path wins here too.
    let vault = template_dir().join("vault");
    let mut texts: BTreeMap<String, String> = BTreeMap::new();
    let rows_by_path: Vec<&str> = str_column(&template_notes, "path");
    let mut ordered: Vec<String> = vault_files(&vault)
        .into_iter()
        .filter(|path| !rows_by_path.contains(&path.as_str()))
        .collect();
    ordered.extend(rows_by_path.iter().map(|path| (*path).to_owned()));
    for path in ordered.iter().filter(|path| vault.join(path).is_file()) {
        if path.ends_with(".md") || path.ends_with(".excalidraw") {
            let text = fs::read_to_string(vault.join(path)).unwrap();
            texts.insert(
                rebase.text(path).into_owned(),
                rebase.file(path, &text).into_owned(),
            );
        }
    }

    let canvas_times: BTreeMap<String, Value> = texts
        .iter()
        .filter(|(path, _)| path.ends_with(".excalidraw"))
        .map(|(path, text)| {
            let scene: Value = serde_json::from_str(text).unwrap();
            let times = json!([scene["memry"]["createdAt"], scene["memry"]["updatedAt"]]);
            (path.clone(), times)
        })
        .collect();
    let expected_canvas_times: BTreeMap<String, Value> =
        serde_json::from_value(vector["canvasTimes"].clone()).unwrap();
    assert_eq!(canvas_times, expected_canvas_times, "{name} canvasTimes");
    if sections == Sections::WeekdayFree {
        return;
    }

    let mut paths: BTreeSet<String> = vault_files(&vault)
        .iter()
        .map(|p| rebase.text(p).into_owned())
        .collect();
    paths.extend(manifest.assets.iter().map(|copy| copy.path.clone()));
    paths.retain(|path| !path.starts_with("attachments/"));
    let expected_paths: BTreeSet<String> = vector["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(paths, expected_paths, "{name} paths");

    let files: BTreeMap<String, Vec<String>> = texts
        .iter()
        .map(|(path, text)| (path.clone(), date_facts(text)))
        .filter(|(_, facts)| !facts.is_empty())
        .collect();
    let expected_files: BTreeMap<String, Vec<String>> =
        serde_json::from_value(vector["files"].clone()).unwrap();
    assert_eq!(files, expected_files, "{name} files");

    let mut seen_paths = BTreeMap::new();
    let notes = &manifest.data["note_metadata"];
    for (index, row) in notes.iter().enumerate() {
        seen_paths.insert(row["path"].as_str().unwrap().to_owned(), index);
    }
    let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (table, rows) in &manifest.data {
        for (index, row) in rows.iter().enumerate() {
            if table == "note_metadata" && seen_paths[row["path"].as_str().unwrap()] != index {
                continue;
            }
            for (column, value) in row {
                let key = format!("{table}.{column}");
                let Some(text) = value.as_str() else { continue };
                let date_only = text.len() == 10 && date_facts(text) == [text];
                let listed =
                    CLOCK_INSTANTS.contains(&key.as_str()) || ZONE_COLUMNS.contains(&key.as_str());
                if date_only || listed {
                    values.entry(key).or_default().push(text.to_owned());
                }
            }
        }
    }
    values.values_mut().for_each(|list| list.sort());
    let expected_values: BTreeMap<String, Vec<String>> =
        serde_json::from_value(vector["values"].clone()).unwrap();
    let keys: BTreeSet<&String> = values.keys().chain(expected_values.keys()).collect();
    for key in keys {
        assert_eq!(values.get(key), expected_values.get(key), "{name} {key}");
    }
}

#[test]
fn rebase_reproduces_the_generator_on_another_day() {
    check_vector("rebase-2028-03-01.json", Utc, "UTC", Sections::All);
}

#[test]
fn rebase_keeps_repeating_tasks_on_their_days_on_other_weekdays() {
    // 2028-03-07 is a Tuesday, 2028-03-05 a Sunday.
    for name in ["rebase-2028-03-07.json", "rebase-2028-03-05.json"] {
        check_vector(name, Utc, "UTC", Sections::WeekdayFree);
    }
}

/// Set by `rebase_reproduces_the_generator_in_other_zones` for its child process.
const ZONE_VECTOR_ENV: &str = "MEMRY_SANDBOX_ZONE_VECTOR";

/// Runs [`zone_vector_child`] in a child process with `TZ` set, so the device
/// zone reaches the rebase the way the app resolves it: chrono's `Local` and
/// [`device_zone_name`]. The Los Angeles run crosses a daylight saving change.
/// Unix only: chrono's `Local` reads `TZ` there and not on Windows.
#[cfg(unix)]
#[test]
fn rebase_reproduces_the_generator_in_other_zones() {
    for name in [
        "rebase-2028-03-01-america-los_angeles.json",
        "rebase-2028-03-01-europe-istanbul.json",
    ] {
        let zone = vector(name)["tz"].as_str().unwrap().to_owned();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["zone_vector_child", "--exact", "--ignored", "--nocapture"])
            .env("TZ", &zone)
            .env(ZONE_VECTOR_ENV, name)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "{name} in {zone}:\n{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
#[ignore = "run in a child process with TZ set by rebase_reproduces_the_generator_in_other_zones"]
fn zone_vector_child() {
    let name = std::env::var(ZONE_VECTOR_ENV)
        .expect("run through rebase_reproduces_the_generator_in_other_zones");
    let zone = device_zone_name();
    assert_eq!(zone, vector(&name)["tz"].as_str().unwrap());
    check_vector(&name, chrono::Local, &zone, Sections::All);
}

#[test]
fn rebase_to_the_template_day_in_utc_changes_nothing() {
    let (manifest, _) = load();
    let rebase = Rebase::for_manifest(&manifest, manifest.generated_at(), Utc, "UTC");
    let mut moved = manifest.clone();
    rebase.manifest(&mut moved);
    assert_eq!(moved, manifest);
    let vault = template_dir().join("vault");
    for path in vault_files(&vault) {
        assert!(matches!(rebase.text(&path), Cow::Borrowed(_)), "{path}");
        if let Ok(text) = fs::read_to_string(vault.join(&path)) {
            assert!(
                matches!(rebase.file(&path, &text), Cow::Borrowed(_)),
                "{path}"
            );
        }
    }
}
