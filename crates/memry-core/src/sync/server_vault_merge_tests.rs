//! [`super::merged_vault_id`] and [`super::repush_kept`] on a real `data.db`: a merge keeps the
//! bound server id over a remote stating a restamped record's pre-bind id (#5784), and a
//! fast-forward pushes it once, so the server copy reaches a fresh device (#5812).

use serde_json::{Value, json};

use super::restamp_tests::{conversation, pushed};
use super::{bind, restamp};
use crate::crypto::agent_envelope::AtRestKey;
use crate::domain::desktop_records::testing::{
    DEVICE, NOW, clock, open, payload, pull, queued, remote,
};
use crate::domain::{agent_conversation, agent_queue, canvas, canvas_folder};
use crate::sync::clock::{ClockOrder, compare};

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

/// #5812: a build before #5784, or Electron, pushes the pre-bind id under a clock past the
/// restamp. The fast-forward keeps the server id and pushes it once under this device's next
/// tick; its echo queues nothing, and a fresh device bound to the server id lists the record.
#[test]
fn a_fast_forward_over_a_pre_bind_id_pushes_the_server_id_once() {
    let (db, _dir) = open("repush-kept");
    let ids = db
        .call_blocking(|conn| {
            canvas::create(conn, &canvas::NewCanvas::default(), LOCAL, DEVICE, NOW)?;
            let folder = canvas_folder::upsert(conn, LOCAL, "Work", None, DEVICE, NOW)?;
            let chat = conversation(conn)?;
            agent_queue::backfill(conn, LOCAL, NOW)?;
            let canvas_id = canvas::list(conn, LOCAL)?[0].id.clone();
            let ids = [
                ("canvas", canvas_id),
                ("canvas_folder", folder.id),
                ("agent_conversation", chat),
            ];
            let before: Vec<Value> = ids
                .iter()
                .map(|(item_type, id)| payload(conn, item_type, id))
                .collect();
            pushed(conn)?;
            bind(conn, SERVER)?;
            assert_eq!(restamp(conn, LOCAL, DEVICE, NOW + 1)?, 3);
            pushed(conn)?;
            Ok(ids.into_iter().zip(before).collect::<Vec<_>>())
        })
        .expect("restamp");
    let (fresh, _fresh_dir) = open("repush-kept-fresh");
    fresh
        .call_blocking(|conn| bind(conn, SERVER))
        .expect("bind");
    for ((item_type, id), before) in ids {
        let (id, server, pushes, echo) = db
            .call_blocking(move |conn| {
                let mut stale = before;
                stale["clock"] = json!(clock(conn, item_type, &id));
                stale["clock"]["peer-q"] = json!(1);
                if item_type == "agent_conversation" {
                    stale["fieldClocks"]["title"] = stale["clock"].clone();
                }
                pull(conn, vec![remote(item_type, &id, &stale)])?;
                let after = payload(conn, item_type, &id);
                assert_eq!(after["vaultId"], json!(SERVER), "{item_type}");
                let pushes = queued(conn, item_type, &id);
                let stale_clock = serde_json::from_value(stale["clock"].clone()).expect("clock");
                let order = compare(&clock(conn, item_type, &id), &stale_clock);
                // The server stores a push only under a clock past the one it holds.
                let server = if pushes > 0 && order == ClockOrder::After {
                    after
                } else {
                    stale
                };
                pushed(conn)?;
                // The echo, as a peer's later edit over it states it: the server id.
                let mut echo = server.clone();
                echo["clock"]["peer-q"] = json!(2);
                pull(conn, vec![remote(item_type, &id, &echo)])?;
                let echoed = queued(conn, item_type, &id);
                Ok((id, server, pushes, echoed))
            })
            .expect("fast-forward");
        let body = server.clone();
        let listed = fresh
            .call_blocking(move |conn| {
                pull(conn, vec![remote(item_type, &id, &body)])?;
                Ok(match item_type {
                    "canvas" => canvas::list(conn, "fresh-local")?
                        .iter()
                        .any(|c| c.id == id),
                    "agent_conversation" => {
                        agent_conversation::list(conn, &AtRestKey::default(), "fresh-local")
                            .map_err(|error| crate::api::errors::StorageError::Failed {
                                what: error.to_string(),
                            })?
                            .iter()
                            .any(|c| c.id == id)
                    }
                    // Folders list unfiltered here; Electron's filter on `vaultId` hides them.
                    _ => body["vaultId"] == json!(SERVER),
                })
            })
            .expect("fresh device");
        assert!(listed, "a fresh device lists the {item_type}");
        assert_eq!(
            pushes, 1,
            "{item_type} pushes it once, past the remote's clock"
        );
        assert_eq!(echo, 0, "{item_type} echo queues nothing");
    }
}
