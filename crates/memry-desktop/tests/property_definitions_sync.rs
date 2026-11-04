//! Property definitions a pull changed reach `.memry/properties.md` (#3530 13k-4, #2896): the
//! records are applied as the pull applies them (`sync::apply::apply_inbound`), and the file
//! is read and edited through the commands' service.
//!
//! | Test                                                      | Rule                                  |
//! | --------------------------------------------------------- | ------------------------------------- |
//! | a pulled option survives a local edit of another          | release order of #3831: `Done` stays  |
//! | a pulled definition reaches the file                      | `applyRemoteUpsert`, calendar flag kept |
//! | a pulled delete leaves the file                           | `applyRemoteDelete`                   |
//! | a file written apart from its record wins until a pull    | reload's union, `mergeDatabaseDefinitions` |
//! | a hand edit of the file wins over an unchanged record     | #2896: a local file edit still wins   |
//! | a pull between the file and the record write is taken     | the record write checks what it read  |
//! | an edit keeps the option keys a newer build wrote         | §13.7.9 opaque `options`, #3844       |
//! | a hard-linked file is replaced, its other name kept       | #3843, Electron's `atomicWrite`       |

use std::fs;

use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::sync::apply::apply_inbound;
use memry_desktop::notes::property_definitions::{DefinitionType, StatusCategoryKey};
use memry_desktop::vault::properties_file::{PropertyKind, parse, properties_path};
use serde_json::{Map, Value, json};

use crate::property_definitions::{Fixture, fixture, input, option};

const NOW: i64 = 1_760_000_000_000;

/// The record's clock with the peer's counter past it: a peer edit made after it pulled ours.
fn after(f: &Fixture, name: &str) -> Value {
    let name = name.to_owned();
    let stored = f
        .core
        .db_handle()
        .call_blocking(move |c| sync_items::load(c, "property_definition", &name))
        .unwrap();
    let mut clock = stored
        .and_then(|row| row.payload)
        .and_then(|payload| serde_json::from_str::<Value>(&payload).ok())
        .and_then(|payload| payload.get("clock").and_then(Value::as_object).cloned())
        .unwrap_or_default();
    let next = clock.get("peer").and_then(Value::as_u64).unwrap_or(0) + 1;
    clock.insert("peer".into(), json!(next));
    Value::Object(clock)
}

/// Another device's definition of `name`, applied as a pull applies it.
fn pull(f: &Fixture, name: &str, fields: Value, deleted: bool) {
    let mut payload: Map<String, Value> = fields.as_object().cloned().unwrap_or_default();
    payload.insert("name".into(), json!(name));
    payload.insert("clock".into(), after(f, name));
    let record = InboundRecord {
        item_type: "property_definition".into(),
        item_id: name.into(),
        payload_json: Value::Object(payload).to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("peer".into()),
        updated_at: NOW,
        deleted_at: deleted.then_some(NOW),
    };
    f.core
        .db_handle()
        .call_blocking(move |c| apply_inbound(c, &record, NOW))
        .unwrap();
}

fn options_of(f: &Fixture, name: &str) -> Value {
    serde_json::from_str(&f.record(name).unwrap().options.unwrap()).unwrap()
}

fn file_definition(f: &Fixture, name: &str) -> Option<PropertyKind> {
    let file = parse(&f.file().unwrap()).unwrap();
    file.definitions.get(name).map(|d| d.kind.clone())
}

fn stage(f: &Fixture) {
    let mut stage = input("Stage", Some(DefinitionType::Select));
    stage.options = Some(vec![option("Draft", "violet")]);
    f.definitions.create(stage).unwrap();
}

#[test]
fn a_pulled_option_survives_a_local_edit_of_another() {
    let f = fixture();
    stage(&f);
    // An Electron device adds `Done`; this device pulls it, then recolors `Draft`.
    let both = r#"[{"value":"Draft","color":"violet"},{"value":"Done","color":"green"}]"#;
    pull(
        &f,
        "Stage",
        json!({ "type": "select", "options": both }),
        false,
    );
    f.definitions
        .set_option_color("Stage", "Draft", "rose")
        .unwrap();
    assert_eq!(
        options_of(&f, "Stage"),
        json!([{"value":"Draft","color":"rose"},{"value":"Done","color":"green"}])
    );
    let PropertyKind::Select(options) = file_definition(&f, "Stage").unwrap() else {
        panic!("a select");
    };
    let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
    assert_eq!(values, ["Draft", "Done"]);
}

