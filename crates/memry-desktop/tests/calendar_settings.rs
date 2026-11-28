//! Calendar settings through the settings service on a real `data.db`: every group's defaults
//! (desktop's `CALENDAR_*_SETTINGS_DEFAULTS`), the provider groups' sanitizing and the
//! unsupported-provider text. Which leaves sync is core's (`app_settings/calendar_tests.rs`).

use memry_core::domain::settings;
use memry_desktop::settings::SettingsError;
use serde_json::{Value, json};

use crate::settings_service::{patch, world};

fn invalid(result: Result<impl std::fmt::Debug, SettingsError>) -> String {
    match result {
        Err(SettingsError::Invalid(message)) => message,
        other => panic!("expected an invalid-value error, got {other:?}"),
    }
}

#[test]
fn each_calendar_group_reads_its_defaults_with_and_without_a_vault() {
    let w = world();
    let vault = w.open("calendar-defaults");
    let expected = [
        (
            "calendar",
            json!({
                "dayCellClickBehavior": "journal",
                "calendarPageClickOverride": "calendar",
                "weekStartDay": "monday",
                "showNotesOnCalendar": false
            }),
        ),
        (
            "calendar.google",
            json!({
                "defaultTargetCalendarId": null,
                "onboardingCompleted": false,
                "promoteConfirmDismissed": false,
                "pushEventsToGoogle": true,
                "agentReadEventsConsent": null
            }),
        ),
    ];
    for (group, want) in &expected {
        for open in [None, Some(&vault)] {
            let read = w.service.read_group(open, group).expect("read").value;
            assert_eq!(Value::Object(read), *want, "{group}");
        }
    }
    let providers = [
        ("google", expected[1].1.clone()),
        (
            "caldav",
            json!({ "agentReadEventsConsent": null, "pushEventsToProvider": true }),
        ),
        ("ics", json!({ "agentReadEventsConsent": null })),
        ("apple-eventkit", json!({ "agentReadEventsConsent": null })),
    ];
    for (provider, want) in &providers {
        let read = w
            .service
            .read_calendar_provider(Some(&vault), provider)
            .expect("read")
            .expect("a known provider");
        assert_eq!(Value::Object(read.value), *want, "{provider}");
    }
    for unknown in ["outlook", "", "google.x", "calendar"] {
        assert!(
            w.service
                .read_calendar_provider(Some(&vault), unknown)
                .expect("read")
                .is_none(),
            "`{unknown}` has no group"
        );
    }
}

#[test]
fn a_provider_write_keeps_only_declared_fields_and_refuses_a_wrong_type() {
    let w = world();
    let vault = w.open("calendar-provider-write");
    let read = |provider: &str| {
        Value::Object(
            w.service
                .read_calendar_provider(Some(&vault), provider)
                .expect("read")
                .expect("known")
                .value,
        )
    };

    let change = w
        .service
        .write_calendar_provider(
            Some(&vault),
            "caldav",
            patch(json!({ "pushEventsToProvider": false, "unknownKey": 1 })),
        )
        .expect("write");
    assert_eq!(change.group, "calendar.caldav");
    assert_eq!(change.fields, vec!["pushEventsToProvider"]);
    assert_eq!(
        read("caldav"),
        json!({ "agentReadEventsConsent": null, "pushEventsToProvider": false })
    );

    // ICS cannot write, so it has no one-way switch to store.
    w.service
        .write_calendar_provider(
            Some(&vault),
            "ics",
            patch(json!({ "agentReadEventsConsent": true, "pushEventsToProvider": false })),
        )
        .expect("write");
    assert_eq!(read("ics"), json!({ "agentReadEventsConsent": true }));

    w.service
        .write_calendar_provider(
            Some(&vault),
            "google",
            patch(json!({ "defaultTargetCalendarId": "primary" })),
        )
        .expect("write");
    assert_eq!(read("google")["defaultTargetCalendarId"], json!("primary"));

    for bad in [
        json!({ "agentReadEventsConsent": "yes" }),
        json!({ "pushEventsToProvider": null }),
    ] {
        assert_eq!(
            invalid(
                w.service
                    .write_calendar_provider(Some(&vault), "caldav", patch(bad))
            ),
            "Invalid calendar provider settings"
        );
    }
    assert_eq!(
        read("caldav")["pushEventsToProvider"],
        json!(false),
        "a refused write changes nothing"
    );
}

#[test]
fn an_unknown_provider_gets_desktops_unsupported_text() {
    let w = world();
    let vault = w.open("calendar-unknown-provider");
    assert_eq!(
        invalid(w.service.write_calendar_provider(
            Some(&vault),
            "outlook",
            patch(json!({ "agentReadEventsConsent": true }))
        )),
        "Unsupported calendar provider: outlook"
    );
}

#[test]
fn opening_a_vault_promotes_a_calendar_leaf_an_earlier_build_kept_local() {
    let w = world();
    let vault = w.open("calendar-promote-on-open");
    let db = vault.vault.db_handle();
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO local_settings (key, value, updated_at) VALUES ('calendar', ?1, 1)",
            [r#"{"weekStartDay":"sunday"}"#],
        )
        .unwrap();
        Ok(())
    })
    .expect("plant the blob");

    w.service.on_open(&vault).expect("open");

    let synced = db
        .call_blocking(|conn| settings::read(conn, "calendar.weekStartDay"))
        .expect("synced");
    assert_eq!(synced, Some(json!("sunday")));
    let blob: String = db
        .call_blocking(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value FROM local_settings WHERE key = 'calendar'",
                    [],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .expect("blob");
    assert_eq!(
        serde_json::from_str::<Value>(&blob).expect("json"),
        json!({})
    );
    assert_eq!(
        w.service
            .read_group(Some(&vault), "calendar")
            .expect("read")
            .value["weekStartDay"],
        "sunday"
    );
}
