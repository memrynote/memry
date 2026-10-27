use serde_json::{Value, json};

use super::*;
use crate::domain::settings::{self, SETTINGS_ITEM_TYPE};
use crate::storage::open_data;
use crate::storage::repositories::projectors::settings::SETTINGS_ITEM_ID;
use crate::storage::repositories::{InboundRecord, sync_items};
use crate::storage::test_support::{TempDir, temp_dir};

fn open(label: &str) -> (AppSettings, TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    (AppSettings::for_test(db, "device-b"), dir)
}

fn patch(value: Value) -> Map<String, Value> {
    value.as_object().expect("an object").clone()
}

fn blob(app: &AppSettings, group: &str) -> Option<Value> {
    app.db
        .call_blocking(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT value FROM local_settings WHERE key = ?1",
                    [group],
                    |row| row.get(0),
                )
                .optional()
                .map_err(failed)?;
            Ok(raw.map(|raw| serde_json::from_str(&raw).expect("a JSON blob")))
        })
        .expect("blob")
}

fn synced(app: &AppSettings, path: &str) -> Option<Value> {
    app.db
        .call_blocking(|conn| settings::read(conn, path))
        .expect("synced")
}

fn clock_of(app: &AppSettings, path: &str) -> Option<Value> {
    app.db
        .call_blocking(|conn| Ok(settings::field_clock(conn, path)?.map(|clock| json!(clock))))
        .expect("clock")
}

fn remote(app: &AppSettings, payload: &str) {
    app.db
        .call_blocking(|conn| {
            sync_items::apply_remote(
                conn,
                &InboundRecord {
                    item_type: SETTINGS_ITEM_TYPE.to_owned(),
                    item_id: SETTINGS_ITEM_ID.to_owned(),
                    payload_json: payload.to_owned(),
                    server_cursor: Some(1),
                    signer_device_id: Some("device-a".to_owned()),
                    updated_at: 1,
                    deleted_at: None,
                },
                1,
            )?;
            Ok(())
        })
        .expect("remote");
}

fn group(app: &AppSettings, name: &str) -> Value {
    app.get_group(name).expect("group").value
}

#[test]
fn defaults_syncable_lists_and_maps_match_desktop_group_for_group() {
    let file: Value = serde_json::from_str(include_str!(
        "../../../../../packages/contracts/test-vectors/settings-groups.json"
    ))
    .expect("the committed vector file");
    let expected = file["groups"].as_object().expect("groups");
    assert_eq!(file["meta"]["groupCount"], json!(expected.len()));

    let mut names: Vec<&str> = group_names();
    names.sort_unstable();
    let mut vector_names: Vec<&str> = expected.keys().map(String::as_str).collect();
    vector_names.sort_unstable();
    assert_eq!(names, vector_names, "a group on one side only");

    for spec in groups::GROUPS {
        let want = &expected[spec.name];
        assert_eq!(
            (spec.defaults)(),
            want["defaults"],
            "{} defaults",
            spec.name
        );
        let mut ours: Vec<&str> = spec.syncable.to_vec();
        ours.sort_unstable();
        let mut theirs: Vec<&str> = want["syncable"]
            .as_array()
            .expect("syncable")
            .iter()
            .map(|field| field.as_str().expect("a field"))
            .collect();
        theirs.sort_unstable();
        assert_eq!(ours, theirs, "{} syncable fields", spec.name);

        let maps = want["maps"].as_array().expect("maps");
        assert_eq!(spec.maps.len(), maps.len(), "{} map fields", spec.name);
        for map in maps {
            let name = map["name"].as_str().expect("map name");
            let field = spec
                .map(name)
                .unwrap_or_else(|| panic!("{} has no map {name}", spec.name));
            assert_eq!(map["inGroup"], json!(field.in_group), "{name} inGroup");
            for key in map["validEntries"].as_array().expect("valid") {
                let key = key.as_str().expect("key");
                assert!((field.entry_ok)(key), "{name}: `{key}` must be accepted");
            }
            for key in map["invalidEntries"].as_array().expect("invalid") {
                let key = key.as_str().expect("key");
                assert!(!(field.entry_ok)(key), "{name}: `{key}` must be refused");
            }
        }
    }

    for (path, range) in file["ranges"].as_object().expect("ranges") {
        let (group, field) = path.split_once('.').expect("group.field");
        assert_eq!(
            groups::range(group, field),
            Some((
                range["min"].as_f64().expect("min"),
                range["max"].as_f64().expect("max")
            )),
            "{path}"
        );
    }
}

