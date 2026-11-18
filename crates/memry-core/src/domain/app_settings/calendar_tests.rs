//! The calendar groups: which leaves sync (desktop's `calendar-settings-sync.ts`),
//! the provider groups whose names hold a dot, and the one-time promotion of
//! leaves an older build left in the local blob.

use serde_json::{Value, json};

use super::tests::open;
use super::*;
use crate::domain::settings;

fn patch(value: Value) -> Map<String, Value> {
    value.as_object().expect("an object").clone()
}

fn synced(app: &AppSettings, path: &str) -> Option<Value> {
    app.db
        .call_blocking(|conn| settings::read(conn, path))
        .expect("synced")
}

fn clocked(app: &AppSettings, path: &str) -> bool {
    app.db
        .call_blocking(|conn| settings::field_clock(conn, path))
        .expect("clock")
        .is_some()
}

fn blob(app: &AppSettings, group: &str) -> Option<Value> {
    app.db
        .read_blocking(|conn| {
            conn.query_row(
                "SELECT value FROM local_settings WHERE key = ?1",
                [group],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(failed)
        })
        .expect("blob")
        .map(|raw| serde_json::from_str(&raw).expect("a JSON blob"))
}

fn settings_outbox_rows(app: &AppSettings) -> i64 {
    app.db
        .read_blocking(|conn| {
            conn.query_row(
                "SELECT count(*) FROM outbox WHERE item_type = 'settings'",
                [],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .expect("outbox")
}

fn plant_blob(app: &AppSettings, group: &str, value: &Value) {
    app.db
        .call_blocking(|conn| {
            conn.execute(
                "INSERT INTO local_settings (key, value, updated_at) VALUES (?1, ?2, 1)",
                params![group, value.to_string()],
            )
            .map_err(failed)?;
            Ok(())
        })
        .expect("plant blob");
}

#[test]
fn every_synced_calendar_leaf_takes_its_own_clock_and_the_rest_stays_local() {
    let (app, _dir) = open("calendar-leaves");
    let writes = [
        (
            "calendar",
            json!({ "weekStartDay": "sunday", "showNotesOnCalendar": true }),
        ),
        (
            "calendar.google",
            json!({
                "defaultTargetCalendarId": "primary",
                "onboardingCompleted": true,
                "promoteConfirmDismissed": true,
                "pushEventsToGoogle": false,
                "agentReadEventsConsent": true
            }),
        ),
        (
            "calendar.caldav",
            json!({ "agentReadEventsConsent": false, "pushEventsToProvider": false }),
        ),
        ("calendar.ics", json!({ "agentReadEventsConsent": true })),
    ];
    for (group, values) in &writes {
        app.set_group(group, patch(values.clone())).expect("write");
        for (field, value) in values.as_object().expect("object") {
            let path = format!("{group}.{field}");
            assert_eq!(synced(&app, &path).as_ref(), Some(value), "{path} synced");
            assert!(clocked(&app, &path), "{path} has its own clock");
            assert_eq!(app.get_group(group).expect("read").value[field], *value);
        }
        assert_eq!(
            blob(&app, group),
            None,
            "{group}: nothing synced in the blob"
        );
    }
    let published = settings_outbox_rows(&app);
    assert!(published > 0, "the synced writes reach the outbox");

    let local = [
        (
            "calendar",
            json!({ "dayCellClickBehavior": "calendar", "calendarPageClickOverride": "inherit" }),
        ),
        (
            "calendar.apple-eventkit",
            json!({ "agentReadEventsConsent": true }),
        ),
    ];
    for (group, values) in &local {
        app.set_group(group, patch(values.clone())).expect("write");
        for field in values.as_object().expect("object").keys() {
            let path = format!("{group}.{field}");
            assert_eq!(synced(&app, &path), None, "{path} stays device-local");
            assert!(!clocked(&app, &path), "{path} has no clock");
        }
        assert_eq!(blob(&app, group).as_ref(), Some(values));
    }
    assert_eq!(
        settings_outbox_rows(&app),
        published,
        "local writes publish nothing"
    );
}

#[test]
fn provider_groups_read_their_defaults_and_remote_values() {
    let (app, _dir) = open("calendar-provider-defaults");
    let read = |group: &str| app.get_group(group).expect("read").value;
    assert_eq!(read("calendar")["weekStartDay"], json!("monday"));
    assert_eq!(read("calendar.google")["pushEventsToGoogle"], json!(true));
    assert_eq!(
        read("calendar.google")["agentReadEventsConsent"],
        Value::Null
    );
    assert_eq!(
        read("calendar.caldav"),
        json!({ "agentReadEventsConsent": null, "pushEventsToProvider": true })
    );
    assert_eq!(
        read("calendar.ics"),
        json!({ "agentReadEventsConsent": null })
    );
    assert_eq!(
        read("calendar.apple-eventkit"),
        json!({ "agentReadEventsConsent": null })
    );

    // Another device's leaf under the nested wire object reaches the sub-group.
    app.db
        .call_blocking(|conn| {
            settings::set(
                conn,
                "calendar.google.pushEventsToGoogle",
                json!(false),
                "device-a",
                1,
            )?;
            Ok(())
        })
        .expect("remote leaf");
    assert_eq!(read("calendar.google")["pushEventsToGoogle"], json!(false));
    assert!(
        read("calendar").get("google").is_none(),
        "the base group shows no provider object"
    );
}

#[test]
fn the_default_write_target_syncs_whole_and_a_cleared_one_is_absent() {
    let (app, _dir) = open("calendar-write-target");
    let target = json!({ "provider": "google", "remoteCalendarId": "primary" });
    app.set_path("calendar.defaultWriteTarget", target.clone())
        .expect("write");
    assert_eq!(
        synced(&app, "calendar.defaultWriteTarget"),
        Some(target.clone())
    );
    assert_eq!(
        app.get_path("calendar.defaultWriteTarget").expect("read"),
        Some(target)
    );
    app.set_path("calendar.defaultWriteTarget", Value::Null)
        .expect("clear");
    assert_eq!(
        synced(&app, "calendar.defaultWriteTarget"),
        Some(Value::Null),
        "cleared on the wire as null"
    );
    assert_eq!(
        app.get_path("calendar.defaultWriteTarget").expect("read"),
        None
    );
}

#[test]
fn a_path_into_a_provider_group_addresses_that_group() {
    let (app, _dir) = open("calendar-provider-path");
    app.set_path("calendar.google.onboardingCompleted", json!(true))
        .expect("write");
    assert_eq!(
        synced(&app, "calendar.google.onboardingCompleted"),
        Some(json!(true))
    );
    assert_eq!(
        app.get_path("calendar.google.onboardingCompleted")
            .expect("read"),
        Some(json!(true))
    );
    assert!(
        app.set_path("calendar.google.pushEventsToGoogle", json!("yes"))
            .is_err(),
        "the sub-group's types apply"
    );
}

#[test]
fn stranded_leaves_are_promoted_once_and_leave_the_blob() {
    let (app, _dir) = open("calendar-promote");
    plant_blob(
        &app,
        "calendar",
        &json!({ "weekStartDay": "sunday", "showNotesOnCalendar": false, "dayCellClickBehavior": "calendar" }),
    );
    // Before the promotion the stranded value is invisible: the synced item owns it.
    assert_eq!(
        app.get_group("calendar").expect("read").value["weekStartDay"],
        json!("monday")
    );

    assert_eq!(app.promote_stranded("calendar").expect("promote"), 1);
    assert_eq!(synced(&app, "calendar.weekStartDay"), Some(json!("sunday")));
    assert!(
        !clocked(&app, "calendar.showNotesOnCalendar"),
        "a default value is not pushed over other devices"
    );
    assert_eq!(
        blob(&app, "calendar"),
        Some(json!({ "dayCellClickBehavior": "calendar" }))
    );
    assert_eq!(
        app.get_group("calendar").expect("read").value["weekStartDay"],
        json!("sunday")
    );
    assert_eq!(app.promote_stranded("calendar").expect("again"), 0);
}

#[test]
fn a_stranded_leaf_some_device_already_clocked_is_dropped_not_promoted() {
    let (app, _dir) = open("calendar-promote-clocked");
    app.db
        .call_blocking(|conn| {
            settings::set(
                conn,
                "calendar.google.pushEventsToGoogle",
                json!(true),
                "device-a",
                1,
            )?;
            Ok(())
        })
        .expect("remote leaf");
    plant_blob(
        &app,
        "calendar.google",
        &json!({ "pushEventsToGoogle": false, "onboardingCompleted": true }),
    );

    assert_eq!(app.promote_stranded("calendar.google").expect("promote"), 1);
    assert_eq!(
        synced(&app, "calendar.google.pushEventsToGoogle"),
        Some(json!(true)),
        "the synced value wins"
    );
    assert_eq!(
        synced(&app, "calendar.google.onboardingCompleted"),
        Some(json!(true))
    );
    assert_eq!(blob(&app, "calendar.google"), Some(json!({})));
}
