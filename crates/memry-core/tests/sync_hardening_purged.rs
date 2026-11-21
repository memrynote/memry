//! Purged tombstones through the desktop driver (Step 17 L3b-2, #3534;
//! `sync::hardening::purged`, chapter 05 §5.12.3), ported from Electron's
//! `engine/purged-tombstones.test.ts`.
//!
//! Real `SyncDriver`, `DirectoryCipher`, attestation signatures, SQLite and
//! apply, on `driver_fakes`'s server. A marker is served in `purgedTombstones`
//! of `POST /sync/pull` for an id the page lists in `deleted`.

use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::crypto::sodium;
use memry_core::protocol::delete_attestation::{claim_of, sign};
use memry_core::protocol::envelope::SyncOperation;
use memry_core::protocol::types::Declaration;
use memry_core::sync::clock::VectorClock;
use memry_core::sync::driver::progress::SilentInitialSync;
use memry_core::sync::engine::MAX_PAGES_PER_PASS;
use memry_core::sync::state::PassTrigger;
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use rusqlite::Connection;
use serde_json::{Value as Json, json};

use crate::driver_fakes::{Desktop, PEER, PEER_SEED};

/// Milliseconds, as this core pushes `deletedAt`.
const DELETED_AT: i64 = 1_760_000_000_000;
const NEW_DEVICE: &str = "server-device-3";
const NEW_SEED: u8 = 13;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// A live `sync_items` row, as an earlier pull left it; `clock` `None` is a
/// row with no clock.
fn hold(
    conn: &Connection,
    item_type: &str,
    id: &str,
    clock: Option<Json>,
    stored_at: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO sync_items (item_type, item_id, payload, payload_state, clock, updated_at)
         VALUES (?1, ?2, '{}', 'full', ?3, ?4)",
        rusqlite::params![
            item_type,
            id,
            clock.map(|clock| clock.to_string()),
            stored_at
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// The feed state of a desktop that already pulled to cursor 1 under its
/// declaration: the next run is not from cursor 0.
fn pulled_to_one(conn: &Connection) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('sync.record_declaration', ?1),
                                              ('sync.cursor_skip_repair', 'done')",
        [Declaration::desktop().header_value()],
    )
    .map_err(failed)?;
    store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some("1"), 1)
}

/// A desktop holding the peer's task `t1` at clock `{peer: 1}`.
async fn holding_a_task() -> Desktop {
    Desktop::open_with(Declaration::desktop(), |conn| {
        pulled_to_one(conn)?;
        hold(conn, "task", "t1", Some(json!({ PEER: 1 })), 1_000)
    })
    .await
}

/// A marker entry, attested by `signer` (its id and key seed) when given.
fn marker(
    item_type: &str,
    id: &str,
    clock: Json,
    deleted_at: i64,
    signer: Option<(&str, u8)>,
) -> Json {
    let mut entry = json!({
        "id": id, "type": item_type, "deletedAt": deleted_at, "clock": clock,
        "serverCursor": 2,
    });
    if let Some((device, seed)) = signer {
        let clock: VectorClock = serde_json::from_value(clock).expect("a clock");
        let claim = claim_of(
            item_type,
            id,
            SyncOperation::Delete,
            Some(&clock),
            Some(deleted_at),
        )
        .expect("an attestable delete");
        let (_, secret) = sodium::sign_seed_keypair(&[seed; 32]).expect("a keypair");
        entry["signerDeviceId"] = json!(device);
        entry["deleteAttestation"] = json!(sign(&claim, &secret).expect("signed"));
    }
    entry
}

fn peer_marker(item_type: &str, id: &str) -> Json {
    marker(
        item_type,
        id,
        json!({ PEER: 2 }),
        DELETED_AT,
        Some((PEER, PEER_SEED)),
    )
}

/// Serves `entry` for its id on the next feed page, ending at cursor 2.
fn serve(desktop: &Desktop, entry: Json) {
    let id = entry["id"].as_str().unwrap().to_owned();
    desktop.server.purge(entry);
    desktop.server.deleted_page(&[&id], "2", false);
}

