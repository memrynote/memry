//! Property definitions a pull changed reach `.memry/properties.md` (#3530 13k-4, #2896): the
//! records are applied as the pull applies them (`sync::apply::apply_inbound`), and the file
//! is read and edited through the commands' service.
//!
//! | Test                                                      | Rule                                  |
//! | --------------------------------------------------------- | ------------------------------------- |
//! | a pulled option survives a local edit of another          | release order of #3831: `Done` stays  |
//! | an Electron file takes the server's records on first pull | `applyRemoteUpsert` reached its file  |
//! | a lost or unreadable mirror row keeps the server's record | the same rule                         |
//! | a pulled definition reaches the file                      | `applyRemoteUpsert`, calendar flag kept |
//! | a pulled delete leaves the file                           | `applyRemoteDelete`                   |
//! | a read leaves a pull for the next list                    | the object search never writes a file |
//! | a server delete of a name never held here leaves the file | the same, with no payload stored      |
//! | a record written here apart from the file lets it win     | reload's union, `mergeDatabaseDefinitions` |
//! | a hand edit of the file wins over an unchanged record     | #2896: a local file edit still wins   |
//! | a pull between the file and the record write is taken     | the record write checks what it read  |
//! | the same during the first edit of an Electron file        | the server's record wins the retry    |
//! | an edit keeps the option keys a newer build wrote         | §13.7.9 opaque `options`, #3844       |
//! | a renamed option keeps its keys                           | #3844                                 |
//! | a rename onto a held value keeps each option's keys       | the same, by place                    |
//! | an edit whose mirror row write fails still lands          | the next settle records it            |
//! | a hard-linked file is replaced, its other name kept       | #3843, Electron's `atomicWrite`       |

use std::fs;

use memry_core::domain::property_admin::mirror::META_KEY;
use memry_core::sync::apply::apply_inbound;
use memry_core::sync::store::mark_deleted;
use memry_desktop::notes::property_definitions::{
    DefinitionType, DefinitionsError, EnsuredType, StatusCategoryKey,
};
use memry_desktop::vault::properties_file::{PropertyKind, parse, properties_path};
use serde_json::{Value, json};

use crate::property_definitions::{Fixture, NOW, fixture, inbound, input, option, pull};

/// What Electron left in `properties.md`: `Stage` with `Draft` only.
const ELECTRON_STAGE: &str = "---\nproperties:\n  Stage:\n    type: select\n    options:\n      - value: Draft\n        color: violet\n---\n";
/// `Stage` once an Electron device added `Done`.
const BOTH: &str = r#"[{"value":"Draft","color":"violet"},{"value":"Done","color":"green"}]"#;

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

fn pull_both(f: &Fixture) {
    pull(
        f,
        "Stage",
        json!({ "type": "select", "options": BOTH }),
        false,
    );
}

/// The recolor of `Draft` landed, and `Done` is kept.
fn assert_done_kept(f: &Fixture, case: &str) {
    assert_eq!(
        options_of(f, "Stage"),
        json!([{"value":"Draft","color":"rose"},{"value":"Done","color":"green"}]),
        "{case}"
    );
}

/// Applies `Stage` with `Done` between the edit's file write and its record write.
fn pull_during_the_next_edit(f: &Fixture) {
    let core = f.core.db_handle();
    let record = inbound(
        f,
        "Stage",
        json!({ "type": "select", "options": BOTH }),
        false,
    );
    let mut once = Some(record);
    f.definitions.before_record_write(move || {
        if let Some(record) = once.take() {
            core.call_blocking(move |c| apply_inbound(c, &record, NOW))
                .unwrap();
        }
    });
}

#[test]
fn a_pulled_option_survives_a_local_edit_of_another() {
    let f = fixture();
    stage(&f);
    // An Electron device adds `Done`; this device pulls it, then recolors `Draft`.
    pull_both(&f);
    f.definitions
        .set_option_color("Stage", "Draft", "rose")
        .unwrap();
    assert_done_kept(&f, "pulled");
    let PropertyKind::Select(options) = file_definition(&f, "Stage").unwrap() else {
        panic!("a select");
    };
    let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
    assert_eq!(values, ["Draft", "Done"]);
}

/// The same on a vault Electron left: its file lacks `Done`, the first full pull brings `Stage`
/// with it, and the file has never taken a record here.
#[test]
fn an_electron_file_takes_the_servers_records_on_the_first_pull() {
    let f = fixture();
    f.set_file(ELECTRON_STAGE);
    pull_both(&f);
    f.definitions
        .set_option_color("Stage", "Draft", "rose")
        .unwrap();
    assert_done_kept(&f, "first pull");
}

#[test]
fn a_lost_or_unreadable_mirror_row_keeps_the_servers_record() {
    for row in [None, Some("not json"), Some("[1]")] {
        let f = fixture();
        stage(&f);
        pull_both(&f);
        f.set_mirror_row(row);
        f.definitions
            .set_option_color("Stage", "Draft", "rose")
            .unwrap();
        assert_done_kept(&f, &format!("{row:?}"));
    }
}

