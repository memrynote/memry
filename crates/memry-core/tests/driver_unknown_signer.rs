//! A pulled delete whose signer is not in the driver's device directory
//! (chapter 01 §1.4.0, #5427; main's #5413), on `driver_fakes`'s server.
//!
//! The refusal is kept in `meta`, so a local edit and a restart do not lose
//! it; the row's queued edit is held until the delete verifies or the re-pull
//! gives up; a verified delete ends the re-pulls.

use memry_core::api::errors::StorageError;
use memry_core::protocol::account::UNKNOWN_SIGNER;
use memry_core::protocol::types::Declaration;
use memry_core::storage::Db;
use memry_core::storage::repositories::{Change as FieldChange, sync_items};
use memry_core::sync::outbox::{self, Change};
use serde_json::json;

use crate::driver_fakes::Desktop;

/// A device that registers after the driver fetched its directory.
const GHOST: &str = "server-device-9";
const GHOST_SEED: u8 = 29;
/// A clockless type: the server takes any edit of it over a delete, so an
/// edit sent before the delete verifies brings the item back everywhere.
const ITEM_TYPE: &str = "settings";
const ID: &str = "editor";

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// A driver holding settings [`ID`] live, whose delete by [`GHOST`] the last pass
/// refused: the directory did not list the signer.
async fn refused_delete() -> Desktop {
    let desktop = Desktop::open_with(Declaration::desktop(), |_| Ok(())).await;
    desktop.server.put(
        ITEM_TYPE,
        ID,
        json!({"settings": {"fontSize": 14}, "fieldClocks": {}}),
    );
    desktop.server.page(&[ID], "1");
    desktop.pass().await;
    assert!(!deleted(&desktop.db), "pulled live");

    desktop.server.delete_by(ITEM_TYPE, ID, GHOST, GHOST_SEED);
    desktop.server.page(&[ID], "2");
    desktop.pass().await;
    assert!(!deleted(&desktop.db), "unverified: kept");
    desktop
}

/// A local edit of [`ID`], queued with its outbox row.
fn edit(db: &Db) {
    db.call_blocking(|conn| {
        outbox::commit(conn, &Change::upsert(ITEM_TYPE, ID), 2, |tx| {
            sync_items::apply_local_edit_in(
                tx,
                ITEM_TYPE,
                ID,
                &[("settings", FieldChange::Set(json!({"fontSize": 15})))],
                2,
            )
        })
        .map(drop)
    })
    .expect("a local edit");
}

fn deleted(db: &Db) -> bool {
    db.call_blocking(|conn| sync_items::load(conn, ITEM_TYPE, ID))
        .expect("read")
        .expect("the row")
        .deleted_at
        .is_some()
}

/// Ends any push backoff, so the next pass sends every queued row it may.
fn push_due(db: &Db) {
    db.call_blocking(|conn| {
        conn.execute("UPDATE outbox SET next_attempt_at = NULL", [])
            .map(drop)
            .map_err(failed)
    })
    .expect("due");
}

/// How many `POST /sync/pull` asked for [`ID`].
fn pulls_of_item(desktop: &Desktop) -> usize {
    desktop
        .server
        .pulled_ids()
        .iter()
        .filter(|ids| ids.as_array().is_some_and(|ids| ids.contains(&json!(ID))))
        .count()
}

/// The operations of every pushed [`ID`] record.
fn pushed_item(desktop: &Desktop) -> Vec<String> {
    desktop
        .server
        .pushed()
        .into_iter()
        .filter(|(_, id, _)| id == ID)
        .map(|(_, _, operation)| operation)
        .collect()
}

#[tokio::test]
async fn a_refusal_survives_a_local_edit_and_a_restart_and_holds_the_edit() {
    let desktop = refused_delete().await;
    edit(&desktop.db);

    // The app restarts while the signer is still unlisted: the edit waits.
    let desktop = desktop.reopen(Declaration::desktop()).await;
    push_due(&desktop.db);
    desktop.pass().await;
    assert!(!deleted(&desktop.db));
    assert_eq!(pushed_item(&desktop), Vec::<String>::new(), "held");

    // The signer registers: the next pass refetches the directory and
    // re-pulls the delete, which applies.
    desktop.server.add_device(GHOST, GHOST_SEED);
    desktop.pass().await;
    assert!(deleted(&desktop.db), "the refused delete applied");

    // The queued edit went with the row: nothing that would bring the item
    // back is pushed, now or later.
    push_due(&desktop.db);
    desktop.pass().await;
    assert!(deleted(&desktop.db));
    let pushed = pushed_item(&desktop);
    assert!(pushed.iter().all(|op| op == "delete"), "{pushed:?}");
    let queued = desktop
        .db
        .call_blocking(|conn| outbox::depth(conn))
        .expect("the outbox");
    assert_eq!(queued, 0, "the edit is retired, not deferred");
}