#[test]
fn a_pulled_definition_reaches_the_file_and_keeps_the_calendar_flag() {
    let f = fixture();
    stage(&f);
    f.definitions.set_show_on_calendar("Due", true).unwrap();
    let both = r#"[{"value":"Draft","color":"violet"},{"value":"Done","color":"green"}]"#;
    pull(
        &f,
        "Stage",
        json!({ "type": "select", "options": both, "color": "sky" }),
        false,
    );
    pull(
        &f,
        "Due",
        json!({ "type": "date", "color": "amber" }),
        false,
    );
    // A name this device never had joins the file, as Electron's reload writes it.
    pull(
        &f,
        "Area",
        json!({ "type": "text", "options": "[]" }),
        false,
    );

    let listed = f.definitions.list().unwrap();
    let stage = listed.iter().find(|d| d.name == "Stage").unwrap();
    assert_eq!(stage.options.as_deref(), Some(both));
    assert_eq!(stage.color.as_deref(), Some("sky"));
    let file = parse(&f.file().unwrap()).unwrap();
    let names: Vec<&str> = file.definitions.iter().map(|(name, _)| name).collect();
    assert_eq!(names, ["Stage", "Due", "Area"]);
    assert_eq!(
        file.definitions.get("Due").unwrap().color.as_deref(),
        Some("amber")
    );
    assert_eq!(f.definitions.calendar_names(), ["Due"]);
    // Taking the pull into the file sends nothing back.
    let queued = f.queued();
    f.definitions.list().unwrap();
    assert_eq!(f.queued(), queued);
}

#[test]
fn a_pulled_delete_leaves_the_file() {
    let f = fixture();
    stage(&f);
    f.definitions
        .create(input("Area", Some(DefinitionType::Text)))
        .unwrap();
    pull(&f, "Stage", json!({ "type": "select" }), true);
    let listed: Vec<String> = f
        .definitions
        .list()
        .unwrap()
        .into_iter()
        .map(|d| d.name)
        .collect();
    assert_eq!(listed, ["Area"]);
    assert_eq!(file_definition(&f, "Stage"), None);
    // A later edit of another name never brings it back.
    f.definitions
        .add_option("Area", option("Home", "sage"))
        .unwrap();
    assert_eq!(f.record("Stage"), None);
    assert_eq!(file_definition(&f, "Stage"), None);
}

