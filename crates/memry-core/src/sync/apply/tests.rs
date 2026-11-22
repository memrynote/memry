use super::*;

#[test]
fn the_apply_order_ranks_the_four_tiers_and_defaults_to_one() {
    assert_eq!(apply_rank("project"), 0);
    assert_eq!(apply_rank("note"), 1);
    assert_eq!(apply_rank("hologram"), 1);
    assert_eq!(apply_rank("task"), 2);
    assert_eq!(apply_rank("calendar_binding"), 3);
}

#[test]
fn the_two_field_merged_types_are_the_two_chapter_06_names() {
    // §6.8 is an enumeration, not a heuristic. If either constant ever
    // drifts, the dispatch silently stops merging and the last writer
    // wins the whole payload again.
    assert_eq!(tasks::ITEM_TYPE, "task");
    assert_eq!(projects::ITEM_TYPE, "project");
    // And the third row is named rather than falling through `_`: §6.9's
    // dotted paths are a different algorithm from §6.3.1's document gate,
    // and folding one into the other is what §6.8 forbids.
    assert_eq!(settings::SETTINGS_ITEM_TYPE, "settings");
}

// #2409: a late tombstone the revived row already dominates keeps it; a
// tombstone with no clock has nothing to weigh and applies as before.
#[test]
fn a_tombstone_older_than_a_revived_row_is_skipped_and_a_clockless_one_still_applies() {
    use crate::domain::journal;
    use crate::storage::{open_data, test_support::temp_dir};
    use crate::sync::clock::clock_of;

    let dir = temp_dir("apply-late-tombstone");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    let delete = |clock| Pending::Tombstone {
        item_type: "journal".to_owned(),
        item_id: "j2026-04-16".to_owned(),
        deleted_at: 5,
        server_cursor: None,
        clock,
        body_state_vector: None,
    };
    let live = |conn: &Connection| -> bool {
        sync_items::load(conn, "journal", "j2026-04-16")
            .expect("read")
            .is_some_and(|row| row.deleted_at.is_none())
    };
    db.call_blocking(|conn| {
        journal::open_day(conn, "2026-04-16", "device-a", 1)?;
        let first = clock_of([("device-a", 1), ("device-b", 1)]);
        assert_eq!(
            apply_page(conn, vec![delete(Some(first.clone()))], 2, None)?.deleted,
            1
        );
        journal::open_day(conn, "2026-04-16", "device-a", 3)?;

        let late = apply_page(conn, vec![delete(Some(first))], 4, None)?;
        assert_eq!((late.deleted, late.skipped), (0, 1));
        assert!(live(conn));

        let clockless = apply_page(conn, vec![delete(None)], 5, None)?;
        assert_eq!(clockless.deleted, 1);
        assert!(!live(conn));
        Ok(())
    })
    .expect("late tombstone");
}

#[test]
fn a_merge_outcome_maps_onto_the_pull_vocabulary_without_a_silent_skip() {
    assert_eq!(outcome(Inbound::Applied), ApplyOutcome::Applied);
    assert_eq!(
        outcome(Inbound::Merged {
            conflicted_fields: vec!["title".to_owned()],
        }),
        ApplyOutcome::Applied
    );
    assert_eq!(outcome(Inbound::Skipped), ApplyOutcome::Skipped);
    assert_eq!(
        outcome(Inbound::Corrupt {
            reason: "bad".to_owned(),
        }),
        ApplyOutcome::Corrupt {
            reason: "bad".to_owned(),
        }
    );
}

