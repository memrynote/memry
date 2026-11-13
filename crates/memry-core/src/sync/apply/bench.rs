//! Step 16 (#3533) performance: a 500-row page of the six desktop-only types
//! against a 500-row page of notes, through [`apply_page`]. Ignored, so CI
//! never asserts a wall-clock number (`scripts/check-test-timing.mjs`); run it
//! in release and record the printed ratio:
//!
//! `cargo test -p memry-core --release --features markdown --lib
//! sync::apply::bench -- --ignored --nocapture`

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::*;
use crate::storage::{open_data, test_support::temp_dir};

const ROWS: usize = 500;
const RUNS: usize = 7;
const NOW: i64 = 1_760_000_000_000;
const ISO: &str = "2025-10-09T08:53:20.000Z";

fn record(item_type: &str, item_id: String, payload: Value) -> Pending {
    Pending::Record(InboundRecord {
        item_type: item_type.to_owned(),
        item_id,
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("peer".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    })
}

fn notes() -> Vec<Pending> {
    (0..ROWS)
        .map(|n| {
            let payload = json!({
                "title": format!("Note {n}"), "fileType": "markdown", "folderPath": "Notes",
                "clock": {"peer": 1}, "createdAt": ISO, "modifiedAt": ISO,
            });
            record("note", format!("note{n:08}"), payload)
        })
        .collect()
}

fn mixed() -> Vec<Pending> {
    (0..ROWS)
        .map(|n| match n % 6 {
            0 => record("agent_conversation", format!("conv-{n}"), json!({
                "vaultId": "vault-1", "title": format!("Plan {n}"), "backend": "local",
                "backendModel": null, "trustList": [], "pinned": false, "clock": {"peer": 1},
                "fieldClocks": {}, "createdAt": NOW, "updatedAt": NOW, "deletedAt": null,
            })),
            1 => record("agent_message", format!("msg-{n}"), json!({
                "conversationId": format!("conv-{}", n - 1), "role": "user",
                "content": {"role": "user", "data": {"text": format!("message {n}")}},
                "attachments": [], "toolCallId": null, "status": "completed",
                "clock": {"peer": 1}, "createdAt": NOW, "updatedAt": NOW,
            })),
            2 => record("canvas_folder", format!("cvf_work-{n}"), json!({
                "id": format!("cvf_work-{n}"), "vaultId": "vault-1", "path": format!("Work-{n}"),
                "icon": "star", "clock": {"peer": 1}, "deletedAt": null,
            })),
            3 => record("home_page", format!("home-{n}"), json!({
                "name": format!("Home {n}"), "icon": null, "position": n, "widgets": "[]",
                "cover": null, "clock": {"peer": 1}, "createdAt": ISO, "updatedAt": ISO,
            })),
            4 => record("vault_lock", format!("folder:P-{n}"), json!({
                "targetKind": "folder", "target": format!("P-{n}"), "locked": true,
                "clock": {"peer": 1}, "createdAt": ISO, "updatedAt": ISO,
            })),
            _ => record("sticky_draft", format!("sticky-{n}"), json!({
                "content": format!("draft {n}"), "kind": "note", "clock": {"peer": 1},
                "createdAt": ISO, "modifiedAt": ISO,
            })),
        })
        .collect()
}

/// The median of `RUNS` applies of a fresh page into a fresh `data.db`, with
/// the at-rest key installed as desktop runs (the agent rows seal).
fn median(page: fn() -> Vec<Pending>) -> Duration {
    let key = AtRestKey::default();
    key.set(Some(Zeroizing::new([5; 32])));
    let mut times: Vec<Duration> = (0..RUNS)
        .map(|run| {
            let dir = temp_dir(&format!("apply-bench-{run}"));
            let db = open_data(&dir.path().join("data.db")).expect("open data.db");
            let pending = page();
            let key = key.clone();
            db.call_blocking(move |conn| {
                let started = Instant::now();
                let totals = apply_page(conn, pending, Vec::new(), NOW, Some("device-a"), &key)?;
                let elapsed = started.elapsed();
                assert_eq!(
                    (totals.applied, totals.corrupt),
                    (ROWS, 0),
                    "every row applied"
                );
                Ok(elapsed)
            })
            .expect("apply")
        })
        .collect();
    times.sort();
    times[RUNS / 2]
}

#[test]
#[ignore = "a release-build measurement, printed and not asserted"]
fn a_page_of_desktop_only_types_against_a_page_of_notes() {
    let notes = median(notes);
    let mixed = median(mixed);
    println!(
        "apply {ROWS} rows, median of {RUNS}: notes {notes:?}, desktop-only {mixed:?}, \
         ratio {:.3}",
        mixed.as_secs_f64() / notes.as_secs_f64()
    );
}
