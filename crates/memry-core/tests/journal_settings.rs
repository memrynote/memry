//! Journal template settings (spec 005-journal JP025, D9), against real SQLite.
//!
//! | Test                                                    | Rule                               |
//! | ------------------------------------------------------- | ---------------------------------- |
//! | a vault with no settings reads no templates             | defaults are null/absent           |
//! | set and clear tick exactly the leaf paths               | §6.9 per-field clocks, §13.4 null  |
//! | unknown journal keys and groups survive a write         | §13.10, D9 preserved keys          |
//! | keys outside 0..6 and non-strings are ignored on read   | `settings-sync.ts` weekday readers |
//! | a weekday outside 0..=6 is refused and writes nothing   | `StorageError::Invalid`            |
//! | re-writing the stored value writes nothing              | no-op writes                       |
//! | two devices editing two weekdays both keep their edit   | §6.9 clock per day                 |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::errors::StorageError;
use memry_core::domain::journal_ops::settings::{
    JournalTemplateSettingsView, journal_settings, set_default_template, set_weekday_template,
};
use memry_core::domain::settings;
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-b";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-journal-settings-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn inbound(payload: &Value, signer: &str) -> InboundRecord {
    InboundRecord {
        item_type: "settings".to_owned(),
        item_id: "synced_settings".to_owned(),
        payload_json: serde_json::to_string(payload).expect("serialise"),
        server_cursor: Some(7),
        signer_device_id: Some(signer.to_owned()),
        updated_at: NOW,
        deleted_at: None,
    }
}

fn seed(conn: &Connection, payload: Value) {
    let outcome = apply_inbound(conn, &inbound(&payload, "device-a"), NOW).expect("apply");
    assert_eq!(outcome, ApplyOutcome::Applied);
}

fn payload(conn: &Connection) -> Option<Value> {
    sync_items::push_payload(conn, "settings", "synced_settings")
        .expect("read the row")
        .map(|raw| serde_json::from_str(&raw).expect("payload JSON"))
}

fn queued(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
        .expect("count")
}

/// A desktop-written payload: every journal key desktop writes, an unknown
/// journal key, a malformed weekday key, and a group this build does not model.
fn desktop_payload() -> Value {
    json!({
        "settings": {
            "journal": {
                "defaultTemplate": "tpl-default",
                "weekdayTemplates": {"1": "tpl-mon", "7": "tpl-bogus", "x": "tpl-x"},
                "showStatsFooter": true,
                "showSchedule": false,
                "showTasks": true,
                "showAIConnections": false,
                "futureKey": {"nested": 1}
            },
            "experimental": {"agentSidebar": true}
        },
        "fieldClocks": {
            "journal.defaultTemplate": {"device-a": 2},
            "journal.weekdayTemplates.1": {"device-a": 1},
            "journal.weekdayTemplates.7": {"device-a": 1},
            "experimental.agentSidebar": {"device-a": 1}
        }
    })
}

#[test]
fn a_vault_with_no_settings_reads_no_templates() {
    let db = open("defaults");
    db.call_blocking(|conn| {
        let view = journal_settings(conn)?;
        assert_eq!(view, JournalTemplateSettingsView::default());
        assert_eq!(view.default_template, None);
        assert!(view.weekday_templates.iter().all(Option::is_none));
        assert!(payload(conn).is_none(), "a read never seeds the item");
        assert_eq!(queued(conn), 0);
        Ok(())
    })
    .expect("defaults");
}

#[test]
fn set_and_clear_tick_exactly_the_leaf_paths() {
    let db = open("set-clear");
    db.call_blocking(|conn| {
        let view = set_default_template(conn, Some("tpl-a".to_owned()), DEVICE, NOW)?;
        assert_eq!(view.default_template.as_deref(), Some("tpl-a"));
        let view = set_weekday_template(conn, 3, Some("tpl-wed".to_owned()), DEVICE, NOW + 1)?;
        assert_eq!(view.weekday_templates[3].as_deref(), Some("tpl-wed"));
        assert_eq!(queued(conn), 1, "the outbox coalesces one settings row");

        let stored = payload(conn).expect("a payload");
        let clocks = stored["fieldClocks"].as_object().expect("clocks");
        let mut paths: Vec<&str> = clocks.keys().map(String::as_str).collect();
        paths.sort_unstable();
        assert_eq!(
            paths,
            vec!["journal.defaultTemplate", "journal.weekdayTemplates.3"]
        );
        assert_eq!(clocks["journal.weekdayTemplates.3"], json!({DEVICE: 1}));

        let view = set_weekday_template(conn, 3, None, DEVICE, NOW + 2)?;
        assert_eq!(view.weekday_templates[3], None);
        let view = set_default_template(conn, None, DEVICE, NOW + 3)?;
        assert_eq!(view.default_template, None);

        let stored = payload(conn).expect("a payload");
        assert_eq!(
            stored["settings"]["journal"],
            json!({"defaultTemplate": null, "weekdayTemplates": {"3": null}}),
            "D9: a clear is an explicit null, never a dropped key"
        );
        assert_eq!(
            settings::field_clock(conn, "journal.weekdayTemplates.3")?,
            Some([(DEVICE.to_owned(), 2)].into_iter().collect())
        );
        assert_eq!(
            settings::field_clock(conn, "journal.defaultTemplate")?,
            Some([(DEVICE.to_owned(), 2)].into_iter().collect())
        );
        Ok(())
    })
    .expect("set and clear");
}

