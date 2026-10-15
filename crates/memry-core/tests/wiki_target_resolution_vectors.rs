mod support;

use memry_core::domain::notes::names::{name_key, normalize_aliases};
use memry_core::domain::wiki_target::{self, MatchedBy};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use rusqlite::Connection;
use serde_json::{Value, json};
use support::vector_file;

const NOW: i64 = 1_760_000_000_000;

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("an array")
        .iter()
        .map(|item| item.as_str().expect("a string").to_owned())
        .collect()
}

fn apply(data: &Connection, item_type: &str, id: &str, payload: Value) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    let outcome = sync_items::apply_remote(data, &record, NOW).expect("apply");
    assert!(
        !matches!(outcome, ApplyOutcome::Corrupt { .. }),
        "{id}: {outcome:?}"
    );
}

fn seeded(file: &Value) -> Connection {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    for note in file["notes"].as_array().expect("notes") {
        let id = note["noteId"].as_str().expect("noteId");
        let path = note["path"].as_str().expect("path");
        let title = note["title"].as_str().expect("title");
        let aliases = note["aliases"].clone();
        if note["journal"].as_bool().expect("journal") {
            apply(
                &data,
                "journal",
                id,
                json!({ "date": title, "aliases": aliases }),
            );
            continue;
        }
        let folder = path.rsplit_once('/').map(|(folder, _)| folder);
        apply(
            &data,
            "note",
            id,
            json!({
                "title": title,
                "folderPath": folder,
                "fileType": "markdown",
                "aliases": aliases,
            }),
        );
    }
    data
}

#[test]
fn name_keys_match_the_committed_vectors() {
    let file = vector_file("wiki-target-resolution");
    for case in file["nameKeys"].as_array().expect("nameKeys") {
        let name = case["name"].as_str().expect("named");
        let input = case["input"].as_str().expect("input");
        assert_eq!(
            name_key(input).as_deref(),
            case["expected"].as_str(),
            "{name}"
        );
    }
}

#[test]
fn alias_lists_match_the_committed_vectors() {
    let file = vector_file("wiki-target-resolution");
    for case in file["aliasLists"].as_array().expect("aliasLists") {
        let name = case["name"].as_str().expect("named");
        let title = case["title"].as_str().expect("title");
        assert_eq!(
            normalize_aliases(title, &strings(&case["aliases"])),
            strings(&case["expected"]),
            "{name}"
        );
    }
}

#[test]
fn resolution_matches_the_committed_vectors() {
    let file = vector_file("wiki-target-resolution");
    let total = ["nameKeys", "aliasLists", "resolution"]
        .iter()
        .map(|section| file[section].as_array().expect("a section").len() as u64)
        .sum::<u64>();
    assert_eq!(Some(total), file["meta"]["caseCount"].as_u64());

    let data = seeded(&file);
    for case in file["resolution"].as_array().expect("resolution") {
        let name = case["name"].as_str().expect("named");
        let query = case["query"].as_str().expect("query");
        let found = wiki_target::resolve(&data, query).expect("resolve");
        let expected = &case["expected"];
        if expected.is_null() {
            assert_eq!(found, None, "{name}");
            continue;
        }
        let found = found.unwrap_or_else(|| panic!("{name}: resolved nothing"));
        let matched_by = match found.matched_by {
            MatchedBy::Path => "path",
            MatchedBy::Title => "title",
            MatchedBy::Alias => "alias",
        };
        assert_eq!(
            (found.id.as_str(), matched_by),
            (
                expected["noteId"].as_str().expect("noteId"),
                expected["matchedBy"].as_str().expect("matchedBy"),
            ),
            "{name}"
        );
    }
}
