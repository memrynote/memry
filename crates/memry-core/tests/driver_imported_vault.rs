//! An imported Electron vault under the production `SyncDriver` (Step 36, #3553): the core
//! `ImportWriter` stages the rows as the import does, and the driver built by
//! `SyncDriver::open` pushes them through the real seal and push.
//!
//! | Test                                                  | Rule                                      |
//! | ----------------------------------------------------- | ----------------------------------------- |
//! | an imported unclocked row is seeded and pushed        | the driver registers `UnclockedSeed`      |
//! | an imported `_offline` create goes out under the signing device | `seal.rs` `wire_clock`, §6.6 |

use crate::driver_fakes::Desktop;

use memry_core::protocol::types::Declaration;
use memry_core::storage::import::{DATA_FILE, ImportQueued, ImportRecord, ImportWriter};
use memry_core::storage::open_data;
use memry_core::sync::outbox::RecordOp;
use memry_core::sync::server_vault;
use serde_json::{Value as Json, json};

/// The registered device id `driver_fakes` signs pushes as; the seal rebinds `_offline` under it.
const SIGNER_DEVICE: &str = "server-device-1";
const NOW_MS: i64 = 1_800_000_000_000;

/// A driver over a vault the import staged with `records` and `queued`.
async fn imported(records: &[ImportRecord], queued: &[ImportQueued]) -> Desktop {
    let dir = tempfile::Builder::new()
        .prefix("memry-imported-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let mut writer = ImportWriter::create(&dir).expect("the staged pair");
    writer.put_records(records, NOW_MS).expect("the records");
    writer.put_outbox(queued).expect("the outbox");
    drop(writer);
    let db = open_data(&dir.join(DATA_FILE)).expect("open data.db");
    db.call_blocking(|conn| server_vault::bind(conn, "vault-1"))
        .expect("bind the server vault");
    let declaration = Declaration::declare(&["folder_config", "template"]).expect("recognised");
    Desktop::over(db, declaration).await
}

fn clock_of(desktop: &Desktop, item_type: &'static str, id: &'static str) -> Option<String> {
    desktop
        .db
        .read_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT clock FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                    [item_type, id],
                    |row| row.get(0),
                )
                .expect("the row"))
        })
        .expect("read")
}

/// The import stages a never-clocked row with no clock and no outbox row; the driver's pass
/// that reaches the feed head seeds it under the core's clock device (chapter 01 §1.5) and
/// pushes its create.
#[tokio::test]
async fn an_imported_unclocked_row_is_seeded_and_pushed_by_the_production_driver() {
    let folder = ImportRecord {
        item_type: "folder_config",
        item_id: "Fresh".to_owned(),
        payload: json!({"icon": "star", "createdAt": "2026-01-02T03:04:05.000Z"}).to_string(),
        synced_at: None,
    };
    let desktop = imported(&[folder], &[]).await;
    assert_eq!(clock_of(&desktop, "folder_config", "Fresh"), None);

    desktop.pass().await;

    assert_eq!(
        desktop.server.pushed(),
        vec![(
            "folder_config".to_owned(),
            "Fresh".to_owned(),
            "create".to_owned()
        )]
    );
    let clock: Json =
        serde_json::from_str(&clock_of(&desktop, "folder_config", "Fresh").expect("seeded"))
            .expect("a clock");
    let ticks: Vec<(&String, &Json)> = clock.as_object().expect("a map").iter().collect();
    assert!(
        matches!(ticks.as_slice(), [(device, tick)] if *device != "_offline" && **tick == json!(1)),
        "{clock}"
    );
}

/// A never-signed-in vault's template carries an `_offline` clock and a queued create; the push
/// sends it with the ticks rebound to the signing device and no `_offline` key.
#[tokio::test]
async fn an_imported_offline_create_goes_out_under_the_signing_device() {
    let template = ImportRecord {
        item_type: "template",
        item_id: "t-off".to_owned(),
        payload: json!({"name": "Meeting", "content": "", "clock": {"_offline": 2}}).to_string(),
        synced_at: None,
    };
    let create = ImportQueued {
        item_type: "template".to_owned(),
        item_id: "t-off".to_owned(),
        op: RecordOp::Create,
        tombstone: None,
        minted: None,
        enqueued_at: NOW_MS,
    };
    let desktop = imported(&[template], &[create]).await;

    desktop.pass().await;

    let pushed: Vec<(Json, Json, Json)> = desktop
        .server
        .pushed_items()
        .into_iter()
        .map(|item| {
            (
                item["id"].clone(),
                item["operation"].clone(),
                item["clock"].clone(),
            )
        })
        .collect();
    assert_eq!(
        pushed,
        vec![(json!("t-off"), json!("create"), json!({ SIGNER_DEVICE: 2 }))]
    );
}
