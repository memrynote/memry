//! What a sync pass makes of this device's learned property types (#4025,
//! `PropertyDefinitions::seed`), over a real vault: `properties.md` through its owner and the
//! records through the core. The round trip through the real server is `sync_harness`.
//!
//! | Test                                                       | Rule                                  |
//! | ---------------------------------------------------------- | ------------------------------------- |
//! | a learned type becomes a definition in the file and a record | Electron's `seedUnclocked`, `reload`  |
//! | a name the file holds is not promoted, parsed or not       | the file's definition, a newer build's |
//! | a deleted definition stays deleted                         | a pulled delete is never undone       |
//! | `project` over another type keeps that type's options      | `options: existing?.options`          |
//! | `project` over an entry this build cannot parse is left    | #3998 review nit 7                    |
//! | `project` with a deleted record stays deleted              | a pulled delete is never undone       |
//! | `project` with no definition gets one while a note uses it | Electron's learner and seed           |

#[allow(unused_imports)]
use crate::property_definitions;

use std::collections::BTreeMap;

use memry_core::storage::repositories::sync_items::InboundRecord;
use memry_core::sync::apply::apply_inbound;
use memry_desktop::notes::property_definitions::DefinitionType;
use property_definitions::{Fixture, NOW, fixture, input, option, pull};
use serde_json::{Value, json};

const UNPARSED_RATING: &str = "---\nproperties:\n  rating:\n    type: formula\n---\n";

fn learn(f: &Fixture, pairs: &[(&str, DefinitionType)]) {
    let wanted: BTreeMap<String, DefinitionType> = pairs
        .iter()
        .map(|(name, type_name)| ((*name).to_owned(), *type_name))
        .collect();
    assert!(f.definitions.learn(wanted).unwrap());
}

fn listed(f: &Fixture, name: &str) -> Option<String> {
    let listed = f.definitions.list().unwrap();
    let found = listed.into_iter().find(|view| view.name == name)?;
    Some(
        serde_json::to_value(found.type_name)
            .unwrap()
            .as_str()?
            .to_owned(),
    )
}

/// A note another device synced, carrying `properties`.
fn note_with(f: &Fixture, properties: Value) {
    let record = InboundRecord {
        item_type: "note".into(),
        item_id: "note-1".into(),
        payload_json: json!({"title": "Plan", "properties": properties, "clock": {"peer": 1}})
            .to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("peer".into()),
        updated_at: NOW,
        deleted_at: None,
    };
    f.core
        .db_handle()
        .call_blocking(move |c| apply_inbound(c, &record, NOW))
        .unwrap();
}

#[test]
fn a_learned_type_becomes_a_definition_in_the_file_and_a_record() {
    let f = fixture();
    learn(&f, &[("rating", DefinitionType::Number)]);
    assert_eq!(listed(&f, "rating"), None, "learned, not yet a definition");

    assert_eq!(f.definitions.seed().unwrap(), ["rating"]);
    let record = f.record("rating").expect("the record");
    assert_eq!(record.type_name, "number");
    assert_eq!(record.options, None);
    assert_eq!(listed(&f, "rating").as_deref(), Some("number"));
    assert!(
        f.file().unwrap().contains("rating:\n    type: number"),
        "{:?}",
        f.file()
    );
    let queued = f.queued();
    assert!(f.definitions.seed().unwrap().is_empty(), "promoted once");
    assert_eq!(f.queued(), queued);
}

#[test]
fn a_name_the_file_holds_is_not_promoted_parsed_or_not() {
    let f = fixture();
    learn(
        &f,
        &[
            ("rating", DefinitionType::Number),
            ("site", DefinitionType::Url),
        ],
    );
    // Both entries came after the names were learned: a newer build's type, and a hand edit.
    f.set_file(&format!(
        "{}  site:\n    type: text\n---\n",
        UNPARSED_RATING.trim_end_matches("---\n")
    ));
    let before = f.file();
    assert!(f.definitions.seed().unwrap().is_empty());
    assert_eq!(f.record("rating"), None);
    assert_eq!(f.record("site"), None);
    assert_eq!(f.file(), before, "the file is left as it is");
    assert_eq!(listed(&f, "site").as_deref(), Some("text"));
}

#[test]
fn a_deleted_definition_stays_deleted() {
    let f = fixture();
    learn(&f, &[("mood", DefinitionType::Text)]);
    // Another device made and then deleted `mood`; this device pulled both.
    pull(
        &f,
        "mood",
        json!({"type": "select", "options": "[]"}),
        false,
    );
    pull(&f, "mood", json!({"type": "select"}), true);
    let queued = f.queued();
    assert!(f.definitions.seed().unwrap().is_empty());
    assert_eq!(f.record("mood"), None);
    assert_eq!(listed(&f, "mood"), None);
    assert_eq!(f.queued(), queued, "no delete is undone");
}

#[test]
fn project_over_another_type_keeps_that_types_options() {
    let f = fixture();
    let mut select = input("project", Some(DefinitionType::Select));
    select.options = Some(vec![option("Alpha", "red")]);
    select.color = Some("blue".into());
    f.definitions.create(select).unwrap();
    let options = f.record("project").unwrap().options;
    note_with(&f, json!({"project": "memry://note/abc"}));

    f.definitions.seed().unwrap();
    let record = f.record("project").expect("the record");
    assert_eq!(record.type_name, "project");
    assert_eq!(record.options, options, "the select's options stay");
    assert_eq!(record.color.as_deref(), Some("blue"));
    assert_eq!(listed(&f, "project").as_deref(), Some("project"));
    // The file holds no options for a project.
    assert!(!f.file().unwrap().contains("Alpha"), "{:?}", f.file());
}

#[test]
fn project_over_an_entry_this_build_cannot_parse_is_left() {
    let f = fixture();
    f.set_file("---\nproperties:\n  project:\n    type: formula\n---\n");
    note_with(&f, json!({"project": "memry://note/abc"}));
    let before = f.file();
    f.definitions.seed().unwrap();
    assert_eq!(f.file(), before);
    assert_eq!(f.record("project"), None);
}

#[test]
fn project_with_a_deleted_record_stays_deleted() {
    let f = fixture();
    pull(&f, "project", json!({"type": "text"}), false);
    pull(&f, "project", json!({"type": "text"}), true);
    // A hand edit put the entry back after the pull removed it.
    f.set_file("---\nproperties:\n  project:\n    type: text\n---\n");
    note_with(&f, json!({"project": "memry://note/abc"}));
    let queued = f.queued();
    f.definitions.seed().unwrap();
    assert_eq!(f.record("project"), None);
    assert_eq!(f.queued(), queued, "no delete is undone");
}

#[test]
fn project_with_no_definition_gets_one_while_a_note_uses_it() {
    let f = fixture();
    f.definitions.seed().unwrap();
    assert_eq!(f.record("project"), None, "no note uses it");
    note_with(&f, json!({"project": "memry://note/abc"}));
    f.definitions.seed().unwrap();
    assert_eq!(f.record("project").unwrap().type_name, "project");
    assert_eq!(listed(&f, "project").as_deref(), Some("project"));
}
