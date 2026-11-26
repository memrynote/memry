use super::*;
use crate::storage::repositories::InboundRecord;
use crate::storage::{Db, open_data, test_support::temp_dir};
use serde_json::json;

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-b";

/// The committed `settings: an unknown field a newer client wrote` vector,
/// byte for byte: one modelled group, one the ten-group read view strips.
const SYNCED: &str = concat!(
    r#"{"settings":{"general":{"theme":"dark"},"experimental":{"agentSidebar":true}},"#,
    r#""fieldClocks":{"general.theme":{"device-a":1},"experimental.agentSidebar":{"device-a":1}}}"#
);

fn open(label: &str, payload_json: Option<&str>) -> (Db, crate::storage::test_support::TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    if let Some(payload_json) = payload_json {
        db.call_blocking(|conn| {
            let record = InboundRecord {
                item_type: SETTINGS_ITEM_TYPE.to_owned(),
                item_id: SETTINGS_ITEM_ID.to_owned(),
                payload_json: payload_json.to_owned(),
                server_cursor: Some(7),
                signer_device_id: Some("device-a".to_owned()),
                updated_at: NOW,
                deleted_at: None,
            };
            sync_items::apply_remote(conn, &record, NOW)?;
            Ok(())
        })
        .expect("seed");
    }
    (db, dir)
}

#[test]
fn a_write_to_a_modelled_group_leaves_an_unmodelled_one_verbatim() {
    let (db, _dir) = open("settings-unmodelled", Some(SYNCED));
    db.call_blocking(|conn| {
        let merged = set(conn, "general.theme", json!("light"), DEVICE, NOW + 1)?;
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");

        assert_eq!(parsed["settings"]["general"]["theme"], json!("light"));
        assert_eq!(
            parsed["settings"]["experimental"],
            json!({"agentSidebar": true}),
            "FR-063: a group this core does not model must survive the write"
        );
        assert_eq!(
            parsed["fieldClocks"]["experimental.agentSidebar"],
            json!({"device-a": 1}),
            "a clock for a path this build cannot model survives too (§6.9)"
        );
        assert_eq!(
            parsed["fieldClocks"]["general.theme"],
            json!({"device-a": 1, "device-b": 1})
        );

        // And the projection stays the closed ten-group read view.
        let indexed: Vec<String> = {
            let mut statement = conn
                .prepare("SELECT \"group\" FROM settings ORDER BY \"group\"")
                .expect("prepare");
            let mapped = statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query");
            mapped.map(|row| row.expect("row")).collect()
        };
        assert_eq!(indexed, vec!["general".to_owned()]);
        Ok(())
    })
    .expect("unmodelled");
}

#[test]
fn a_deep_path_creates_its_intermediates_and_clocks_the_leaf() {
    let (db, _dir) = open("settings-deep", Some(SYNCED));
    db.call_blocking(|conn| {
        set(
            conn,
            "journal.weekdayTemplates.3",
            json!("tpl-wed"),
            DEVICE,
            NOW + 1,
        )?;
        assert_eq!(
            read(conn, "journal.weekdayTemplates.3")?,
            Some(json!("tpl-wed"))
        );
        assert_eq!(
            field_clock(conn, "journal.weekdayTemplates.3")?,
            Some(clock::clock_of([(DEVICE, 1)]))
        );
        // Ancestors are plain objects with no clock of their own.
        assert_eq!(field_clock(conn, "journal")?, None);
        Ok(())
    })
    .expect("deep");
}

#[test]
fn a_vault_with_no_settings_item_yet_gets_one_on_the_first_write() {
    let (db, _dir) = open("settings-seed", None);
    db.call_blocking(|conn| {
        assert!(all(conn)?.is_empty());
        set(conn, "general.theme", json!("dark"), DEVICE, NOW)?;

        assert_eq!(read(conn, "general.theme")?, Some(json!("dark")));
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
            .expect("outbox");
        assert_eq!(queued, 1);
        Ok(())
    })
    .expect("seed");
}

#[test]
fn a_write_that_changes_nothing_seeds_nothing_and_pushes_nothing() {
    let (db, _dir) = open("settings-noop", None);
    db.call_blocking(|conn| {
        // A removal on a vault with no settings item at all.
        remove(conn, "general.theme", DEVICE, NOW)?;
        assert!(sync_items::load(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)?.is_none());

        set(conn, "general.theme", json!("dark"), DEVICE, NOW)?;
        let again = set(conn, "general.theme", json!("dark"), DEVICE, NOW + 1)?;
        assert_eq!(
            serde_json::from_str::<Value>(&again).expect("json")["fieldClocks"]["general.theme"],
            json!({"device-b": 1}),
            "re-writing the same value must not tick the clock"
        );
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
            .expect("outbox");
        assert_eq!(queued, 1);
        Ok(())
    })
    .expect("noop");
}

#[test]
fn a_clear_is_a_null_and_a_removal_drops_the_key_and_both_tick() {
    let (db, _dir) = open("settings-clear", Some(SYNCED));
    db.call_blocking(|conn| {
        clear(conn, "general.theme", DEVICE, NOW + 1)?;
        assert_eq!(read(conn, "general.theme")?, Some(Value::Null));

        remove(conn, "experimental.agentSidebar", DEVICE, NOW + 2)?;
        assert_eq!(read(conn, "experimental.agentSidebar")?, None);
        assert_eq!(
            field_clock(conn, "experimental.agentSidebar")?,
            Some(clock::clock_of([("device-a", 1), (DEVICE, 1)])),
            "a removal that did not tick would lose to the peer holding the old value"
        );
        Ok(())
    })
    .expect("clear");
}

#[test]
fn a_non_object_in_the_path_is_refused_rather_than_overwritten() {
    let (db, _dir) = open("settings-blocked", Some(SYNCED));
    db.call_blocking(|conn| {
        let refused = set(conn, "general.theme.tint", json!("warm"), DEVICE, NOW + 1);
        assert!(matches!(refused, Err(StorageError::Failed { .. })));
        assert_eq!(read(conn, "general.theme")?, Some(json!("dark")));

        assert!(set(conn, "", json!(1), DEVICE, NOW + 1).is_err());
        assert!(set(conn, "general.", json!(1), DEVICE, NOW + 1).is_err());
        Ok(())
    })
    .expect("blocked");
}

#[test]
fn a_payload_that_will_not_read_is_an_error_and_never_an_empty_map() {
    let (db, _dir) = open(
        "settings-unreadable",
        Some(r#"{"settings":[],"fieldClocks":{}}"#),
    );
    db.call_blocking(|conn| {
        assert!(all(conn).is_err());
        assert!(set(conn, "general.theme", json!("dark"), DEVICE, NOW + 1).is_err());
        Ok(())
    })
    .expect("unreadable");
}
