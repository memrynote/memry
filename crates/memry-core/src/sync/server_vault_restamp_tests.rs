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
use crate::domain::canvas::{self, CanvasEdit, NewCanvas};
use crate::domain::canvas_folder;
use crate::domain::desktop_records::testing::{
    DEVICE, NOW, clock, open, payload, pull, queued, remote,
};
use crate::storage::Db;
use crate::storage::test_support::TempDir;
use crate::sync::clock::{ClockOrder, VectorClock, compare, merge};

const LOCAL: &str = "local-vault";
const SERVER: &str = "server-vault";
/// The device that restamps in the tests where another device receives the restamp.
const RESTAMPER: &str = "device-r";

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
        // Only `vaultId` and the clock move, and the clock moves past the one it had, which the
        // restamp states as its base.
        let after = payload(conn, "canvas", "live");
        assert_eq!(after["vaultRestampBase"], before["clock"]);
        let mut unchanged = after.clone();
        unchanged["vaultId"] = before["vaultId"].clone();
        unchanged["clock"] = before["clock"].clone();
        unchanged
            .as_object_mut()
            .expect("an object")
            .remove("vaultRestampBase");
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

/// A vault that wrote `(item_type, id)` with `write` as [`RESTAMPER`] under [`LOCAL`], then bound
/// and restamped it, and the payload it pushed before the restamp.
fn restamped_peer(
    item_type: &'static str,
    id: &'static str,
    write: fn(&Connection) -> Result<(), StorageError>,
) -> (Db, TempDir, Value) {
    let (db, dir) = open("restamp-peer");
    let before = db
        .call_blocking(move |conn| {
            write(conn)?;
            let before = payload(conn, item_type, id);
            bind(conn, SERVER)?;
            assert_eq!(restamp(conn, LOCAL, RESTAMPER, NOW + 1)?, 1);
            Ok(before)
        })
        .expect("restamp");
    (db, dir, before)
}

fn canvas_written_by_restamper(conn: &Connection) -> Result<(), StorageError> {
    let new = NewCanvas {
        id: Some("c"),
        title: Some("Plan"),
        owner_note_id: None,
        scene: None,
        folder: None,
        icon: None,
    };
    canvas::create(conn, &new, LOCAL, RESTAMPER, NOW).map(drop)
}

fn scene_edit(scene: &str) -> CanvasEdit<'_> {
    CanvasEdit {
        title: None,
        folder: None,
        icon: None,
        scene: Some(scene),
        expected_updated_at: None,
    }
}

fn canvas_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM sync_items WHERE item_type = 'canvas'",
        [],
        |row| row.get(0),
    )
    .expect("count")
}

fn clock_of(payload: &Value) -> VectorClock {
    serde_json::from_value(payload["clock"].clone()).expect("a clock")
}

const PEER_INK: &str = r#"{"elements":[{"id":"peer-ink"}]}"#;

/// REVIEW-5581 low 1: a peer that drew on a canvas before it pulled the canvas's restamp keeps
/// its drawing, makes no conflict copy, and pushes it again under both clocks: the restamp
/// contests only `vaultId`.
#[test]
fn a_peers_newer_drawing_stands_over_a_restamp_it_had_not_pulled() {
    let (peer, _peer_dir, before) = restamped_peer("canvas", "c", canvas_written_by_restamper);
    let restamped = peer
        .call_blocking(|conn| Ok(payload(conn, "canvas", "c")))
        .expect("read");
    let (db, _dir) = open("restamp-receiver");
    db.call_blocking(move |conn| {
        pull(conn, vec![remote("canvas", "c", &before)])?;
        canvas::update(conn, "c", &scene_edit(PEER_INK), DEVICE, NOW + 2)?;
        pushed(conn)?;
        let edited = payload(conn, "canvas", "c");
        pull(conn, vec![remote("canvas", "c", &restamped)])?;
        let after = payload(conn, "canvas", "c");
        assert_eq!(canvas_count(conn), 1, "no conflict copy");
        assert_eq!(after["scene"], edited["scene"]);
        assert_eq!(after["vaultId"], edited["vaultId"], "vaultId stays local");
        assert_eq!(
            clock_of(&after),
            merge(&clock_of(&edited), &clock_of(&restamped))
        );
        assert_eq!(queued(conn, "canvas", "c"), 1, "pushed again");
        Ok(())
    })
    .expect("pull");
}

/// REVIEW-5581 low 1, the restamping side: a peer's drawing it had not pulled when it restamped
/// replaces its own unchanged one with no conflict copy, and the restamp's `vaultId` stays.
#[test]
fn a_restamp_takes_a_concurrent_peer_drawing_without_a_conflict_copy() {
    let (db, _dir) = open("restamp-then-pull");
    db.call_blocking(|conn| {
        new_canvas(conn, "c")?;
        pushed(conn)?;
        let mut theirs = payload(conn, "canvas", "c");
        theirs["scene"] = json!(canvas::canonical_scene(PEER_INK)?);
        theirs["title"] = json!("Their title");
        theirs["clock"] = json!({ DEVICE: 1, "peer": 1 });
        bind(conn, SERVER)?;
        assert_eq!(restamp(conn, LOCAL, DEVICE, NOW + 1)?, 1);
        pushed(conn)?;
        pull(conn, vec![remote("canvas", "c", &theirs)])?;
        let after = payload(conn, "canvas", "c");
        assert_eq!(canvas_count(conn), 1, "no conflict copy");
        assert_eq!(after["scene"], theirs["scene"]);
        assert_eq!(after["title"], json!("Their title"));
        assert_eq!(after["vaultId"], json!(SERVER));
        assert_eq!(after["clock"], json!({ DEVICE: 2, "peer": 1 }));
        assert_eq!(queued(conn, "canvas", "c"), 1);
        Ok(())
    })
    .expect("pull");
}

