//! A journal day's pictures from a desktop peer (#5731 on Tauri, #5423 OL-F13): a `journal`
//! record has no `attachmentReferences`, so Electron names a day's pictures in a `note` record
//! under the day's id (`journal.tsx:1448` uploads with `noteId = entry.id`, `recordOnNote`
//! enqueues `note`). Electron's own handler skipped that record for a day it held until #5736.
//! The core keys a record by `(item_type, item_id)`, so the `note` record applies beside the
//! day: its references reach the `notes` row of the day's id and the observers are asked for
//! each picture, owned by the day, while the day's `journal` record and row stay as they were.
//!
//! Real SQLite, the real pull loop, and the relay of `desktop_relay`.
//!
//! | Test                                                        | Rule                         |
//! | ----------------------------------------------------------- | ---------------------------- |
//! | a held day's same-id note record asks for its pictures       | no type skip, `feed::record` |
//! | a later record unions the day's references and asks again   | §6.8.1 union                 |

use std::sync::{Arc, Mutex};

use crate::desktop_relay::{Device, NOW_ISO, Relay, failed};

use memry_core::sync::driver::observer::{ApplyObserver, AttachmentDownload, Observers};
use serde_json::{Value as Json, json};

const DATE: &str = "2026-11-04";
const DAY: &str = "j2026-11-04";

#[derive(Default)]
struct Asked(Mutex<Vec<AttachmentDownload>>);

impl ApplyObserver for Asked {
    fn name(&self) -> &str {
        "asked"
    }

    fn attachment_download_needed(&self, download: &AttachmentDownload) {
        self.0.lock().unwrap().push(download.clone());
    }
}

/// `buildPushPayload` of Electron's journal handler: no `attachmentReferences`.
fn electron_day() -> String {
    json!({
        "date": DATE, "content": "the day\n", "tags": [], "properties": {},
        "clock": {"peer": 1}, "createdAt": NOW_ISO, "modifiedAt": NOW_ISO,
    })
    .to_string()
}

/// `buildNotePushPayload` (`note-handler-sync-helpers.ts`) for the day's `note_metadata` row:
/// the day's date as title, the journal folder, and the pictures.
fn electron_day_note(references: &[&str], clock: Json) -> String {
    json!({
        "title": DATE, "content": "the day\n", "tags": [], "properties": {}, "pinnedTags": [],
        "emoji": null, "fileType": "markdown", "folderPath": "journal",
        "attachmentReferences": references, "clock": clock,
        "createdAt": NOW_ISO, "modifiedAt": NOW_ISO,
    })
    .to_string()
}

async fn pull(relay: &Relay, device: &Device) -> Vec<(String, String)> {
    let asked = Arc::new(Asked::default());
    let observers = Arc::new(Observers::default());
    observers.register(asked.clone());
    relay
        .pull_observed(device, relay.snapshot(), observers)
        .await;
    let asked = asked.0.lock().unwrap();
    asked
        .iter()
        .map(|download| {
            assert!(!download.own_file, "an embedded picture: {download:?}");
            (download.owner_id.clone(), download.attachment_id.clone())
        })
        .collect()
}

/// The day's references as the `notes` row of its id holds them.
fn day_references(device: &Device) -> Json {
    let raw: Option<String> = device
        .db()
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT attachment_references FROM notes WHERE id = ?1",
                [DAY],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .expect("the day's notes row");
    raw.map_or(Json::Null, |raw| {
        serde_json::from_str::<Json>(&raw).expect("json")
    })
}

/// A device that holds the day, pulled from the peer.
async fn holding_the_day() -> (Device, Relay) {
    let (device, relay) = (Device::bare("b"), Relay::default());
    relay.put("journal", DAY, &electron_day());
    pull(&relay, &device).await;
    assert_eq!(
        device.count("SELECT COUNT(*) FROM journal_entries WHERE deleted_at IS NULL"),
        1,
        "the day is held"
    );
    (device, relay)
}

fn assert_day_kept(device: &Device) {
    assert_eq!(
        device.stored("journal", DAY),
        electron_day(),
        "the day's record is the peer's journal payload, untouched by the note record"
    );
    assert_eq!(
        device.count(
            "SELECT COUNT(*) FROM journal_entries \
             WHERE id = 'j2026-11-04' AND date = '2026-11-04' AND deleted_at IS NULL"
        ),
        1,
        "the day stays live under its date"
    );
}

/// Red if the apply skipped the `note` record for an id a `journal` day holds, as Electron's
/// `belongsToOtherType` did before #5736: no references on the row, no download asked.
#[tokio::test]
async fn a_held_days_same_id_note_record_asks_for_its_pictures() {
    let (device, relay) = holding_the_day().await;

    relay.put(
        "note",
        DAY,
        &electron_day_note(&["att-peer"], json!({"peer": 2})),
    );
    let asked = pull(&relay, &device).await;

    assert_eq!(day_references(&device), json!(["att-peer"]));
    assert_eq!(asked, [(DAY.to_owned(), "att-peer".to_owned())]);
    assert_day_kept(&device);
}

/// A second device's record for the day unions with what this device held (§6.8.1), and each
/// picture of the applied record is asked for under the day's id.
#[tokio::test]
async fn a_later_record_unions_the_days_references_and_asks_again() {
    let (device, relay) = holding_the_day().await;
    relay.put(
        "note",
        DAY,
        &electron_day_note(&["att-1"], json!({"peer": 2})),
    );
    pull(&relay, &device).await;

    relay.put(
        "note",
        DAY,
        &electron_day_note(&["att-2"], json!({"other": 1})),
    );
    let asked = pull(&relay, &device).await;

    assert_eq!(day_references(&device), json!(["att-1", "att-2"]));
    assert!(
        asked.contains(&(DAY.to_owned(), "att-2".to_owned())),
        "the new picture is asked for under the day: {asked:?}"
    );
    assert_day_kept(&device);
}