fn deleted_at(desktop: &Desktop, item_type: &'static str, id: &str) -> Option<i64> {
    let id = id.to_owned();
    desktop
        .db
        .call_blocking(move |conn| {
            conn.query_row(
                "SELECT deleted_at FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                [item_type, id.as_str()],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .expect("the row")
}

fn cursor(desktop: &Desktop) -> Option<String> {
    desktop
        .db
        .call_blocking(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
        .expect("the cursor")
}

#[tokio::test]
async fn an_attested_marker_deletes_the_item_and_every_request_declares_the_token() {
    let desktop = holding_a_task().await;
    serve(&desktop, peer_marker("task", "t1"));

    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), Some(DELETED_AT));
    assert_eq!(cursor(&desktop).as_deref(), Some("2"));
    let declared = Declaration::desktop();
    assert!(
        desktop
            .server
            .sync_types("/sync/pull")
            .iter()
            .all(|header| *header == declared.header_value())
    );
    assert!(
        desktop
            .server
            .sync_types("/sync/changes")
            .iter()
            .all(|header| *header == declared.header_value_with(Some("note_body")))
    );
}

#[tokio::test]
async fn a_marker_without_an_attestation_is_never_applied_untyped() {
    let desktop = holding_a_task().await;
    serve(
        &desktop,
        marker("task", "t1", json!({ PEER: 2 }), DELETED_AT, None),
    );

    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), None);
    assert_eq!(cursor(&desktop).as_deref(), Some("2"));
}

#[tokio::test]
async fn an_attestation_over_another_claim_is_refused() {
    let desktop = holding_a_task().await;
    let mut entry = peer_marker("task", "t1");
    entry["deletedAt"] = json!(DELETED_AT + 1);
    serve(&desktop, entry);

    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), None);
}

#[tokio::test]
async fn a_signer_registered_since_the_driver_opened_is_fetched_once() {
    let desktop = holding_a_task().await;
    desktop.server.add_device(NEW_DEVICE, NEW_SEED);
    let lookups = desktop.server.count("/auth/devices");
    serve(
        &desktop,
        marker(
            "task",
            "t1",
            json!({ NEW_DEVICE: 1 }),
            DELETED_AT,
            Some((NEW_DEVICE, NEW_SEED)),
        ),
    );

    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), Some(DELETED_AT));
    assert_eq!(desktop.server.count("/auth/devices"), lookups + 1);
}

#[tokio::test]
async fn a_signer_no_completed_lookup_names_is_refused_and_the_cursor_moves() {
    let desktop = holding_a_task().await;
    serve(
        &desktop,
        marker(
            "task",
            "t1",
            json!({ PEER: 2 }),
            DELETED_AT,
            Some(("ghost", 14)),
        ),
    );

    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), None);
    assert_eq!(cursor(&desktop).as_deref(), Some("2"));
}

#[tokio::test]
async fn a_signer_lookup_that_fails_holds_the_cursor_until_it_completes() {
    let desktop = holding_a_task().await;
    let entry = marker(
        "task",
        "t1",
        json!({ NEW_DEVICE: 1 }),
        DELETED_AT,
        Some((NEW_DEVICE, NEW_SEED)),
    );
    serve(&desktop, entry);
    desktop.server.deleted_page(&["t1"], "2", false);
    desktop.server.devices_down(true);

    let failed = desktop
        .driver
        .run_pass(PassTrigger::Timer)
        .await
        .expect("not paused");

    assert!(failed.error().is_some());
    assert_eq!(deleted_at(&desktop, "task", "t1"), None);
    assert_eq!(cursor(&desktop).as_deref(), Some("1"));

    desktop.server.devices_down(false);
    desktop.server.add_device(NEW_DEVICE, NEW_SEED);
    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), Some(DELETED_AT));
    assert_eq!(cursor(&desktop).as_deref(), Some("2"));
}

#[tokio::test]
async fn a_local_clock_after_the_marker_keeps_the_item() {
    let desktop = Desktop::open_with(Declaration::desktop(), |conn| {
        pulled_to_one(conn)?;
        hold(conn, "task", "t1", Some(json!({ PEER: 3 })), 1_000)
    })
    .await;
    serve(&desktop, peer_marker("task", "t1"));

    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), None);
}

