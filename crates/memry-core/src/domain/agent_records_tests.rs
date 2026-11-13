//! [`seal_pending`] on a real `data.db` (Step 16, #3533): the work it skips
//! and the connection state it hands back.

use std::time::Duration;

use serde_json::json;
use zeroize::Zeroizing;

use super::*;
use crate::domain::desktop_records::testing::{DEVICE, NOW, open, remote};
use crate::sync::apply::apply_page;

fn key() -> AtRestKey {
    let key = AtRestKey::default();
    key.set(Some(Zeroizing::new([4; 32])));
    key
}

fn storage(error: AgentError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Another connection holds the write lock and this one does not wait for
/// it: a pass that began a write transaction would fail with `SQLITE_BUSY`.
#[test]
fn sealing_with_nothing_pending_or_held_opens_no_write_transaction() {
    let (db, dir) = open("agent-seal-nothing");
    let writer = Connection::open(dir.path().join("data.db")).expect("a second connection");
    writer
        .execute_batch("BEGIN IMMEDIATE")
        .expect("the write lock");
    db.call_blocking(|conn| {
        conn.busy_timeout(Duration::ZERO).map_err(failed)?;
        assert_eq!(
            seal_pending(conn, &key(), NOW).map_err(storage)?,
            Sealed::default()
        );
        Ok(())
    })
    .expect("nothing to write");
    writer.execute_batch("ROLLBACK").expect("release");
}

#[test]
fn sealing_hands_back_a_fast_secure_delete_as_it_found_it() {
    let (db, _dir) = open("agent-seal-fast");
    db.call_blocking(|conn| {
        let message = json!({
            "conversationId": "c1", "role": "user", "content": {"text": "plan"},
            "attachments": [], "toolCallId": null, "status": "completed",
            "clock": {"peer": 1}, "createdAt": NOW, "updatedAt": NOW,
        });
        let pulled = remote("agent_message", "m1", &message);
        apply_page(
            conn,
            vec![pulled],
            vec![],
            NOW,
            Some(DEVICE),
            &AtRestKey::default(),
        )?;
        conn.execute_batch("PRAGMA secure_delete = FAST")
            .map_err(failed)?;
        assert_eq!(seal_pending(conn, &key(), NOW).map_err(storage)?.records, 1);
        let mode: i64 = conn
            .query_row("PRAGMA secure_delete", [], |row| row.get(0))
            .map_err(failed)?;
        assert_eq!(mode, 2, "FAST, not ON");
        Ok(())
    })
    .expect("fast");
}

/// A pending conversation whose title changes once a key is installed stores
/// the new title sealed and is no longer pending, so a later pass does not
/// seal it a second time.
#[test]
fn a_title_written_over_a_pending_record_is_sealed_once() {
    use crate::domain::agent_conversation::{ConversationPatch, get, update_fields};

    let (db, _dir) = open("agent-seal-pending-edit");
    db.call_blocking(|conn| {
        let conversation = json!({
            "vaultId": "vault-1", "title": "Pulled", "backend": "local",
            "backendModel": null, "trustList": [], "pinned": false,
            "clock": {"peer": 1}, "fieldClocks": {}, "createdAt": NOW, "updatedAt": NOW,
            "deletedAt": null,
        });
        let pulled = remote("agent_conversation", "c1", &conversation);
        apply_page(
            conn,
            vec![pulled],
            vec![],
            NOW,
            Some(DEVICE),
            &AtRestKey::default(),
        )?;
        let key = key();
        let patch = ConversationPatch {
            title: Some("Renamed"),
            ..ConversationPatch::default()
        };
        update_fields(conn, &key, "c1", &patch, DEVICE, NOW + 1).map_err(storage)?;
        assert_eq!(
            seal_pending(conn, &key, NOW + 2).map_err(storage)?.records,
            0
        );
        let read = get(conn, &key, "c1").map_err(storage)?.expect("live");
        assert_eq!(read.title, "Renamed");
        Ok(())
    })
    .expect("edit");
}

/// A local title sealed under another key refuses every remote of its id,
/// concurrent or dominating: the pull records it corrupt and the local
/// record stays byte for byte.
#[test]
fn a_local_title_under_another_key_makes_the_merge_corrupt() {
    use crate::domain::agent_conversation::{NewConversation, create};

    let (db, _dir) = open("agent-merge-foreign");
    db.call_blocking(|conn| {
        let earlier = AtRestKey::default();
        earlier.set(Some(Zeroizing::new([8; 32])));
        let new = NewConversation {
            vault_id: "vault-1",
            title: "Plan",
            backend: "local",
            backend_model: None,
        };
        let id = create(conn, &earlier, &new, DEVICE, NOW)
            .map_err(storage)?
            .id;
        let stored = || sync_items::push_payload(conn, "agent_conversation", &id);
        let before = stored()?;
        for clock in [json!({"peer": 1}), json!({DEVICE: 5})] {
            let body = json!({
                "vaultId": "vault-1", "title": "Peer", "backend": "local",
                "backendModel": null, "trustList": [], "pinned": true,
                "clock": clock, "fieldClocks": {}, "createdAt": NOW, "updatedAt": NOW + 1,
                "deletedAt": null,
            });
            let pulled = remote("agent_conversation", &id, &body);
            let totals = apply_page(conn, vec![pulled], vec![], NOW, Some(DEVICE), &key())?;
            assert_eq!(totals.corrupt, 1, "{clock}");
            assert_eq!(stored()?, before, "{clock}");
        }
        Ok(())
    })
    .expect("merge");
}

/// A pending conversation (pulled with no key) meets a concurrent remote with
/// no title that wins the title field: the merge leaves the plain local title
/// as stored, so the record stays pending and installing the key seals it.
#[test]
fn a_merge_that_keeps_a_pending_title_stays_pending() {
    use crate::domain::agent_conversation::get;

    let (db, _dir) = open("agent-merge-no-title");
    db.call_blocking(|conn| {
        let none = AtRestKey::default();
        let conversation = json!({
            "vaultId": "vault-1", "title": "Pulled", "backend": "local",
            "backendModel": null, "trustList": [], "pinned": false,
            "clock": {"peer": 1}, "fieldClocks": {}, "createdAt": NOW, "updatedAt": NOW,
            "deletedAt": null,
        });
        let pulled = remote("agent_conversation", "c1", &conversation);
        apply_page(conn, vec![pulled], vec![], NOW, Some(DEVICE), &none)?;
        let body = json!({
            "vaultId": "vault-1", "backend": "local", "backendModel": null,
            "trustList": [], "pinned": true, "clock": {"other": 1},
            "fieldClocks": {"title": {"other": 5}, "pinned": {"other": 5}},
            "createdAt": NOW, "updatedAt": NOW + 1, "deletedAt": null,
        });
        let concurrent = remote("agent_conversation", "c1", &body);
        let totals = apply_page(conn, vec![concurrent], vec![], NOW, Some(DEVICE), &none)?;
        assert_eq!(totals.corrupt, 0);
        assert!(is_sealed_pending(conn, "agent_conversation", "c1")?);

        let key = key();
        assert_eq!(
            seal_pending(conn, &key, NOW + 2).map_err(storage)?.records,
            1
        );
        let read = get(conn, &key, "c1").map_err(storage)?.expect("live");
        assert_eq!((read.title.as_str(), read.pinned), ("Pulled", true));
        Ok(())
    })
    .expect("merge");
}

/// A pending conversation a later pull flagged corrupt still holds its title
/// plain: installing the key seals it and clears the flag.
#[test]
fn a_pending_record_flagged_corrupt_is_sealed() {
    let (db, _dir) = open("agent-seal-corrupt");
    db.call_blocking(|conn| {
        let conversation = json!({
            "vaultId": "vault-1", "title": "PLAIN-TITLE", "backend": "local",
            "backendModel": null, "trustList": [], "pinned": false,
            "clock": {"peer": 1}, "fieldClocks": {}, "createdAt": NOW, "updatedAt": NOW,
            "deletedAt": null,
        });
        let none = AtRestKey::default();
        let pulled = remote("agent_conversation", "c1", &conversation);
        apply_page(conn, vec![pulled], vec![], NOW, Some(DEVICE), &none)?;
        let broken = remote("agent_conversation", "c1", &json!([1]));
        let totals = apply_page(conn, vec![broken], vec![], NOW, Some(DEVICE), &none)?;
        assert_eq!(totals.corrupt, 1);

        assert_eq!(
            seal_pending(conn, &key(), NOW + 2)
                .map_err(storage)?
                .records,
            1
        );
        let row = sync_items::load(conn, "agent_conversation", "c1")?.expect("row");
        assert!(!row.payload.expect("payload").contains("PLAIN-TITLE"));
        assert_eq!(row.corrupt_reason, None);
        assert!(!is_sealed_pending(conn, "agent_conversation", "c1")?);
        Ok(())
    })
    .expect("seal");
}
