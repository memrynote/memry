//! Concurrent journal tag and property edits from four devices all survive
//! (chapter 06 §6.12, #5508). Each device is its own core database; records
//! cross through `apply_inbound`, the pull's entry point, carrying the payload
//! `push_payload` would send.

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::journal_ops::metadata;
use memry_core::storage::repositories::ApplyOutcome;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DAY: &str = "2026-11-23";
const ID: &str = "j2026-11-23";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-journal-field-merge-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn pushed(db: &Db) -> String {
    db.call_blocking(|conn| sync_items::push_payload(conn, "journal", ID))
        .expect("read the row")
        .expect("a payload")
}

fn tag(db: &Db, list: &[&str], device: &str) {
    let list = tags(list);
    db.call_blocking(|conn| metadata::set_tags(conn, DAY, &list, device, NOW))
        .expect("set tags");
}

fn property(db: &Db, name: &str, value: Value, device: &str) {
    db.call_blocking(|conn| {
        metadata::set_property(conn, DAY, name, value, device, NOW).map_err(|error| {
            memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            }
        })
    })
    .expect("set property");
}

fn pull(db: &Db, payload: &str) {
    let record = InboundRecord {
        item_type: "journal".to_owned(),
        item_id: ID.to_owned(),
        payload_json: payload.to_owned(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: NOW,
        deleted_at: None,
    };
    let outcome = db
        .call_blocking(|conn| apply_inbound(conn, &record, NOW))
        .expect("apply");
    assert!(matches!(
        outcome,
        ApplyOutcome::Applied | ApplyOutcome::Skipped
    ));
}

fn view(db: &Db) -> (Value, Value) {
    let payload: Value = serde_json::from_str(&pushed(db)).expect("json");
    (payload["tags"].clone(), payload["properties"].clone())
}

fn tags(list: &[&str]) -> Vec<String> {
    list.iter().map(|tag| (*tag).to_owned()).collect()
}

#[test]
fn four_concurrent_tag_and_property_edits_all_survive() {
    let (origin, a, b, ios, cli) = (open("x"), open("a"), open("b"), open("i"), open("c"));
    tag(&origin, &["lm-jtag"], "dev-x");
    property(&origin, "mood", json!("good"), "dev-x");
    let base = pushed(&origin);
    for device in [&a, &b, &ios, &cli] {
        pull(device, &base);
    }

    // Offline: each device edits the base on its own.
    tag(&a, &["lm-jtag", "t-a"], "dev-a");
    tag(&b, &["lm-jtag", "t-b"], "dev-b");
    tag(&ios, &[], "dev-i");
    property(&cli, "p3c", json!("c-val"), "dev-c");

    // The CLI pushes first; every other device pulls the server row, merges,
    // and pushes its merged row (§6.5.2 P1-P3).
    let mut server = pushed(&cli);
    for device in [&a, &b, &ios] {
        pull(device, &server);
        server = pushed(device);
    }
    for device in [&a, &b, &cli] {
        pull(device, &server);
    }

    let expected = (
        json!(["t-b", "t-a"]),
        json!({ "mood": "good", "p3c": "c-val" }),
    );
    for device in [&a, &b, &ios, &cli] {
        assert_eq!(view(device), expected);
    }
}

#[test]
fn a_removal_is_not_resurrected_by_a_peer_that_edited_something_else() {
    let (origin, phone, desk) = (open("x2"), open("p"), open("d"));
    tag(&origin, &["keep", "gone"], "dev-x");
    let base = pushed(&origin);
    pull(&phone, &base);
    pull(&desk, &base);

    tag(&phone, &["keep"], "dev-p");
    // The desk still holds `gone` at its old unit clock and edits a property.
    property(&desk, "k", json!(1), "dev-d");
    property(&desk, "k", json!(2), "dev-d");

    pull(&phone, &pushed(&desk));
    assert_eq!(view(&phone), (json!(["keep"]), json!({ "k": 2 })));
}

/// REVIEW-5529 finding 1: an older build's removal is read whole at its clock,
/// so a tag and a property it dropped stay dropped (§6.12.1).
#[test]
fn an_older_builds_removal_is_not_resurrected_by_a_body_only_edit() {
    let phone = open("old-removal");
    let legacy = json!({
        "date": DAY, "content": "", "tags": ["T"], "properties": { "p": 1 },
        "clock": { "X": 1 }
    });
    pull(&phone, &legacy.to_string());
    // A new-build edit that changes neither tags nor properties.
    phone
        .call_blocking(|conn| metadata::set_aliases(conn, DAY, &tags(&["alias"]), "N", NOW))
        .expect("aliases");

    let old_build = json!({
        "date": DAY, "content": null, "tags": [], "properties": {},
        "clock": { "X": 1, "O": 1 }
    });
    pull(&phone, &old_build.to_string());
    assert_eq!(view(&phone), (json!([]), json!({})));
}