#[test]
fn a_group_reads_defaults_then_the_local_blob_then_the_synced_values() {
    let (app, _dir) = open("app-settings-order");
    assert_eq!(group(&app, "general")["theme"], json!("white"));

    app.set_group(
        "general",
        patch(json!({ "startOnBoot": true, "theme": "dark", "fontSizePx": 18 })),
    )
    .expect("write");
    let general = group(&app, "general");
    assert_eq!(general["startOnBoot"], json!(true), "local overlay");
    assert_eq!(general["theme"], json!("dark"), "synced overlay");
    assert_eq!(general["language"], json!("en"), "default for the rest");

    // A synced field in the blob is stale by definition: the synced item owns it.
    app.db
        .call_blocking(|conn| {
            conn.execute(
                "UPDATE local_settings SET value = ?1 WHERE key = 'general'",
                [json!({ "startOnBoot": true, "theme": "light" }).to_string()],
            )
            .map_err(failed)?;
            Ok(())
        })
        .expect("plant a stale synced field");
    assert_eq!(group(&app, "general")["theme"], json!("dark"));
}

#[test]
fn a_write_splits_into_the_synced_item_and_the_local_blob() {
    let (app, _dir) = open("app-settings-split");
    let change = app
        .set_group(
            "general",
            patch(json!({ "theme": "dark", "zoomFactor": 1.5, "startOnBoot": true })),
        )
        .expect("write");
    assert_eq!(change.group, "general");
    assert_eq!(change.fields, vec!["theme", "zoomFactor", "startOnBoot"]);

    assert_eq!(synced(&app, "general.theme"), Some(json!("dark")));
    assert_eq!(
        clock_of(&app, "general.theme"),
        Some(json!({ "device-b": 1 }))
    );
    assert_eq!(
        synced(&app, "general.zoomFactor"),
        None,
        "device-local stays local"
    );
    assert_eq!(synced(&app, "general.startOnBoot"), None);
    assert_eq!(
        blob(&app, "general"),
        Some(json!({ "startOnBoot": true, "zoomFactor": 1.5 })),
        "the blob never holds a synced field"
    );

    let queued: i64 = app
        .db
        .call_blocking(|conn| {
            conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                .map_err(failed)
        })
        .expect("outbox");
    assert_eq!(queued, 1, "the synced write is published");
}

#[test]
fn a_local_only_write_publishes_and_seeds_nothing() {
    let (app, _dir) = open("app-settings-local-only");
    app.set_group("tasks", patch(json!({ "staleInboxDays": 14 })))
        .expect("write");
    // Same synced value twice: the second write moves no clock.
    app.set_group(
        "general",
        patch(json!({ "theme": "dark", "startOnBoot": true })),
    )
    .expect("first");
    app.set_group(
        "general",
        patch(json!({ "theme": "dark", "startOnBoot": false })),
    )
    .expect("second");

    assert_eq!(
        clock_of(&app, "general.theme"),
        Some(json!({ "device-b": 1 }))
    );
    assert_eq!(group(&app, "general")["startOnBoot"], json!(false));
    assert_eq!(group(&app, "tasks")["staleInboxDays"], json!(14));
    let queued: i64 = app
        .db
        .call_blocking(|conn| {
            conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                .map_err(failed)
        })
        .expect("outbox");
    assert_eq!(queued, 1);

    let (fresh, _dir) = open("app-settings-no-seed");
    fresh
        .set_group("tasks", patch(json!({ "staleInboxDays": 3 })))
        .expect("write");
    let item = fresh
        .db
        .call_blocking(|conn| sync_items::load(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID))
        .expect("load");
    assert!(
        item.is_none(),
        "a local write must not seed the synced item"
    );
}

