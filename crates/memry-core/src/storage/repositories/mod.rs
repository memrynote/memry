//! The repositories and the per-type projectors (FR-033, data-model §A.1,
//! chapter 13).
//!
//! One rule shapes every file below, and it is the whole of FR-033:
//!
//! > `sync_items.payload` holds the decrypted payload **exactly as received**
//! > and is never re-serialised.
//!
//! Everything else follows from it. A payload schema is a **reader over a
//! copy** ([`schema`]), a projection column is a **cache of a parse**
//! ([`projectors`]), and a local edit merges the changed keys into the parsed
//! copy and stores *that* ([`payload::StoredPayload::merge`]) rather than
//! serialising a row back out.
//!
//! The failure this prevents is not hypothetical. Desktop parses the payload
//! through a closed `z.object`, projects the result into columns, and rebuilds
//! the push payload from those columns; Zod strips every key it does not
//! declare at every level, so a field a newer build wrote is deleted from the
//! server the next time an older build touches the row. It is tracked as
//! **#2183**, `task-handler.ts:278-284` documents the loss for
//! `linkedCanvasIds` and works around it with a presence guard, and §13.2.3
//! says in as many words that "a plain derived deserialise-then-reserialise
//! reproduces desktop's bug exactly". There is therefore no
//! `#[derive(Deserialize)]` payload struct anywhere under this module, and a
//! reviewer should treat one appearing as a regression rather than a
//! simplification.
//!
//! | Module          | What it owns                                                   |
//! | --------------- | -------------------------------------------------------------- |
//! | [`payload`]     | the stored string and the two operations allowed on it          |
//! | [`schema`]      | the field table per type, and the errors a bad payload produces |
//! | [`projectors`]  | one reader and one writer per subscribed type                   |
//! | [`sync_items`]  | the table itself: apply, local edit, push, rebuild              |
//! | [`instants`]    | ISO-8601 ↔ epoch milliseconds, for projection columns only     |

pub mod instants;
pub mod payload;
pub mod projectors;
pub mod schema;
pub mod sync_items;

