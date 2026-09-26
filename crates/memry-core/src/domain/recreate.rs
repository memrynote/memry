//! Writing an id over its own tombstone: the create half of a re-created
//! journal day or folder path (#2409, chapter 05 §5.8).
//!
//! A re-create used to tick from the new payload's own clock, which the
//! tombstone's clock dominates, so the server refused it with
//! `SYNC_REPLAY_DETECTED` or `SYNC_DELETE_WINS` and a device that had missed
//! the delete could later overwrite it. Here the new clock is
//! `increment(merge(own, T), device)`, where `T` is every delete clock this
//! device knows for the id: the one [`crate::sync::store::tombstone_clock`]
//! recorded, and the stored payload's own clock, which a local delete stamped.
//! The rule is [`clock::recreate_base`], pinned against desktop by
//! `recreate-clock.json`. With no known `T` the clock is exactly what
//! [`next_clock`] gives, as before.

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{StoredPayload, sync_items};
use crate::sync::clock::{self, VectorClock};
use crate::sync::store;

use super::notes::{clock_in, failed, insert_local, next_clock};

/// The clock a write that (re)creates `(item_type, item_id)` carries: `own`'s
/// clock merged with every delete clock this device knows for the id
/// (`stored` is the tombstoned row's payload, when it kept one), then ticked.
pub(crate) fn recreate_clock(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    own: &Object,
    stored: Option<&Object>,
    device_id: &str,
) -> Result<Value, StorageError> {
    let mut known = store::tombstone_clock(tx, item_type, item_id)?.unwrap_or_default();
    if let Some(stored) = stored {
        known = clock::merge(&known, &clock_in(stored)?);
    }
    let tombstone = (!known.is_empty()).then_some(&known);
    let base: VectorClock = clock::recreate_base(&clock_in(own)?, tombstone, true);
    let mut seeded = Object::new();
    seeded.insert(
        "clock".to_owned(),
        serde_json::to_value(base).map_err(|error| StorageError::Failed {
            what: format!("clock will not serialise: {error}"),
        })?,
    );
    next_clock(&seeded, device_id)
}

/// Creates `(item_type, item_id)` with `payload`, over the id's tombstone
/// when there is one.
///
/// `payload`'s `clock` is the caller's own lineage before this write (absent
/// for a fresh create); the stored clock is [`recreate_clock`]'s. A
/// tombstoned row, with or without a payload, is replaced by the new one: the
/// id is being created again, and [`insert_local`] refuses any existing row.
/// A live row is left to [`insert_local`], which refuses it as before.
pub(crate) fn write_over_tombstone(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    mut payload: Object,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let tombstoned =
        sync_items::load(tx, item_type, item_id)?.filter(|row| row.deleted_at.is_some());
    // An unreadable tombstone payload is being replaced; its clock is only a
    // hint next to the recorded one.
    let stored = tombstoned
        .as_ref()
        .and_then(|row| row.payload.as_deref())
        .and_then(|raw| StoredPayload::parse(raw).ok());
    let clock = recreate_clock(
        tx,
        item_type,
        item_id,
        &payload,
        stored.as_ref().map(StoredPayload::object),
        device_id,
    )?;
    payload.insert("clock".to_owned(), clock);
    if tombstoned.is_some() {
        tx.execute(
            "DELETE FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, item_id],
        )
        .map_err(failed)?;
    }
    insert_local(tx, item_type, item_id, payload, now_ms)
}

#[cfg(test)]
mod tests {
    use crate::domain::{folders, journal, tag_admin};
    use crate::storage::repositories::sync_items;
    use crate::storage::{Db, open_data, test_support::temp_dir};
    use crate::sync::apply::{Pending, apply_page};
    use crate::sync::clock::{ClockOrder, VectorClock, clock_of, compare};

    const NOW: i64 = 1_760_000_000_000;
    const DAY: &str = "2026-04-16";