#[test]
fn a_synced_value_that_did_not_change_still_lets_the_local_part_land() {
    let (app, _dir) = open("app-settings-noop-synced");
    app.set_group("general", patch(json!({ "theme": "dark" })))
        .expect("seed");
    app.set_group(
        "general",
        patch(json!({ "theme": "dark", "zoomFactor": 1.25 })),
    )
    .expect("write");
    assert_eq!(group(&app, "general")["zoomFactor"], json!(1.25));
    assert_eq!(
        clock_of(&app, "general.theme"),
        Some(json!({ "device-b": 1 }))
    );
}

#[test]
fn a_map_entry_has_its_own_clock_and_null_is_the_delete_marker() {
    let (app, _dir) = open("app-settings-maps");
    app.set_group(
        "journal",
        patch(
            json!({ "weekdayTemplates": { "1": "tpl-mon", "3": "tpl-wed" }, "showTasks": false }),
        ),
    )
    .expect("write");
    assert_eq!(
        clock_of(&app, "journal.weekdayTemplates.1"),
        Some(json!({ "device-b": 1 }))
    );
    assert_eq!(
        clock_of(&app, "journal.weekdayTemplates.3"),
        Some(json!({ "device-b": 1 }))
    );
    assert_eq!(
        clock_of(&app, "journal.weekdayTemplates"),
        None,
        "no clock for the whole map"
    );

    app.set_path("journal.weekdayTemplates.1", Value::Null)
        .expect("clear a day");
    assert_eq!(
        clock_of(&app, "journal.weekdayTemplates.1"),
        Some(json!({ "device-b": 2 }))
    );
    assert_eq!(
        clock_of(&app, "journal.weekdayTemplates.3"),
        Some(json!({ "device-b": 1 }))
    );

    let journal = group(&app, "journal");
    assert_eq!(
        journal["weekdayTemplates"],
        json!({ "3": "tpl-wed" }),
        "a delete marker reads as absent"
    );
    assert_eq!(journal["showTasks"], json!(false));
    assert_eq!(
        app.get_path("journal.weekdayTemplates.3").expect("path"),
        Some(json!("tpl-wed"))
    );

    // A patch of one day leaves the others alone.
    app.set_group(
        "journal",
        patch(json!({ "weekdayTemplates": { "5": "tpl-fri" } })),
    )
    .expect("one day");
    assert_eq!(
        group(&app, "journal")["weekdayTemplates"]["3"],
        json!("tpl-wed")
    );
}

#[test]
fn callout_types_are_a_synced_map_that_stays_out_of_the_editor_group() {
    let (app, _dir) = open("app-settings-callouts");
    app.set_path("editor.calloutTypes.my-type", json!({ "name": "my-type" }))
        .expect("write");
    assert_eq!(
        clock_of(&app, "editor.calloutTypes.my-type"),
        Some(json!({ "device-b": 1 }))
    );
    assert!(group(&app, "editor").get("calloutTypes").is_none());
    assert_eq!(
        app.get_path("editor.calloutTypes.my-type").expect("path"),
        Some(json!({ "name": "my-type" }))
    );
    assert!(
        app.set_path("editor.calloutTypes.Bad Name", Value::Null)
            .is_err()
    );
}