/// A drawing made after the restamp is a real edit: a peer's concurrent drawing still gets its
/// conflict copy, so the base in the payload only ever describes the restamp itself.
#[test]
fn an_edit_after_a_restamp_still_contests_a_concurrent_drawing() {
    let (peer, _peer_dir, before) = restamped_peer("canvas", "c", canvas_written_by_restamper);
    let edited_there = peer
        .call_blocking(|conn| {
            let ink = r#"{"elements":[{"id":"later-ink"}]}"#;
            canvas::update(conn, "c", &scene_edit(ink), RESTAMPER, NOW + 3)?;
            Ok(payload(conn, "canvas", "c"))
        })
        .expect("edit");
    assert!(
        edited_there.get("vaultRestampBase").is_some(),
        "the base rides along"
    );
    let (db, _dir) = open("restamp-edit-receiver");
    db.call_blocking(move |conn| {
        pull(conn, vec![remote("canvas", "c", &before)])?;
        canvas::update(conn, "c", &scene_edit(PEER_INK), DEVICE, NOW + 2)?;
        pull(conn, vec![remote("canvas", "c", &edited_there)])?;
        assert_eq!(canvas_count(conn), 2, "a conflict copy");
        assert_eq!(payload(conn, "canvas", "c")["scene"], edited_there["scene"]);
        Ok(())
    })
    .expect("pull");
}

/// A restamp over a base this side has not seen all of carries a drawing this side lacks: both
/// drawings are kept, as for any concurrent edit.
#[test]
fn a_restamp_over_an_edit_this_side_never_saw_keeps_both_drawings() {
    let (peer, _peer_dir, before) = restamped_peer("canvas", "c", canvas_written_by_restamper);
    let mut restamped = peer
        .call_blocking(|conn| Ok(payload(conn, "canvas", "c")))
        .expect("read");
    // The restamper had pulled a third device's ink before it restamped.
    restamped["scene"] = json!(r#"{"elements":[{"id":"third-ink"}]}"#);
    restamped["vaultRestampBase"] = json!({ RESTAMPER: 1, "third": 1 });
    restamped["clock"] = json!({ RESTAMPER: 2, "third": 1 });
    let (db, _dir) = open("restamp-unseen-base");
    db.call_blocking(move |conn| {
        pull(conn, vec![remote("canvas", "c", &before)])?;
        canvas::update(conn, "c", &scene_edit(PEER_INK), DEVICE, NOW + 2)?;
        pull(conn, vec![remote("canvas", "c", &restamped)])?;
        assert_eq!(canvas_count(conn), 2, "a conflict copy");
        assert_eq!(payload(conn, "canvas", "c")["scene"], restamped["scene"]);
        Ok(())
    })
    .expect("pull");
}

/// REVIEW-5581 low 1, folders: a peer's icon set before it pulled the folder's restamp stays, and
/// a restamp desktop's schema refuses is refused first.
#[test]
fn a_peers_newer_folder_icon_stands_over_a_restamp_it_had_not_pulled() {
    let (peer, _peer_dir, before) = restamped_peer("canvas_folder", "cvf_work", |conn| {
        canvas_folder::upsert(conn, LOCAL, "Work", None, RESTAMPER, NOW).map(drop)
    });
    let restamped = peer
        .call_blocking(|conn| Ok(payload(conn, "canvas_folder", "cvf_work")))
        .expect("read");
    let (db, _dir) = open("restamp-folder-receiver");
    db.call_blocking(move |conn| {
        pull(conn, vec![remote("canvas_folder", "cvf_work", &before)])?;
        canvas_folder::upsert(conn, LOCAL, "Work", Some(Some("star")), DEVICE, NOW + 2)?;
        pushed(conn)?;
        let edited = payload(conn, "canvas_folder", "cvf_work");
        let mut refused = restamped.clone();
        refused["path"] = Value::Null;
        pull(conn, vec![remote("canvas_folder", "cvf_work", &refused)])?;
        assert_eq!(
            payload(conn, "canvas_folder", "cvf_work"),
            edited,
            "refused"
        );
        assert_eq!(queued(conn, "canvas_folder", "cvf_work"), 0);
        pull(conn, vec![remote("canvas_folder", "cvf_work", &restamped)])?;
        let after = payload(conn, "canvas_folder", "cvf_work");
        assert_eq!(after["icon"], json!("star"));
        assert_eq!(after["path"], edited["path"]);
        assert_eq!(after["vaultId"], edited["vaultId"], "vaultId stays local");
        assert_eq!(
            clock_of(&after),
            merge(&clock_of(&edited), &clock_of(&restamped))
        );
        assert_eq!(queued(conn, "canvas_folder", "cvf_work"), 1, "pushed again");
        Ok(())
    })
    .expect("pull");
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