    fn open(label: &str) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        (db, dir)
    }

    fn remote_delete(item_type: &str, item_id: &str, clock: VectorClock) -> Pending {
        Pending::Tombstone {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            deleted_at: NOW + 1,
            server_cursor: Some(7),
            clock: Some(clock),
        }
    }

    fn stored_clock(conn: &rusqlite::Connection, item_type: &str, item_id: &str) -> VectorClock {
        let row = sync_items::load(conn, item_type, item_id)
            .expect("read")
            .expect("the row");
        serde_json::from_str(&row.clock.expect("a clock")).expect("a vector clock")
    }

    // #2409
    #[test]
    fn reopening_a_day_deleted_remotely_ticks_past_the_tombstone_clock() {
        let (db, _dir) = open("recreate-journal-remote");
        db.call_blocking(|conn| {
            let opened = journal::open_day(conn, DAY, "device-a", NOW)?;
            let tombstone = clock_of([("device-a", 1), ("device-b", 3)]);
            let totals = apply_page(
                conn,
                vec![remote_delete("journal", &opened.id, tombstone.clone())],
                vec![],
                NOW + 1,
            )?;
            assert_eq!(totals.deleted, 1);

            let reopened = journal::open_day(conn, DAY, "device-a", NOW + 2)?;

            assert!(reopened.revived);
            let clock = stored_clock(conn, "journal", &reopened.id);
            assert_eq!(compare(&clock, &tombstone), ClockOrder::After);
            assert_eq!(clock, clock_of([("device-a", 2), ("device-b", 3)]));
            Ok(())
        })
        .expect("reopen");
    }

    // #2409
    #[test]
    fn a_folder_re_created_after_a_remote_delete_ticks_past_the_tombstone() {
        let (db, _dir) = open("recreate-folder-remote");
        db.call_blocking(|conn| {
            folders::create(conn, "Notes", None, "device-a", NOW)?.acknowledge();
            let tombstone = clock_of([("device-a", 1), ("device-b", 5)]);
            apply_page(
                conn,
                vec![remote_delete("folder_config", "Notes", tombstone.clone())],
                vec![],
                NOW + 1,
            )?;

            folders::create(conn, "Notes", None, "device-a", NOW + 2)?.acknowledge();

            let clock = stored_clock(conn, "folder_config", "Notes");
            assert_eq!(compare(&clock, &tombstone), ClockOrder::After);
            Ok(())
        })
        .expect("re-create");
    }

    // #2409: a tag definition's id is its name, so re-colouring a deleted
    // name creates it over the peer's tombstone.
    #[test]
    fn a_tag_definition_re_created_after_a_remote_delete_ticks_past_the_tombstone() {
        let (db, _dir) = open("recreate-tag-remote");
        db.call_blocking(|conn| {
            tag_admin::set_color(conn, "Work", "rose", "device-a", NOW)?;
            let tombstone = clock_of([("device-a", 1), ("device-b", 4)]);
            apply_page(
                conn,
                vec![remote_delete("tag_definition", "work", tombstone.clone())],
                vec![],
                NOW + 1,
            )?;

            tag_admin::set_color(conn, "Work", "sky", "device-a", NOW + 2)?;

            let clock = stored_clock(conn, "tag_definition", "work");
            assert_eq!(compare(&clock, &tombstone), ClockOrder::After);
            Ok(())
        })
        .expect("re-create");
    }

    // #2409: the same after this device's own delete.
    #[test]
    fn a_tag_definition_re_created_after_a_local_delete_ticks_past_it() {
        let (db, _dir) = open("recreate-tag-local");
        db.call_blocking(|conn| {
            tag_admin::set_color(conn, "Work", "rose", "device-a", NOW)?;
            tag_admin::delete(conn, "Work", "device-a", NOW + 1)?;
            let deleted = stored_clock(conn, "tag_definition", "work");

            tag_admin::set_color(conn, "Work", "sky", "device-a", NOW + 2)?;

            let clock = stored_clock(conn, "tag_definition", "work");
            assert_eq!(compare(&clock, &deleted), ClockOrder::After);
            Ok(())
        })
        .expect("re-create");
    }

    // #2409: a delete this device never saw leaves the clock of a fresh create alone.
    #[test]
    fn with_no_known_tombstone_the_clock_is_the_fresh_one() {
        let (db, _dir) = open("recreate-fresh");
        db.call_blocking(|conn| {
            folders::create(conn, "Notes", None, "device-a", NOW)?.acknowledge();
            assert_eq!(
                stored_clock(conn, "folder_config", "Notes"),
                clock_of([("device-a", 1)])
            );
            Ok(())
        })
        .expect("create");
    }
}
