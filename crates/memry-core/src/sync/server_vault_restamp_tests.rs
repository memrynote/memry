//! [`super::restamp`] on a real `data.db` (#5535): records a vault wrote under its local id
//! before its bind state the server id once, through the clock, and nothing else moves.

use rusqlite::Connection;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{bind, restamp};
use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::AtRestKey;
use crate::domain::agent_conversation::{self, NewConversation};
use crate::domain::agent_queue::{self, Queue};
use crate::domain::canvas::{self, NewCanvas};
use crate::domain::canvas_folder;
use crate::domain::desktop_records::testing::{DEVICE, NOW, clock, open, payload, queued};
use crate::sync::clock::{ClockOrder, compare};

const LOCAL: &str = "local-vault";
const SERVER: &str = "server-vault";

fn new_canvas(conn: &Connection, id: &str) -> Result<(), StorageError> {
    let new = NewCanvas {
        id: Some(id),
        title: Some(id),
        owner_note_id: None,
        scene: None,
        folder: None,
        icon: None,
    };
    canvas::create(conn, &new, LOCAL, DEVICE, NOW).map(drop)
}

fn conversation(conn: &Connection) -> Result<String, StorageError> {
    let key = AtRestKey::default();
    key.set(Some(Zeroizing::new([7; 32])));
    let new = NewConversation {
        vault_id: LOCAL,
        title: "Plan the week",
        backend: "local",
        backend_model: None,
    };
    agent_conversation::create(conn, &key, &new, Queue::Outbox, DEVICE, NOW)
        .map(|conversation| conversation.id)
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
}

/// Stands in for a push: the server took every queued row.
fn pushed(conn: &Connection) -> Result<(), StorageError> {
    conn.execute("DELETE FROM outbox", [])
        .map(drop)
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
}

fn projected(conn: &Connection, table: &str, id: &str) -> Option<String> {
    conn.query_row(
        &format!("SELECT vault_id FROM {table} WHERE id = ?1"),
        [id],
        |row| row.get(0),
    )
    .expect("a row")
}

#[test]
fn a_bind_restamps_each_live_local_record_once_through_its_clock() {
    let (db, _dir) = open("restamp-bind");
    db.call_blocking(|conn| {
        new_canvas(conn, "live")?;
        new_canvas(conn, "gone")?;
        canvas::delete(conn, "gone", DEVICE, NOW)?;
        canvas_folder::upsert(conn, LOCAL, "Work", None, DEVICE, NOW)?;
        let chat = conversation(conn)?;
        agent_queue::backfill(conn, LOCAL, NOW)?;
        pushed(conn)?;
        let before = payload(conn, "canvas", "live");
        let gone = payload(conn, "canvas", "gone");

        assert_eq!(restamp(conn, LOCAL, DEVICE, NOW + 1)?, 0, "unbound");
        bind(conn, SERVER)?;
        assert_eq!(restamp(conn, LOCAL, DEVICE, NOW + 1)?, 3);

        for (item_type, table, id) in [
            ("canvas", "canvases", "live"),
            ("canvas_folder", "canvas_folders", "cvf_work"),
            ("agent_conversation", "agent_conversations", chat.as_str()),
        ] {
            assert_eq!(payload(conn, item_type, id)["vaultId"], json!(SERVER));
            assert_eq!(projected(conn, table, id).as_deref(), Some(SERVER));
            assert_eq!(queued(conn, item_type, id), 1, "{item_type}");
        }
        // Only `vaultId` and the clock move, and the clock moves past the one it had.
        let after = payload(conn, "canvas", "live");
        let mut unchanged = after.clone();
        unchanged["vaultId"] = before["vaultId"].clone();
        unchanged["clock"] = before["clock"].clone();
        assert_eq!(unchanged, before);
        let old = serde_json::from_value(before["clock"].clone()).expect("a clock");
        assert_eq!(
            compare(&clock(conn, "canvas", "live"), &old),
            ClockOrder::After
        );
        // A deleted canvas is never pushed again: no update could revive it.
        assert_eq!(payload(conn, "canvas", "gone"), gone);
        assert_eq!(queued(conn, "canvas", "gone"), 0);

        pushed(conn)?;
        assert_eq!(restamp(conn, LOCAL, DEVICE, NOW + 2)?, 0, "once");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| row
                .get::<_, i64>(0))
                .expect("count"),
            0
        );
        assert_eq!(payload(conn, "canvas", "live"), after);
        Ok(())
    })
    .expect("restamp");
}

#[test]
fn a_vault_bound_to_its_own_id_or_records_of_another_vault_are_left_alone() {
    let (db, _dir) = open("restamp-own");
    db.call_blocking(|conn| {
        canvas_folder::upsert(conn, "another-vault", "Theirs", None, DEVICE, NOW)?;
        new_canvas(conn, "mine")?;
        pushed(conn)?;
        let theirs = payload(conn, "canvas_folder", "cvf_theirs");
        let mine = payload(conn, "canvas", "mine");
        bind(conn, LOCAL)?;
        assert_eq!(restamp(conn, LOCAL, DEVICE, NOW + 1)?, 0);
        assert_eq!(payload(conn, "canvas_folder", "cvf_theirs"), theirs);
        assert_eq!(payload(conn, "canvas", "mine"), mine);
        Ok(())
    })
    .expect("restamp");
}

#[test]
fn a_conversation_waiting_for_its_backfill_is_restamped_and_left_to_it() {
    let (db, _dir) = open("restamp-agent-unpaid");
    db.call_blocking(|conn| {
        let chat = conversation(conn)?;
        pushed(conn)?;
        bind(conn, SERVER)?;
        assert_eq!(restamp(conn, LOCAL, DEVICE, NOW + 1)?, 1);
        assert_eq!(
            payload(conn, "agent_conversation", &chat)["vaultId"],
            json!(SERVER)
        );
        assert_eq!(queued(conn, "agent_conversation", &chat), 0, "unpaid");
        assert_eq!(agent_queue::backfill(conn, LOCAL, NOW + 2)?, 1);
        assert_eq!(queued(conn, "agent_conversation", &chat), 1);
        Ok(())
    })
    .expect("restamp");
}

#[test]
fn a_deleted_folder_is_not_pushed_again() {
    let (db, _dir) = open("restamp-folder-deleted");
    db.call_blocking(|conn| {
        canvas_folder::upsert(conn, LOCAL, "Work", None, DEVICE, NOW)?;
        canvas_folder::delete(conn, "Work", DEVICE, NOW + 1)?;
        pushed(conn)?;
        let before: Value = payload(conn, "canvas_folder", "cvf_work");
        bind(conn, SERVER)?;
        assert_eq!(restamp(conn, LOCAL, DEVICE, NOW + 2)?, 0);
        assert_eq!(payload(conn, "canvas_folder", "cvf_work"), before);
        assert_eq!(queued(conn, "canvas_folder", "cvf_work"), 0);
        Ok(())
    })
    .expect("restamp");
}