#[test]
fn a_pulled_definition_reaches_the_file_and_keeps_the_calendar_flag() {
    let f = fixture();
    stage(&f);
    f.definitions.set_show_on_calendar("Due", true).unwrap();
    let stage = json!({ "type": "select", "options": BOTH, "color": "sky" });
    pull(&f, "Stage", stage, false);
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
    assert_eq!(stage.options.as_deref(), Some(BOTH));
    assert_eq!(stage.color.as_deref(), Some("sky"));
    let file = parse(&f.file().unwrap()).unwrap();
    let names: Vec<&str> = file.definitions.iter().map(|(name, _)| name).collect();
    assert_eq!(names, ["Stage", "Due", "Area"]);
    let due = file.definitions.get("Due").unwrap();
    assert_eq!(due.color.as_deref(), Some("amber"));
    assert_eq!(f.definitions.calendar_names(), ["Due"]);
    // Taking the pull into the file sends nothing back.
    let queued = f.queued();
    f.definitions.list().unwrap();
    assert_eq!(f.queued(), queued);
}

#[test]
fn a_read_leaves_a_pull_for_the_next_list() {
    let f = fixture();
    stage(&f);
    let before = f.file();
    pull(
        &f,
        "Area",
        json!({ "type": "text", "options": "[]" }),
        false,
    );

    let read = f.definitions.read().unwrap();
    assert!(read.iter().any(|d| d.name == "Area"), "its record shows it");
    assert_eq!(f.file(), before, "a read writes no file");
    f.definitions.list().unwrap();
    assert_ne!(f.file(), before, "the list takes the pull into the file");
}

#[test]
fn a_pulled_delete_leaves_the_file() {
    let f = fixture();
    stage(&f);
    let area = input("Area", Some(DefinitionType::Text));
    f.definitions.create(area).unwrap();
    pull(&f, "Stage", json!({ "type": "select" }), true);
    let listed = f.definitions.list().unwrap();
    let listed: Vec<String> = listed.into_iter().map(|d| d.name).collect();
    assert_eq!(listed, ["Area"]);
    assert_eq!(file_definition(&f, "Stage"), None);
    // A later edit of another name never brings it back.
    f.definitions
        .add_option("Area", option("Home", "sage"))
        .unwrap();
    assert_eq!(f.record("Stage"), None);
    assert_eq!(file_definition(&f, "Stage"), None);
}

/// A delete of an item this device never held is stored with no payload (`mark_deleted`).
#[test]
fn a_server_delete_of_a_name_never_held_here_leaves_the_file() {
    let f = fixture();
    f.set_file(ELECTRON_STAGE);
    f.core
        .db_handle()
        .call_blocking(|c| mark_deleted(c, "property_definition", "Stage", NOW, Some(2), NOW))
        .unwrap();
    let error = f
        .definitions
        .set_option_color("Stage", "Draft", "rose")
        .unwrap_err();
    assert!(matches!(error, DefinitionsError::NotFound(_)), "{error}");
    assert_eq!(file_definition(&f, "Stage"), None);
    assert!(f.definitions.list().unwrap().is_empty());
    assert_eq!(f.record("Stage"), None);
}

#[test]
fn a_record_written_here_apart_from_the_file_lets_the_file_win_until_a_pull() {
    let f = fixture();
    stage(&f);
    // The mirror row is lost and the file was edited by hand meanwhile: nothing says the
    // record is newer, so the file wins, as Electron's reload lets it.
    f.set_mirror_row(None);
    f.set_file(&ELECTRON_STAGE.replace("violet", "sky"));
    let before = f.file();
    let listed = f.definitions.list().unwrap();
    let sky = r#"[{"value":"Draft","color":"sky"}]"#;
    assert_eq!(listed[0].options.as_deref(), Some(sky));
    assert_eq!(f.file(), before, "the file is not rewritten");

    // A pull after that is newer than the file.
    let mint = r#"[{"value":"C","color":"mint"}]"#;
    pull(
        &f,
        "Stage",
        json!({ "type": "select", "options": mint }),
        false,
    );
    let listed = f.definitions.list().unwrap();
    assert_eq!(listed[0].options.as_deref(), Some(mint));
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
    let rose = r#"[{"value":"Draft","color":"rose"}]"#;
    assert_eq!(listed[0].options.as_deref(), Some(rose));
    assert_eq!(f.file().as_deref(), Some(edited.as_str()));
    // The next edit of the name sends the file's definition.
    f.definitions
        .add_option("Stage", option("Done", "green"))
        .unwrap();
    assert_done_kept(&f, "hand edit");
}

#[test]
fn a_pull_between_the_file_write_and_the_record_write_is_taken_and_the_edit_redone() {
    let f = fixture();
    stage(&f);
    pull_during_the_next_edit(&f);
    f.definitions
        .set_option_color("Stage", "Draft", "rose")
        .unwrap();
    assert_done_kept(&f, "between");
}