// #5433: desktop skips a pulled settings delete (settings-handler.ts
// applyDelete); the core follows. The row stays live and the queued edit
// stays queued, clocked or not.
#[test]
fn a_pulled_settings_delete_is_skipped_and_keeps_the_queued_edit() {
    use crate::domain::settings::{self as settings_domain, SETTINGS_ITEM_TYPE};
    use crate::storage::repositories::projectors::settings::SETTINGS_ITEM_ID;
    use crate::storage::{open_data, test_support::temp_dir};
    use crate::sync::clock::clock_of;

    let dir = temp_dir("apply-settings-delete");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    let delete = |clock| Pending::Tombstone {
        item_type: SETTINGS_ITEM_TYPE.to_owned(),
        item_id: SETTINGS_ITEM_ID.to_owned(),
        deleted_at: 5,
        server_cursor: None,
        clock,
        body_state_vector: None,
    };
    db.call_blocking(|conn| {
        let live = |conn: &Connection| -> bool {
            sync_items::load(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)
                .expect("read")
                .is_some_and(|row| row.deleted_at.is_none())
        };
        let queued = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM outbox WHERE item_type = ?1",
                [SETTINGS_ITEM_TYPE],
                |row| row.get(0),
            )
            .expect("count")
        };
        settings_domain::set(conn, "editor.font", "serif".into(), "device-a", 1)?;
        let clocked = clock_of([("device-b", 9)]);
        for tombstone in [delete(Some(clocked)), delete(None)] {
            let totals = apply_page(conn, vec![tombstone], 6, None)?;
            assert_eq!((totals.deleted, totals.skipped), (0, 1));
            assert!(live(conn));
            assert_eq!(queued(conn), 1);
        }

        // A later pulled settings record still merges.
        let record = InboundRecord {
            item_type: SETTINGS_ITEM_TYPE.to_owned(),
            item_id: SETTINGS_ITEM_ID.to_owned(),
            payload_json: r#"{"settings":{"theme":"dark"},"fieldClocks":{"theme":{"device-b":1}}}"#
                .to_owned(),
            server_cursor: None,
            signer_device_id: None,
            updated_at: 8,
            deleted_at: None,
        };
        let totals = apply_page(conn, vec![Pending::Record(record)], 8, None)?;
        assert_eq!((totals.applied, totals.deleted), (1, 0));
        assert!(live(conn));
        Ok(())
    })
    .expect("settings delete");
}

// #5433: a settings row an earlier build marked deleted comes back live on the
// next local edit, as desktop's undeletes on its next edit, so the edit syncs
// instead of retiring unsent (push/settle.rs `undeletes`).
#[test]
fn a_settings_row_an_earlier_build_deleted_revives_on_the_next_edit() {
    use crate::domain::settings::{self as settings_domain, SETTINGS_ITEM_TYPE};
    use crate::storage::repositories::projectors::settings::SETTINGS_ITEM_ID;
    use crate::storage::{open_data, test_support::temp_dir};

    let dir = temp_dir("apply-settings-revive");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        settings_domain::set(conn, "editor.font", "serif".into(), "device-a", 1)?;
        store::mark_deleted(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID, 2, None, 2)?;
        projectors::delete(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID, 2)?;

        settings_domain::set(conn, "editor.font", "mono".into(), "device-a", 3)?;
        let row = sync_items::load(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)?.expect("row");
        assert_eq!(row.deleted_at, None);
        let projected: Option<i64> = conn
            .query_row(
                "SELECT deleted_at FROM settings WHERE key = 'font'",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_failed)?;
        assert_eq!(projected, None);

        // The pulled-record merge revives it too.
        store::mark_deleted(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID, 4, None, 4)?;
        let record = InboundRecord {
            item_type: SETTINGS_ITEM_TYPE.to_owned(),
            item_id: SETTINGS_ITEM_ID.to_owned(),
            payload_json: r#"{"settings":{"editor":{"font":"sans"}},"fieldClocks":{"editor.font":{"device-a":2,"device-b":1}}}"#
                .to_owned(),
            server_cursor: None,
            signer_device_id: None,
            updated_at: 5,
            deleted_at: None,
        };
        assert_eq!(apply_page(conn, vec![Pending::Record(record)], 5, None)?.applied, 1);
        let row = sync_items::load(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)?.expect("row");
        assert_eq!(row.deleted_at, None);
        Ok(())
    })
    .expect("settings revive");
}