#[tokio::test]
async fn a_refused_delete_re_pulled_at_open_applies_and_is_not_re_pulled_again() {
    let desktop = refused_delete().await;
    edit(&desktop.db);
    desktop.server.add_device(GHOST, GHOST_SEED);

    let desktop = desktop.reopen(Declaration::desktop()).await;
    assert!(deleted(&desktop.db), "re-pulled at open and applied");
    let row = desktop
        .db
        .call_blocking(|conn| sync_items::load(conn, ITEM_TYPE, ID))
        .expect("read")
        .expect("the row");
    assert_eq!(
        row.corrupt_reason, None,
        "a verified delete clears the flag"
    );

    let pulls = pulls_of_item(&desktop);
    let desktop = desktop.reopen(Declaration::desktop()).await;
    desktop.pass().await;
    assert_eq!(pulls_of_item(&desktop), pulls, "settled: never re-pulled");
}

/// A row an older build left corrupt for an unknown signer, whose verified
/// delete then applies, is re-pulled once and never on a later open.
#[tokio::test]
async fn a_verified_delete_of_a_legacy_refusal_ends_its_re_pulls() {
    let desktop = Desktop::open_with(Declaration::desktop(), |conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, clock, \
             updated_at, corrupt_reason, corrupt_at) \
             VALUES (?2, ?3, NULL, 'full', '{}', 1, ?1, 1)",
            rusqlite::params![
                format!("signer device `{GHOST}`{UNKNOWN_SIGNER}"),
                ITEM_TYPE,
                ID
            ],
        )
        .map(drop)
        .map_err(failed)
    })
    .await;
    desktop.server.delete(ITEM_TYPE, ID);

    let desktop = desktop.reopen(Declaration::desktop()).await;
    assert!(deleted(&desktop.db));
    let pulls = pulls_of_item(&desktop);
    let desktop = desktop.reopen(Declaration::desktop()).await;
    assert_eq!(pulls_of_item(&desktop), pulls);
}

#[tokio::test]
async fn a_signer_that_never_registers_is_re_pulled_a_bounded_number_of_times() {
    let mut desktop = refused_delete().await;
    let before = pulls_of_item(&desktop);

    for _ in 0..8 {
        desktop = desktop.reopen(Declaration::desktop()).await;
        desktop.pass().await;
    }

    assert_eq!(pulls_of_item(&desktop) - before, 5, "MAX_RETRIES re-pulls");
    assert!(!deleted(&desktop.db), "never verified: kept");

    // Given up: the hold ends and a later edit is sent.
    edit(&desktop.db);
    desktop.pass().await;
    assert_eq!(pushed_item(&desktop), vec!["update".to_owned()]);
}

/// An edit queued against a row a verified delete already removed is never
/// sent: sealed from the deleted row it is an `update` carrying `deletedAt`,
/// which the server applies as a write.
#[tokio::test]
async fn an_edit_queued_after_the_delete_applied_is_not_pushed() {
    let desktop = Desktop::open_with(Declaration::desktop(), |_| Ok(())).await;
    desktop.server.put(
        ITEM_TYPE,
        ID,
        json!({"settings": {"fontSize": 14}, "fieldClocks": {}}),
    );
    desktop.server.page(&[ID], "1");
    desktop.pass().await;
    desktop.server.delete(ITEM_TYPE, ID);
    desktop.server.page(&[ID], "2");
    desktop.pass().await;
    assert!(deleted(&desktop.db));

    desktop
        .db
        .call_blocking(|conn| {
            outbox::commit(conn, &Change::upsert(ITEM_TYPE, ID), 3, |_| Ok(())).map(drop)
        })
        .expect("a queued edit");
    desktop.pass().await;

    assert_eq!(pushed_item(&desktop), Vec::<String>::new());
    assert!(deleted(&desktop.db));
}

/// A directory refetch that fails other than in transport counts one attempt per waiting id,
/// like a failed re-pull: the hold ages out instead of keeping the edit
/// queued for as long as the directory is down.
#[tokio::test]
async fn a_failed_refetch_counts_against_the_budget() {
    let desktop = refused_delete().await;
    desktop.server.devices_garbled(true);
    for _ in 0..5 {
        desktop.pass().await;
    }

    edit(&desktop.db);
    push_due(&desktop.db);
    desktop.pass().await;
    assert!(!deleted(&desktop.db), "never verified: kept");
    assert_eq!(pushed_item(&desktop), vec!["update".to_owned()]);
}