#[test]
fn a_file_written_apart_from_its_record_wins_until_a_pull() {
    let f = fixture();
    // Left by Electron or a hand edit: the file and the record were never compared here.
    f.set_file(
        "---\nproperties:\n  Stage:\n    type: select\n    options:\n      - value: A\n        color: sky\n---\n",
    );
    pull(
        &f,
        "Stage",
        json!({ "type": "select", "options": r#"[{"value":"B","color":"rose"}]"# }),
        false,
    );
    let before = f.file();
    let listed = f.definitions.list().unwrap();
    assert_eq!(
        listed[0].options.as_deref(),
        Some(r#"[{"value":"A","color":"sky"}]"#)
    );
    assert_eq!(f.file(), before, "the file is not rewritten");

    // A pull after that is newer than the file.
    pull(
        &f,
        "Stage",
        json!({ "type": "select", "options": r#"[{"value":"C","color":"mint"}]"# }),
        false,
    );
    let listed = f.definitions.list().unwrap();
    assert_eq!(
        listed[0].options.as_deref(),
        Some(r#"[{"value":"C","color":"mint"}]"#)
    );
}

#[test]
fn a_hand_edit_of_the_file_wins_over_an_unchanged_record() {
    let f = fixture();
    stage(&f);
    f.definitions
        .set_option_color("Stage", "Draft", "sky")
        .unwrap();
    let edited = f.file().unwrap().replace("sky", "rose");
    f.set_file(&edited);
    let listed = f.definitions.list().unwrap();
    assert_eq!(
        listed[0].options.as_deref(),
        Some(r#"[{"value":"Draft","color":"rose"}]"#)
    );
    assert_eq!(f.file().as_deref(), Some(edited.as_str()));
    // The next edit of the name sends the file's definition.
    f.definitions
        .add_option("Stage", option("Done", "green"))
        .unwrap();
    assert_eq!(
        options_of(&f, "Stage"),
        json!([{"value":"Draft","color":"rose"},{"value":"Done","color":"green"}])
    );
}

#[test]
fn a_pull_between_the_file_write_and_the_record_write_is_taken_and_the_edit_redone() {
    let f = fixture();
    stage(&f);
    let both = r#"[{"value":"Draft","color":"violet"},{"value":"Done","color":"green"}]"#;
    let core = f.core.db_handle();
    let mut once = Some(InboundRecord {
        item_type: "property_definition".into(),
        item_id: "Stage".into(),
        payload_json: json!({
            "name": "Stage", "type": "select", "options": both, "clock": after(&f, "Stage")
        })
        .to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("peer".into()),
        updated_at: NOW,
        deleted_at: None,
    });
    f.definitions.before_record_write(move || {
        if let Some(record) = once.take() {
            core.call_blocking(move |c| apply_inbound(c, &record, NOW))
                .unwrap();
        }
    });
    f.definitions
        .set_option_color("Stage", "Draft", "rose")
        .unwrap();
    assert_eq!(
        options_of(&f, "Stage"),
        json!([{"value":"Draft","color":"rose"},{"value":"Done","color":"green"}])
    );
}

#[test]
fn an_edit_keeps_the_option_keys_a_newer_build_wrote() {
    let f = fixture();
    stage(&f);
    let select = json!([
        {"value":"Draft","color":"violet","icon":"pen"},
        {"value":"Done","color":"green","default":true,"order":2}
    ]);
    pull(
        &f,
        "Stage",
        json!({ "type": "select", "options": select.to_string() }),
        false,
    );
    f.definitions
        .ensure(
            "State",
            memry_desktop::notes::property_definitions::EnsuredType::Status,
        )
        .unwrap();
    let mut status: Value =
        serde_json::from_str(&f.record("State").unwrap().options.unwrap()).unwrap();
    status["categories"]["todo"]["hint"] = json!("not yet");
    status["categories"]["todo"]["options"][0]["icon"] = json!("circle");
    status["categories"]["blocked"] = json!({"label":"Blocked","options":[]});
    status["version"] = json!(2);
    pull(
        &f,
        "State",
        json!({ "type": "status", "options": status.to_string() }),
        false,
    );

    f.definitions
        .set_option_color("Stage", "Done", "mint")
        .unwrap();
    f.definitions
        .add_status_option("State", StatusCategoryKey::Done, option("Shipped", "green"))
        .unwrap();

    assert_eq!(
        options_of(&f, "Stage"),
        json!([
            {"value":"Draft","color":"violet","icon":"pen"},
            {"value":"Done","color":"mint","default":true,"order":2}
        ])
    );
    let state = options_of(&f, "State");
    assert_eq!(state["version"], json!(2));
    assert_eq!(
        state["categories"]["blocked"],
        json!({"label":"Blocked","options":[]})
    );
    assert_eq!(state["categories"]["todo"]["hint"], json!("not yet"));
    assert_eq!(
        state["categories"]["todo"]["options"][0]["icon"],
        json!("circle")
    );
    let done = state["categories"]["done"]["options"].as_array().unwrap();
    assert_eq!(
        done.last(),
        Some(&json!({"value":"Shipped","color":"green"}))
    );
}

#[test]
fn a_hard_linked_file_is_replaced_and_its_other_name_keeps_its_bytes() {
    let f = fixture();
    stage(&f);
    let outside = f.vault.parent().unwrap().join("linked-properties.md");
    let path = properties_path(&f.vault);
    fs::hard_link(&path, &outside).unwrap();
    let kept = fs::read(&outside).unwrap();
    f.definitions
        .add_option("Stage", option("Done", "green"))
        .unwrap();
    assert_eq!(
        fs::read(&outside).unwrap(),
        kept,
        "nothing is written through the link"
    );
    assert!(f.file().unwrap().contains("Done"));
}
