//! [`super::merged_vault_id`] and [`super::RecordVault::lists_every_record`] on a real `data.db`:
//! a merge keeps the bound server id over a remote stating a restamped record's pre-bind id
//! (#5784), and a bound vault lists a record of any pre-bind id, so a pull never pushes (#5812).

use rusqlite::Connection;
use serde_json::{Value, json};

use super::restamp_tests::{conversation, pushed};
use super::{bind, restamp};
use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::AtRestKey;
use crate::domain::desktop_records::testing::{
    DEVICE, NOW, clock, open, payload, pull, queued, remote,
};
use crate::domain::{agent_conversation, agent_queue, canvas, canvas_folder};

const LOCAL: &str = "local-vault";
const SERVER: &str = "server-vault";

/// #5784: a peer's title edit made before it pulled a conversation's restamp states the
/// restamper's old local id. Both sides keep the server id and push it with the title.
#[test]
fn a_restamped_conversation_keeps_the_server_id_over_a_peers_concurrent_title() {
    let (db, _dir) = open("restamp-agent-merge");
    let (chat, mut edit, restamped) = db
        .call_blocking(|conn| {
            let chat = conversation(conn)?;
            agent_queue::backfill(conn, LOCAL, NOW)?;
            let before = payload(conn, "agent_conversation", &chat);
            pushed(conn)?;
            bind(conn, SERVER)?;
            assert_eq!(restamp(conn, LOCAL, DEVICE, NOW + 1)?, 1);
            pushed(conn)?;
            let restamped = payload(conn, "agent_conversation", &chat);
            Ok((chat, before, restamped))
        })
        .expect("restamp");
    let peer_clock = json!({ DEVICE: 1, "peer-q": 1 });
    edit["title"] = json!("Peer title");
    edit["clock"] = peer_clock.clone();
    edit["fieldClocks"]["title"] = peer_clock;
    let (peer, _peer_dir) = open("restamp-agent-peer");
    for (name, side, first, then) in [
        ("restamper", &db, None, &edit),
        ("peer", &peer, Some(&edit), &restamped),
    ] {
        let (id, first, then) = (chat.clone(), first.cloned(), then.clone());
        side.call_blocking(move |conn| {
            if let Some(first) = first {
                pull(conn, vec![remote("agent_conversation", &id, &first)])?;
                bind(conn, SERVER)?;
                pushed(conn)?;
            }
            pull(conn, vec![remote("agent_conversation", &id, &then)])?;
            let after = payload(conn, "agent_conversation", &id);
            assert_eq!(after["vaultId"], json!(SERVER), "{name}");
            assert_eq!(after["title"], json!("Peer title"), "{name}");
            assert_eq!(
                queued(conn, "agent_conversation", &id),
                1,
                "{name} pushes it"
            );
            Ok(())
        })
        .expect("merge");
    }
}

/// The three types that state a vault, each with an id, written by a device whose vault id is
/// [`LOCAL`]: an Electron peer, or a Rust device before its bind. Returns the payloads it pushed.
fn written_under_local(
    conn: &Connection,
) -> Result<Vec<(&'static str, String, Value)>, StorageError> {
    canvas::create(conn, &canvas::NewCanvas::default(), LOCAL, DEVICE, NOW)?;
    let folder = canvas_folder::upsert(conn, LOCAL, "Work", None, DEVICE, NOW)?;
    let chat = conversation(conn)?;
    agent_queue::backfill(conn, LOCAL, NOW)?;
    let canvas_id = canvas::list(conn, LOCAL)?[0].id.clone();
    Ok([
        ("canvas", canvas_id),
        ("canvas_folder", folder.id),
        ("agent_conversation", chat),
    ]
    .into_iter()
    .map(|(item_type, id)| {
        let body = payload(conn, item_type, &id);
        (item_type, id, body)
    })
    .collect())
}