#[test]
fn unknown_journal_keys_and_groups_survive_a_write() {
    let db = open("preserved");
    db.call_blocking(|conn| {
        seed(conn, desktop_payload());
        set_weekday_template(conn, 5, Some("tpl-fri".to_owned()), DEVICE, NOW + 1)?;
        set_default_template(conn, None, DEVICE, NOW + 2)?;

        let stored = payload(conn).expect("a payload");
        let mut expected = desktop_payload();
        expected["settings"]["journal"]["defaultTemplate"] = Value::Null;
        expected["settings"]["journal"]["weekdayTemplates"]["5"] = json!("tpl-fri");
        assert_eq!(stored["settings"], expected["settings"]);

        let clocks = &stored["fieldClocks"];
        assert_eq!(
            clocks["journal.defaultTemplate"],
            json!({"device-a": 2, DEVICE: 1})
        );
        assert_eq!(clocks["journal.weekdayTemplates.5"], json!({DEVICE: 1}));
        assert_eq!(clocks["journal.weekdayTemplates.1"], json!({"device-a": 1}));
        assert_eq!(clocks["journal.weekdayTemplates.7"], json!({"device-a": 1}));
        assert_eq!(clocks["experimental.agentSidebar"], json!({"device-a": 1}));
        Ok(())
    })
    .expect("preserved");
}

#[test]
fn keys_outside_the_week_and_non_strings_are_ignored_on_read() {
    let db = open("ignored");
    db.call_blocking(|conn| {
        seed(
            conn,
            json!({
                "settings": {"journal": {
                    "defaultTemplate": 42,
                    "weekdayTemplates": {
                        "0": "tpl-sun", "2": null, "4": {"id": "x"},
                        "6": "tpl-sat", "7": "tpl-bogus", "-1": "tpl-neg", "01": "tpl-pad"
                    }
                }},
                "fieldClocks": {}
            }),
        );
        let view = journal_settings(conn)?;
        assert_eq!(view.default_template, None, "a non-string reads as unset");
        assert_eq!(
            view.weekday_templates,
            [
                Some("tpl-sun".to_owned()),
                None,
                None,
                None,
                None,
                None,
                Some("tpl-sat".to_owned()),
            ]
        );
        Ok(())
    })
    .expect("ignored");
}

#[test]
fn a_weekday_outside_the_week_is_refused_and_writes_nothing() {
    let db = open("refused");
    db.call_blocking(|conn| {
        for weekday in [7, 8, u8::MAX] {
            let refused = set_weekday_template(conn, weekday, Some("t".to_owned()), DEVICE, NOW);
            assert!(
                matches!(refused, Err(StorageError::Invalid { .. })),
                "weekday {weekday}: {refused:?}"
            );
        }
        assert!(payload(conn).is_none());
        assert_eq!(queued(conn), 0);
        Ok(())
    })
    .expect("refused");
}

#[test]
fn rewriting_the_stored_value_writes_nothing() {
    let db = open("noop");
    db.call_blocking(|conn| {
        seed(conn, desktop_payload());
        let before = payload(conn).expect("a payload");

        set_default_template(conn, Some("tpl-default".to_owned()), DEVICE, NOW + 1)?;
        set_weekday_template(conn, 1, Some("tpl-mon".to_owned()), DEVICE, NOW + 2)?;
        assert_eq!(payload(conn).expect("a payload"), before);
        assert_eq!(queued(conn), 0);

        set_weekday_template(conn, 2, None, DEVICE, NOW + 3)?;
        set_weekday_template(conn, 2, None, DEVICE, NOW + 4)?;
        assert_eq!(
            settings::field_clock(conn, "journal.weekdayTemplates.2")?,
            Some([(DEVICE.to_owned(), 1)].into_iter().collect()),
            "clearing an already-null day again must not tick"
        );
        assert_eq!(queued(conn), 1);
        Ok(())
    })
    .expect("noop");
}

#[test]
fn two_devices_editing_two_weekdays_both_keep_their_edit() {
    let phone = open("merge-phone");
    let laptop = open("merge-laptop");
    let base = json!({
        "settings": {"journal": {"weekdayTemplates": {"1": "tpl-mon"}, "showStatsFooter": true}},
        "fieldClocks": {"journal.weekdayTemplates.1": {"device-a": 1}}
    });

    let from_phone = phone
        .call_blocking(|conn| {
            seed(conn, base.clone());
            set_weekday_template(conn, 3, Some("tpl-wed".to_owned()), "phone", NOW + 1)?;
            Ok(payload(conn).expect("a payload"))
        })
        .expect("phone edit");
    let from_laptop = laptop
        .call_blocking(|conn| {
            seed(conn, base.clone());
            set_weekday_template(conn, 4, Some("tpl-thu".to_owned()), "laptop", NOW + 1)?;
            Ok(payload(conn).expect("a payload"))
        })
        .expect("laptop edit");

    let expected = [
        None,
        Some("tpl-mon".to_owned()),
        None,
        Some("tpl-wed".to_owned()),
        Some("tpl-thu".to_owned()),
        None,
        None,
    ];
    for (db, remote, signer) in [
        (&phone, &from_laptop, "laptop"),
        (&laptop, &from_phone, "phone"),
    ] {
        db.call_blocking(|conn| {
            apply_inbound(conn, &inbound(remote, signer), NOW + 2)?;
            let view = journal_settings(conn)?;
            assert_eq!(view.weekday_templates, expected);
            let stored = payload(conn).expect("a payload");
            assert_eq!(
                stored["settings"]["journal"]["showStatsFooter"],
                json!(true)
            );
            assert_eq!(
                stored["fieldClocks"]["journal.weekdayTemplates.3"],
                json!({"phone": 1})
            );
            assert_eq!(
                stored["fieldClocks"]["journal.weekdayTemplates.4"],
                json!({"laptop": 1})
            );
            Ok(())
        })
        .expect("merge");
    }
}