/// The same on a first run: the file holds what Electron left and no record exists yet, so the
/// edit creates one, and the pull lands before it.
#[test]
fn a_pull_during_the_first_edit_of_an_electron_file_is_taken() {
    let f = fixture();
    f.set_file(ELECTRON_STAGE);
    pull_during_the_next_edit(&f);
    f.definitions
        .set_option_color("Stage", "Draft", "rose")
        .unwrap();
    assert_done_kept(&f, "first edit");
}

#[test]
fn an_edit_keeps_the_option_keys_a_newer_build_wrote() {
    let f = fixture();
    stage(&f);
    let select = json!([
        {"value":"Draft","color":"violet","icon":"pen"},
        {"value":"Done","color":"green","default":true,"order":2}
    ]);
    let fields = json!({ "type": "select", "options": select.to_string() });
    pull(&f, "Stage", fields, false);
    f.definitions.ensure("State", EnsuredType::Status).unwrap();
    let mut status: Value = options_of(&f, "State");
    status["categories"]["todo"]["hint"] = json!("not yet");
    status["categories"]["todo"]["options"][0]["icon"] = json!("circle");
    status["categories"]["blocked"] = json!({"label":"Blocked","options":[]});
    status["version"] = json!(2);
    let fields = json!({ "type": "status", "options": status.to_string() });
    pull(&f, "State", fields, false);

    f.definitions
        .set_option_color("Stage", "Done", "mint")
        .unwrap();
    let shipped = option("Shipped", "green");
    f.definitions
        .add_status_option("State", StatusCategoryKey::Done, shipped)
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
    let blocked = json!({"label":"Blocked","options":[]});
    assert_eq!(state["categories"]["blocked"], blocked);
    assert_eq!(state["categories"]["todo"]["hint"], json!("not yet"));
    let todo = &state["categories"]["todo"]["options"][0];
    assert_eq!(todo["icon"], json!("circle"));
    let done = state["categories"]["done"]["options"].as_array().unwrap();
    assert_eq!(
        done.last(),
        Some(&json!({"value":"Shipped","color":"green"}))
    );
}

#[test]
fn a_renamed_option_keeps_its_keys() {
    let f = fixture();
    stage(&f);
    let select = json!([{"value":"Draft","color":"violet","icon":"pen"}]);
    let fields = json!({ "type": "select", "options": select.to_string() });
    pull(&f, "Stage", fields, false);
    f.definitions
        .rename_option("Stage", "Draft", "Sketch")
        .unwrap();
    assert_eq!(
        options_of(&f, "Stage"),
        json!([{"value":"Sketch","color":"violet","icon":"pen"}])
    );
}

#[test]
fn a_rename_onto_a_held_value_keeps_each_options_keys() {
    let f = fixture();
    stage(&f);
    let select = json!([
        {"value":"B","color":"violet","icon":"b"},
        {"value":"A","color":"green","icon":"a"}
    ]);
    let fields = json!({ "type": "select", "options": select.to_string() });
    pull(&f, "Stage", fields, false);
    f.definitions.rename_option("Stage", "A", "B").unwrap();
    assert_eq!(
        options_of(&f, "Stage"),
        json!([
            {"value":"B","color":"violet","icon":"b"},
            {"value":"B","color":"green","icon":"a"}
        ])
    );
}

/// The record write commits before the mirror row is written: a failure of the row leaves an
/// edit that landed, which the next settle records.
#[test]
fn an_edit_whose_mirror_row_write_fails_still_lands() {
    let f = fixture();
    stage(&f);
    let core = f.core.db_handle();
    f.definitions.before_record_write(move || {
        core.call_blocking(|c| {
            for (event, at) in [("INSERT", "refuse_insert"), ("UPDATE", "refuse_update")] {
                c.execute_batch(&format!(
                    "CREATE TRIGGER IF NOT EXISTS {at} BEFORE {event} ON meta
                     WHEN NEW.key = '{META_KEY}' BEGIN SELECT RAISE(ABORT, 'refused'); END;"
                ))
                .unwrap();
            }
            Ok(())
        })
        .unwrap();
    });
    f.definitions
        .set_option_color("Stage", "Draft", "rose")
        .unwrap();
    let rose = json!([{"value":"Draft","color":"rose"}]);
    assert_eq!(options_of(&f, "Stage"), rose);
    assert!(
        !f.records.snapshot().unwrap().pulled().is_empty(),
        "unrecorded"
    );

    f.core
        .db_handle()
        .call_blocking(|c| {
            c.execute_batch("DROP TRIGGER refuse_insert; DROP TRIGGER refuse_update;")
                .unwrap();
            Ok(())
        })
        .unwrap();
    let listed = f.definitions.list().unwrap();
    let listed: Value = serde_json::from_str(listed[0].options.as_deref().unwrap()).unwrap();
    assert_eq!(listed, rose);
    let PropertyKind::Select(options) = file_definition(&f, "Stage").unwrap() else {
        panic!("a select");
    };
    assert_eq!(options[0].color, "rose");
    assert!(
        f.records.snapshot().unwrap().pulled().is_empty(),
        "recorded"
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
    let after = fs::read(&outside).unwrap();
    assert_eq!(after, kept, "nothing is written through the link");
    assert!(f.file().unwrap().contains("Done"));
}