fn agent(error: crate::domain::agent_records::AgentError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Whether the vault whose own id is `local` lists and opens the record.
fn listed_and_opened(
    conn: &Connection,
    local: &str,
    item_type: &str,
    id: &str,
) -> Result<bool, StorageError> {
    let key = AtRestKey::default();
    Ok(match item_type {
        "canvas" => {
            canvas::list(conn, local)?.iter().any(|c| c.id == id)
                && canvas::get(conn, id)?.is_some()
        }
        "canvas_folder" => {
            let listed = canvas_folder::list(conn)?;
            listed.iter().any(|f| f.id == id)
                && listed.iter().all(|f| {
                    f.id != id || canvas_folder::get(conn, &f.path).is_ok_and(|f| f.is_some())
                })
        }
        _ => {
            agent_conversation::list(conn, &key, local)
                .map_err(agent)?
                .iter()
                .any(|c| c.id == id)
                && agent_conversation::get(conn, &key, id)
                    .map_err(agent)?
                    .is_some()
        }
    })
}

/// #5812: a fresh device bound to the server vault lists and opens what an Electron peer, or a Rust
/// device before its bind, wrote under its own vault id, stores the id as sent, and queues nothing.
#[test]
fn a_fresh_bound_device_lists_and_opens_records_of_a_pre_bind_id_and_queues_nothing() {
    let (writer, _writer_dir) = open("pre-bind-writer");
    let records = writer
        .call_blocking(|conn| written_under_local(conn))
        .expect("write");
    let (fresh, _fresh_dir) = open("pre-bind-fresh");
    fresh
        .call_blocking(move |conn| {
            bind(conn, SERVER)?;
            for (item_type, id, body) in records {
                pull(conn, vec![remote(item_type, &id, &body)])?;
                assert!(
                    listed_and_opened(conn, "fresh-local", item_type, &id)?,
                    "{item_type} lists and opens"
                );
                assert_eq!(
                    payload(conn, item_type, &id)["vaultId"],
                    json!(LOCAL),
                    "{item_type} keeps the id as sent"
                );
                assert_eq!(
                    queued(conn, item_type, &id),
                    0,
                    "{item_type} queues nothing"
                );
            }
            Ok(())
        })
        .expect("fresh device");
}

/// #5812: a peer that pulled a record before its writer's restamp, or Electron, pushes the pre-bind
/// id under a clock past the restamp. The restamped device fast-forwards, keeps the server id,
/// still lists the record, and queues nothing, so it makes no edit of its own that the peer's next
/// edit would be concurrent with: that edit fast-forwards too, with no conflict copy.
#[test]
fn a_pre_bind_remote_over_a_restamped_record_queues_nothing_and_its_next_edit_makes_no_copy() {
    let (db, _dir) = open("pre-bind-restamped");
    db.call_blocking(|conn| {
        let records = written_under_local(conn)?;
        pushed(conn)?;
        bind(conn, SERVER)?;
        assert_eq!(restamp(conn, LOCAL, DEVICE, NOW + 1)?, 3);
        pushed(conn)?;
        for (item_type, id, before) in records {
            let mut stale = before;
            stale["clock"] = json!(clock(conn, item_type, &id));
            stale["clock"]["peer-q"] = json!(1);
            if item_type == "agent_conversation" {
                stale["fieldClocks"]["title"] = stale["clock"].clone();
            }
            pull(conn, vec![remote(item_type, &id, &stale)])?;
            assert_eq!(
                payload(conn, item_type, &id)["vaultId"],
                json!(SERVER),
                "{item_type}"
            );
            assert_eq!(
                queued(conn, item_type, &id),
                0,
                "{item_type} queues nothing"
            );
            assert!(
                listed_and_opened(conn, LOCAL, item_type, &id)?,
                "{item_type} lists"
            );

            // The peer's next edit, as Electron makes it over the copy the server holds.
            let mut next = stale;
            next["clock"]["peer-q"] = json!(2);
            let (field, value) = match item_type {
                "canvas" => ("scene", json!(r#"{"elements":[{"id":"peer"}]}"#)),
                "canvas_folder" => ("icon", json!("star")),
                _ => ("title", json!("Peer title")),
            };
            next[field] = value.clone();
            if item_type == "agent_conversation" {
                next["fieldClocks"]["title"] = next["clock"].clone();
            }
            pull(conn, vec![remote(item_type, &id, &next)])?;
            assert_eq!(
                payload(conn, item_type, &id)[field],
                value,
                "{item_type} edit applies"
            );
            assert_eq!(
                queued(conn, item_type, &id),
                0,
                "{item_type} queues nothing"
            );
        }
        assert_eq!(
            canvas::list(conn, LOCAL)?.len(),
            1,
            "no conflict copy of the canvas"
        );
        Ok(())
    })
    .expect("restamped device");
}