/// Electron's `localTombstoneRefusal`, one desktop per case: what the local
/// row says decides, and the last case shows the rules let a stale copy go.
#[tokio::test]
async fn the_local_row_refuses_what_would_lose_its_data() {
    struct Case {
        what: &'static str,
        item_type: &'static str,
        clock: Option<Json>,
        stored_at: i64,
        queued: Option<&'static str>,
        entry_clock: Json,
        deleted_at: i64,
        kept: bool,
    }
    let peer = |tick: u64| json!({ PEER: tick });
    let cases = [
        Case {
            what: "a row with no clock",
            item_type: "task",
            clock: None,
            stored_at: 1_000,
            queued: None,
            entry_clock: peer(2),
            deleted_at: DELETED_AT,
            kept: true,
        },
        Case {
            what: "a clock naming a device nobody knows",
            item_type: "task",
            clock: Some(peer(1)),
            stored_at: 1_000,
            queued: None,
            entry_clock: json!({ "stranger": 4 }),
            deleted_at: DELETED_AT,
            kept: true,
        },
        Case {
            what: "a recreatable item with a queued update",
            item_type: "journal",
            clock: Some(peer(1)),
            stored_at: 1_000,
            queued: Some("upsert"),
            entry_clock: peer(2),
            deleted_at: DELETED_AT,
            kept: true,
        },
        Case {
            what: "a recreatable item stored after the delete, in seconds",
            item_type: "journal",
            clock: Some(peer(1)),
            stored_at: (DELETED_AT / 1_000 + 1) * 1_000,
            queued: None,
            entry_clock: peer(2),
            deleted_at: DELETED_AT / 1_000,
            kept: true,
        },
        Case {
            what: "a recreatable item with only a queued delete, stored a day before",
            item_type: "journal",
            clock: Some(peer(1)),
            stored_at: DELETED_AT - 86_400_000,
            queued: Some("delete"),
            entry_clock: peer(2),
            deleted_at: DELETED_AT / 1_000,
            kept: false,
        },
    ];
    for case in cases {
        let (item_type, clock, stored_at, queued) = (
            case.item_type,
            case.clock.clone(),
            case.stored_at,
            case.queued,
        );
        let desktop = Desktop::open_with(Declaration::desktop(), move |conn| {
            pulled_to_one(conn)?;
            hold(conn, item_type, "x1", clock, stored_at)?;
            if let Some(op) = queued {
                conn.execute(
                    "INSERT INTO outbox (item_type, item_id, op, enqueued_at)
                     VALUES (?1, 'x1', ?2, 1)",
                    [item_type, op],
                )
                .map_err(failed)?;
            }
            Ok(())
        })
        .await;
        serve(
            &desktop,
            marker(
                case.item_type,
                "x1",
                case.entry_clock,
                case.deleted_at,
                Some((PEER, PEER_SEED)),
            ),
        );

        let _ = desktop.driver.run_pass(PassTrigger::Timer).await;

        let deleted = deleted_at(&desktop, case.item_type, "x1");
        assert_eq!(deleted.is_none(), case.kept, "{}", case.what);
    }
}

#[tokio::test]
async fn a_run_from_cursor_zero_applies_no_marker_until_it_reaches_the_head() {
    let desktop = Desktop::open_with(Declaration::desktop(), |conn| {
        hold(conn, "task", "t1", Some(json!({ PEER: 1 })), 1_000)
    })
    .await;
    desktop.server.purge(peer_marker("task", "t1"));
    desktop.server.deleted_page(&[], "1", true);
    desktop.server.deleted_page(&["t1"], "2", false);

    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), None);
    assert_eq!(cursor(&desktop).as_deref(), Some("2"));

    desktop.server.deleted_page(&["t1"], "3", false);
    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), Some(DELETED_AT));
}

/// A device reset to cursor 0 holding `t1`, whose run from cursor 0 is longer
/// than one pass: a full pass of pages, then the page that names `t1`.
async fn a_run_from_zero_longer_than_a_pass() -> Desktop {
    let desktop = Desktop::open_with(Declaration::desktop(), |conn| {
        hold(conn, "task", "t1", Some(json!({ PEER: 1 })), 1_000)
    })
    .await;
    desktop.server.purge(peer_marker("task", "t1"));
    for page in 1..=MAX_PAGES_PER_PASS {
        desktop.server.deleted_page(&[], &page.to_string(), true);
    }
    let head = (MAX_PAGES_PER_PASS + 1).to_string();
    desktop.server.deleted_page(&["t1"], &head, false);
    desktop
}

#[tokio::test]
async fn a_run_from_cursor_zero_over_several_passes_applies_no_marker_until_the_head() {
    let desktop = a_run_from_zero_longer_than_a_pass().await;

    desktop.pass().await;
    assert_eq!(cursor(&desktop), Some(MAX_PAGES_PER_PASS.to_string()));
    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), None);
    assert_eq!(cursor(&desktop), Some((MAX_PAGES_PER_PASS + 1).to_string()));

    desktop.server.deleted_page(&["t1"], "999", false);
    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), Some(DELETED_AT));
}

#[tokio::test]
async fn a_run_from_cursor_zero_survives_a_restart_between_passes() {
    let desktop = a_run_from_zero_longer_than_a_pass().await;

    desktop.pass().await;
    assert_eq!(cursor(&desktop), Some(MAX_PAGES_PER_PASS.to_string()));
    let desktop = desktop.reopen(Declaration::desktop()).await;
    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), None);
    assert_eq!(cursor(&desktop), Some((MAX_PAGES_PER_PASS + 1).to_string()));

    desktop.server.deleted_page(&["t1"], "999", false);
    desktop.pass().await;

    assert_eq!(deleted_at(&desktop, "task", "t1"), Some(DELETED_AT));
}