#[test]
fn an_invalid_patch_writes_nothing_at_all() {
    let (app, _dir) = open("app-settings-invalid");
    for bad in [
        json!({ "theme": "dark", "fontSizePx": 99 }),
        json!({ "theme": "dark", "zoomFactor": 0.1 }),
        json!({ "theme": "dark", "startOnBoot": "yes" }),
        json!({ "theme": null }),
        json!({ "theme": "dark", "zoomFactor": 2.5 }),
    ] {
        let refused = app.set_group("general", patch(bad.clone()));
        assert!(
            matches!(refused, Err(StorageError::Invalid { .. })),
            "{bad}"
        );
    }
    assert!(
        app.set_group(
            "journal",
            patch(json!({ "weekdayTemplates": { "9": "x" } }))
        )
        .is_err()
    );
    assert!(
        app.set_group("journal", patch(json!({ "weekdayTemplates": "x" })))
            .is_err()
    );
    assert!(app.set_group("nope", patch(json!({ "a": 1 }))).is_err());

    assert_eq!(synced(&app, "general.theme"), None);
    assert_eq!(blob(&app, "general"), None);
    assert!(
        app.set_group(
            "general",
            patch(json!({ "fontSizePx": 12, "zoomFactor": 2 }))
        )
        .is_ok()
    );
}

#[test]
fn a_nullable_default_takes_any_type_and_an_unknown_field_is_kept() {
    let (app, _dir) = open("app-settings-unknown");
    app.set_group(
        "tasks",
        patch(json!({ "defaultProjectId": "p1", "futureKnob": { "a": [1] } })),
    )
    .expect("write");
    let tasks = group(&app, "tasks");
    assert_eq!(tasks["defaultProjectId"], json!("p1"));
    assert_eq!(tasks["futureKnob"], json!({ "a": [1] }));
    app.set_group("tasks", patch(json!({ "staleInboxDays": 9 })))
        .expect("later write");
    assert_eq!(
        group(&app, "tasks")["futureKnob"],
        json!({ "a": [1] }),
        "survives other writes"
    );
}

#[test]
fn a_corrupt_blob_resets_to_defaults_and_is_reported_once() {
    let (app, _dir) = open("app-settings-corrupt");
    app.set_group("tasks", patch(json!({ "staleInboxDays": 9 })))
        .expect("write");
    app.db
        .call_blocking(|conn| {
            conn.execute(
                "UPDATE local_settings SET value = '{not json' WHERE key = 'tasks'",
                [],
            )
            .map_err(failed)?;
            Ok(())
        })
        .expect("corrupt");

    let first = app.get_group("tasks").expect("read");
    assert!(first.corrupt_reset);
    assert_eq!(first.value["staleInboxDays"], json!(7));
    assert_eq!(blob(&app, "tasks"), None, "the bad row is gone");
    assert!(!app.get_group("tasks").expect("read").corrupt_reset);

    // Writing over a corrupt blob replaces it instead of failing.
    app.db
        .call_blocking(|conn| {
            conn.execute(
                "UPDATE local_settings SET value = '{x' WHERE key = 'tasks'",
                [],
            )
            .map_err(failed)?;
            Ok(())
        })
        .expect("corrupt again");
    app.set_group("tasks", patch(json!({ "staleInboxDays": 5 })))
        .expect("write over");
    assert_eq!(group(&app, "tasks")["staleInboxDays"], json!(5));
}

#[test]
fn a_remote_apply_shows_in_the_group_and_never_in_the_local_blob() {
    let (app, _dir) = open("app-settings-remote");
    remote(
        &app,
        concat!(
            r#"{"settings":{"general":{"theme":"dark","language":"de"},"#,
            r#""journal":{"weekdayTemplates":{"2":"tpl-tue","x":"junk"}},"experimental":{"a":1}},"#,
            r#""fieldClocks":{"general.theme":{"device-a":1},"general.language":{"device-a":1},"#,
            r#""journal.weekdayTemplates.2":{"device-a":1}}}"#
        ),
    );
    let general = group(&app, "general");
    assert_eq!(general["theme"], json!("dark"));
    assert_eq!(general["language"], json!("de"));
    assert_eq!(
        group(&app, "journal")["weekdayTemplates"],
        json!({ "2": "tpl-tue" })
    );
    assert_eq!(blob(&app, "general"), None);

    // A local write to another field leaves what a newer build wrote verbatim.
    app.set_group("general", patch(json!({ "theme": "light" })))
        .expect("write");
    assert_eq!(synced(&app, "experimental.a"), Some(json!(1)));
    assert_eq!(
        clock_of(&app, "general.theme"),
        Some(json!({ "device-a": 1, "device-b": 1 }))
    );
}

