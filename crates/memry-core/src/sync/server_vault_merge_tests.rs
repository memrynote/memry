//! [`super::merged_vault_id`] on a real `data.db`: an `agent_conversation` merge keeps the bound
//! server id over a remote stating a restamped conversation's pre-bind id (#5784).

use serde_json::json;

use super::restamp_tests::{conversation, pushed};
use super::{bind, restamp};
use crate::domain::agent_queue;
use crate::domain::desktop_records::testing::{DEVICE, NOW, open, payload, pull, queued, remote};

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
    // A build before #5784 pushed the pre-bind id under a clock past the restamp.
    let mut stale = edit;
    stale["clock"] = json!({ DEVICE: 2, "peer-q": 2 });
    stale["fieldClocks"]["title"] = stale["clock"].clone();
    db.call_blocking(move |conn| {
        pull(conn, vec![remote("agent_conversation", &chat, &stale)])?;
        let after = payload(conn, "agent_conversation", &chat);
        assert_eq!(after["vaultId"], json!(SERVER), "a dominating remote");
        Ok(())
    })
    .expect("fast-forward");
}
