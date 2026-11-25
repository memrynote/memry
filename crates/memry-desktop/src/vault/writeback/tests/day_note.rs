//! A peer's `note` record under a journal day's id (#5766): Electron names a day's pictures in a
//! `note` record of the day's id (#5731), so the pull keeps a `notes` row beside the day's
//! `journal_entries` row. The day's file stays where the journal layer puts it under this
//! vault's date format, and its frontmatter keeps the day's record, not the note record's.

use memry_core::crdt::body_edit::BlockEdit;
use memry_core::storage::repositories::sync_items::InboundRecord;
use memry_core::sync::apply::apply_inbound_on;
use serde_json::json;

use super::*;
use crate::vault::config::{VaultConfigPatch, write_vault_config};

const DATE: &str = "2026-11-04";
const DAY_FILE: &str = "journal/04-11-2026.md";
const DAY_TEXT: &str = "---\ndate: '2026-11-04'\ntags:\n  - mine\n---\nthe day\n";

/// `buildNotePushPayload` (`note-handler-sync-helpers.ts`) for the day's `note_metadata` row:
/// the day's ISO date as title, the journal folder, the pictures, and a tag of its own.
fn electron_day_note() -> String {
    json!({
        "title": DATE, "content": "the day\n", "tags": ["peer-tag"], "properties": {},
        "pinnedTags": [], "emoji": null, "fileType": "markdown", "folderPath": "journal",
        "attachmentReferences": ["att-peer"], "clock": {"peer": 2},
        "createdAt": "2026-11-04T00:00:00.000Z", "modifiedAt": "2026-11-04T00:00:00.000Z",
    })
    .to_string()
}

/// The note record applied by the pull's apply, then marked as the sync observer marks it
/// (`sync::disk`, `title_before` from `feed::title_before`: no live `notes` row before).
fn pull_note_record(f: &Fixture, id: &str) {
    let record = InboundRecord {
        item_type: "note".into(),
        item_id: id.to_owned(),
        payload_json: electron_day_note(),
        server_cursor: Some(7),
        signer_device_id: Some("peer".into()),
        updated_at: now_ms(),
        deleted_at: None,
    };
    f.vault
        .db_handle()
        .call_blocking(move |conn| {
            apply_inbound_on(conn, &record, now_ms(), None).unwrap();
            Ok(())
        })
        .unwrap();
    f.pass.mark_pulled(id, None);
}

/// Red before #5766: the write-back placed the `notes` row's record and moved the day's file to
/// `journal/2026-11-04.md`, which is no day under `DD-MM-YYYY`, and wrote the note record's
/// tags into the day's frontmatter.
#[test]
fn a_peers_same_id_note_record_never_moves_a_days_file() {
    let mut f = fixture();
    let patch = VaultConfigPatch {
        journal_date_format: Some("DD-MM-YYYY".to_owned()),
        ..VaultConfigPatch::default()
    };
    write_vault_config(&f.root, &patch).unwrap();
    let id = f.adopt_day(DAY_FILE, DATE, DAY_TEXT);
    assert_eq!(id, format!("j{DATE}"));
    assert_eq!(f.run(&id), Outcome::Unchanged);

    pull_note_record(&f, &id);
    let outcome = f.run(&id);

    assert!(
        matches!(outcome, Outcome::Unchanged | Outcome::Wrote { .. }),
        "{outcome:?}"
    );
    assert!(!f.root.join("journal/2026-11-04.md").exists());
    let file = f.read(DAY_FILE);
    assert!(!file.contains("peer-tag"), "{file}");
    assert!(file.contains("the day"), "{file}");
    let row = f.vault.note_files().by_id(&id).unwrap().expect("a row");
    assert_eq!(row.path, DAY_FILE);
    assert!(
        !f.facts()
            .iter()
            .any(|fact| matches!(fact, Applied::Renamed { .. }))
    );
}

/// A day pulled before its file was written here, then the note record of its id: the day's
/// first file lands at its path under `DD-MM-YYYY` with the day's `date`. Red before #5766: the
/// note record named the first file `journal/2026-11-04.md`, with no `date` line.
#[test]
fn a_peers_same_id_note_record_never_names_an_unfiled_days_first_file() {
    let mut f = fixture();
    let patch = VaultConfigPatch {
        journal_date_format: Some("DD-MM-YYYY".to_owned()),
        ..VaultConfigPatch::default()
    };
    write_vault_config(&f.root, &patch).unwrap();
    let journal = f.vault.journal(f.store.clone()).unwrap();
    let typed = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "day from A".into(),
        new_block_id: "a-day".into(),
    };
    journal.edit_day(DATE.into(), typed).unwrap();
    let id = journal.entry_id(DATE.into()).unwrap().expect("the day");
    pull_note_record(&f, &id);
    f.rows.lane_of(f.pass.session).unwrap().set_walked(true);

    let outcome = f.run(&id);
    let file = assert_wrote(&mut f, &outcome, DAY_FILE);
    assert!(file.starts_with("---\ndate: '2026-11-04'\n"), "{file:?}");
    assert!(!file.contains("peer-tag"), "{file:?}");
    assert!(!f.root.join("journal/2026-11-04.md").exists());
}