#[test]
fn the_synced_and_local_halves_commit_together_or_not_at_all() {
    let (app, _dir) = open("app-settings-atomic");
    app.db
        .call_blocking(|conn| {
            conn.execute("DROP TABLE local_settings", [])
                .map_err(failed)?;
            Ok(())
        })
        .expect("break the local half");

    let refused = app.set_group(
        "general",
        patch(json!({ "theme": "dark", "startOnBoot": true })),
    );
    assert!(refused.is_err());
    assert_eq!(
        synced(&app, "general.theme"),
        None,
        "the synced half rolled back"
    );
    let item = app
        .db
        .call_blocking(|conn| sync_items::load(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID))
        .expect("load");
    assert!(item.is_none());
}

#[test]
fn a_path_needs_a_group_and_a_field() {
    let (app, _dir) = open("app-settings-paths");
    for bad in ["", "general", "general.", ".theme"] {
        assert!(app.get_path(bad).is_err(), "{bad}");
        assert!(app.set_path(bad, json!(1)).is_err(), "{bad}");
    }
    assert_eq!(app.get_path("general.noSuchField").expect("absent"), None);
}

#[test]
fn a_map_entry_value_of_the_wrong_type_is_refused() {
    let (app, _dir) = open("app-settings-entry-types");
    assert!(
        app.set_path("journal.weekdayTemplates.0", json!(5))
            .is_err()
    );
    assert!(
        app.set_path("journal.weekdayTemplates.0", json!({ "a": 1 }))
            .is_err()
    );
    assert!(app.set_path("sidebar.sortModes.tags", json!(true)).is_err());
    assert!(app.set_path("sidebar.sortModes.tags", Value::Null).is_err());
    assert!(app.set_path("editor.calloutTypes.ok", json!("x")).is_err());
    assert_eq!(synced(&app, "journal.weekdayTemplates.0"), None);
    assert!(
        app.set_path("sidebar.sortModes.tags", json!("name-asc"))
            .is_ok()
    );
}

#[test]
fn valid_json_that_is_not_an_object_is_kept_and_read_as_defaults() {
    let (app, _dir) = open("app-settings-newer-shape");
    app.set_group("tasks", patch(json!({ "staleInboxDays": 9 })))
        .expect("write");
    app.db
        .call_blocking(|conn| {
            conn.execute(
                "UPDATE local_settings SET value = '[1]' WHERE key = 'tasks'",
                [],
            )
            .map_err(failed)?;
            Ok(())
        })
        .expect("newer shape");
    let read = app.get_group("tasks").expect("read");
    assert!(!read.corrupt_reset);
    assert_eq!(read.value["staleInboxDays"], json!(7));
    assert_eq!(
        blob(&app, "tasks"),
        Some(json!([1])),
        "the row is not deleted"
    );
}

#[test]
fn a_flat_local_key_round_trips_and_a_group_name_is_refused() {
    let (app, _dir) = open("flat-local");
    assert_eq!(app.get_local("tagSearches").expect("read"), None);
    app.set_local("tagSearches", &json!([{"id": "a"}]))
        .expect("write");
    assert_eq!(
        app.get_local("tagSearches").expect("read"),
        Some(json!([{"id": "a"}]))
    );
    assert!(app.set_local("general", &json!({})).is_err());
    assert!(app.get_local("bad key").is_err());
    assert_eq!(
        group_defaults("sidebar").expect("known")["showFiles"],
        json!(true)
    );
    assert_eq!(group_defaults("nope"), None);
}