pub use payload::{Change, StoredPayload};
pub use schema::ProjectionError;
pub use sync_items::{ApplyOutcome, InboundRecord, SyncItemRow};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Db, open_data, test_support::temp_dir};
    use rusqlite::{Connection, params};
    use serde_json::{Value, json};

    const NOW: i64 = 1_760_000_000_000;

    /// A payload a newer desktop wrote: two keys this build models, and one it
    /// has never heard of.
    const NEWER_NOTE: &str = r#"{"title":"A note","tags":["protocol"],"folderPath":"Notes","coverImage":{"url":"memry://cover/1","offsetY":0.25}}"#;

    fn open(label: &str) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        (db, dir)
    }

    fn note_record(payload_json: &str) -> InboundRecord {
        InboundRecord {
            item_type: "note".to_owned(),
            item_id: "note-1".to_owned(),
            payload_json: payload_json.to_owned(),
            server_cursor: Some(7),
            signer_device_id: Some("device-a".to_owned()),
            updated_at: NOW,
            deleted_at: None,
        }
    }

    fn stored_payload(conn: &Connection, item_type: &str, item_id: &str) -> String {
        conn.query_row(
            "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, item_id],
            |row| row.get(0),
        )
        .expect("the row exists")
    }

    #[test]
    fn an_unknown_key_survives_the_projection_byte_for_byte() {
        let (db, _dir) = open("repo-unknown-key");
        db.call_blocking(|conn| {
            let outcome = sync_items::apply_remote(conn, &note_record(NEWER_NOTE), NOW)?;
            assert_eq!(outcome, ApplyOutcome::Applied);

            // Rule 1: the bytes in the column are the bytes that arrived.
            assert_eq!(stored_payload(conn, "note", "note-1"), NEWER_NOTE);
            // Rule 4: and the bytes a push sends are those, not a row.
            assert_eq!(
                sync_items::push_payload(conn, "note", "note-1")?.as_deref(),
                Some(NEWER_NOTE)
            );

            // The projection is a cache of a parse: the modelled fields landed,
            // and `coverImage` has no column to land in.
            let (title, folder): (String, String) = conn
                .query_row(
                    "SELECT title, folder_path FROM notes WHERE id = 'note-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("the projection row");
            assert_eq!(title, "A note");
            assert_eq!(folder, "Notes");

            let tag: String = conn
                .query_row(
                    "SELECT tag FROM note_tags WHERE note_id = 'note-1'",
                    [],
                    |row| row.get(0),
                )
                .expect("the tag row");
            assert_eq!(tag, "protocol");
            Ok(())
        })
        .expect("apply");
    }

    #[test]
    fn a_local_edit_keeps_the_unknown_key_and_never_serialises_the_row() {
        let (db, _dir) = open("repo-local-edit");
        db.call_blocking(|conn| {
            sync_items::apply_remote(conn, &note_record(NEWER_NOTE), NOW)?;

            let pushed = sync_items::apply_local_edit(
                conn,
                "note",
                "note-1",
                &[("title", Change::set("Renamed"))],
                NOW + 1,
            )?;

            let parsed: Value = serde_json::from_str(&pushed).expect("valid JSON");
            assert_eq!(parsed["title"], json!("Renamed"));
            assert_eq!(
                parsed["coverImage"],
                json!({"url": "memry://cover/1", "offsetY": 0.25}),
                "the key this build does not model must ride along"
            );
            assert_eq!(parsed["tags"], json!(["protocol"]));

            // The stored bytes and the pushed bytes are one string, and P2
            // reads it from the live row rather than from a frozen queue entry.
            assert_eq!(stored_payload(conn, "note", "note-1"), pushed);
            assert_eq!(
                sync_items::push_payload(conn, "note", "note-1")?.as_deref(),
                Some(pushed.as_str())
            );

            let title: String = conn
                .query_row("SELECT title FROM notes WHERE id = 'note-1'", [], |row| {
                    row.get(0)
                })
                .expect("the projection row");
            assert_eq!(title, "Renamed");
            Ok(())
        })
        .expect("edit");
    }

    #[test]
    fn a_payload_that_fails_its_schema_is_recorded_corrupt_and_kept() {
        let (db, _dir) = open("repo-corrupt");
        db.call_blocking(|conn| {
            // `folder_config.icon` is the one non-optional field on any
            // subscribed type (§13.7.10).
            let record = InboundRecord {
                item_type: "folder_config".to_owned(),
                item_id: "Notes".to_owned(),
                payload_json: r#"{"clock":{"device-a":1}}"#.to_owned(),
                server_cursor: Some(9),
                signer_device_id: None,
                updated_at: NOW,
                deleted_at: None,
            };
            let outcome = sync_items::apply_remote(conn, &record, NOW)?;
            assert!(
                matches!(outcome, ApplyOutcome::Corrupt { .. }),
                "{outcome:?}"
            );

            let row = sync_items::load(conn, "folder_config", "Notes")?.expect("the row");
            // Rule 5: recorded, not skipped — and the bytes are still here, so
            // a later build that models the field rebuilds from them.
            assert_eq!(row.payload.as_deref(), Some(r#"{"clock":{"device-a":1}}"#));
            assert!(row.corrupt_reason.is_some());
            assert_eq!(row.corrupt_at, Some(NOW));

            let projected: i64 = conn
                .query_row("SELECT count(*) FROM folders", [], |row| row.get(0))
                .expect("count");
            assert_eq!(projected, 0, "a corrupt payload must not project");
            Ok(())
        })
        .expect("corrupt");
    }

    #[test]
    fn dropping_and_replaying_the_projections_rebuilds_them() {
        let (db, _dir) = open("repo-rebuild");
        db.call_blocking(|conn| {
            sync_items::apply_remote(conn, &note_record(NEWER_NOTE), NOW)?;
            conn.execute("DELETE FROM notes", []).expect("drop rows");
            conn.execute("DELETE FROM note_tags", [])
                .expect("drop rows");

            assert_eq!(sync_items::rebuild_projections(conn, NOW)?, 1);
            let title: String = conn
                .query_row("SELECT title FROM notes WHERE id = 'note-1'", [], |row| {
                    row.get(0)
                })
                .expect("the rebuilt row");
            assert_eq!(title, "A note");
            Ok(())
        })
        .expect("rebuild");
    }

    #[test]
    fn settings_round_trip_an_unmodelled_group_and_index_the_modelled_one() {
        let (db, _dir) = open("repo-settings");
        db.call_blocking(|conn| {
            let payload_json = concat!(
                r#"{"settings":{"general":{"theme":"dark"},"#,
                r#""experimental":{"agentSidebar":true}},"#,
                r#""fieldClocks":{"general.theme":{"device-a":1}}}"#
            );
            let record = InboundRecord {
                item_type: "settings".to_owned(),
                item_id: projectors::settings::SETTINGS_ITEM_ID.to_owned(),
                payload_json: payload_json.to_owned(),
                server_cursor: None,
                signer_device_id: None,
                updated_at: NOW,
                deleted_at: None,
            };
            assert_eq!(
                sync_items::apply_remote(conn, &record, NOW)?,
                ApplyOutcome::Applied
            );

            let (group, key, value): (String, String, String) = conn
                .query_row("SELECT \"group\", key, value FROM settings", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .expect("one indexed row");
            assert_eq!(
                (group.as_str(), key.as_str(), value.as_str()),
                ("general", "theme", "\"dark\"")
            );

            // FR-063: the group with no phone equivalent is not in the index
            // and is still in the payload, which is the only place it needs to
            // be for it to survive a round trip.
            let pushed =
                sync_items::push_payload(conn, "settings", projectors::settings::SETTINGS_ITEM_ID)?;
            assert_eq!(pushed.as_deref(), Some(payload_json));
            Ok(())
        })
        .expect("settings");
    }
}