#[tokio::test]
async fn a_signer_the_directory_lacks_is_looked_up_once_per_run() {
    let desktop = Desktop::open_with(Declaration::desktop(), |conn| {
        pulled_to_one(conn)?;
        hold(conn, "task", "t1", Some(json!({ PEER: 1 })), 1_000)?;
        hold(conn, "task", "t2", Some(json!({ PEER: 1 })), 1_000)
    })
    .await;
    let ghost = |id: &str| {
        marker(
            "task",
            id,
            json!({ PEER: 2 }),
            DELETED_AT,
            Some(("ghost", 14)),
        )
    };
    desktop.server.purge(ghost("t1"));
    desktop.server.purge(ghost("t2"));
    desktop.server.deleted_page(&["t1"], "2", true);
    desktop.server.deleted_page(&["t2"], "3", false);
    let lookups = desktop.server.count("/auth/devices");

    desktop.pass().await;

    assert_eq!(desktop.server.count("/auth/devices"), lookups + 1);
    assert_eq!(cursor(&desktop).as_deref(), Some("3"));

    desktop.server.purge(ghost("t1"));
    desktop.server.deleted_page(&["t1"], "4", false);
    desktop.pass().await;

    assert_eq!(desktop.server.count("/auth/devices"), lookups + 2);
}

/// A run's misses end with it (Electron's `cleanupAfterPull`,
/// `pull-coordinator.ts:587`): the manifest check after the run looks the
/// signer up again instead of reusing the run's answer.
#[tokio::test]
async fn a_signer_a_run_missed_is_looked_up_again_after_the_run() {
    let desktop = holding_a_task().await;
    let ghost = |id: &str| {
        marker(
            "task",
            id,
            json!({ PEER: 2 }),
            DELETED_AT,
            Some(("ghost", 14)),
        )
    };
    serve(&desktop, ghost("t1"));
    // Listed live by the manifest, so the check fetches it by id.
    desktop.server.purge(ghost("t2"));
    desktop.server.put("task", "t2", json!({ "title": "t2" }));
    let lookups = desktop.server.count("/auth/devices");

    desktop.pass().await;

    assert_eq!(desktop.server.count("/sync/manifest"), 1, "the check ran");
    assert_eq!(
        desktop.server.count("/auth/devices"),
        lookups + 2,
        "one lookup in the run, one in the manifest check"
    );
}

#[tokio::test]
async fn the_first_sync_refs_pass_reads_the_feed_without_purged_tombstones() {
    let desktop = Desktop::open_with(Declaration::desktop(), |_| Ok(())).await;
    desktop
        .driver
        .first_sync(Arc::new(SilentInitialSync))
        .await
        .expect("the first sync")
        .expect("not paused");

    let declared = Declaration::desktop();
    let feed = desktop.server.sync_types("/sync/changes");
    assert_eq!(
        feed.first().map(String::as_str),
        Some(declared.header_value_without_purged_tombstones().as_str())
    );
    assert!(
        feed[1..]
            .iter()
            .all(|header| header.contains("purged_tombstones"))
    );
}

/// A device reset to cursor 0 holding a note a peer deleted. Its run from cursor 0 skips the
/// note's marker (§5.12.3) and keeps no trace of it, so the note stays live here while the
/// server's manifest lacks it. The manifest check queues nothing: the server re-creates a note
/// over its marker, so a `create` would bring the deleted note back on every device
/// (REVIEW-5066, #4785).
#[tokio::test]
async fn a_note_whose_marker_a_run_from_zero_skipped_is_not_reuploaded() {
    let desktop = Desktop::open_with(Declaration::desktop(), |conn| {
        hold(conn, "note", "n1", Some(json!({ PEER: 1 })), 1_000)
    })
    .await;
    desktop.server.purge(peer_marker("note", "n1"));
    desktop.server.deleted_page(&["n1"], "1", false);
    desktop.pass().await;
    assert_eq!(
        deleted_at(&desktop, "note", "n1"),
        None,
        "the marker was skipped"
    );

    desktop.server.deleted_page(&[], "2", false);
    desktop.pass().await;

    assert!(
        desktop.server.pushed().is_empty(),
        "{:?}",
        desktop.server.pushed()
    );
    let queued: i64 = desktop
        .db
        .call_blocking(|conn| {
            conn.query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
                .map_err(failed)
        })
        .expect("the outbox");
    assert_eq!(queued, 0);
}
