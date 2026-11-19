//! Step 27 stage 5a end to end on a real vault: filing suggestions from the
//! filed captures, suggestion feedback (data migration 0041), the review
//! tick's once-a-day guard and Convert to event.

#[allow(unused_imports)]
use crate::http_fakes;

use std::path::PathBuf;
use std::sync::Arc;

use http_fakes::FakeSecureStore;
use memry_core::api::inbox::Inbox;
use memry_core::api::inbox_settings::InboxReviewSettings;
use memry_core::api::inbox_suggest::{InboxSuggestHit, InboxSuggestIndex};
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::sync::apply::apply_inbound;
use serde_json::{Value, json};

const NOW: &str = "2026-11-18T09:30";

fn open() -> (Vault, Arc<Inbox>, Arc<dyn SecureStore>) {
    let dir: PathBuf = tempfile::Builder::new()
        .prefix("memry-api-inbox-suggest-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let (_public, secret) = sodium::sign_seed_keypair(&[5u8; 32]).expect("a keypair");
    let store: Arc<dyn SecureStore> = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let inbox = vault.inbox(store.clone()).expect("the inbox surface");
    (vault, inbox, store)
}

fn capture(inbox: &Inbox, text: &str) -> String {
    inbox
        .capture_text(text.into(), None, None, true)
        .expect("capture")
        .item
        .id
}

/// `getSuggestions` reads the filing patterns from filed captures of the same
/// type (history first), then the most used folder filings of any type.
#[test]
fn suggestions_come_from_filed_captures_and_the_index() {
    let (_vault, inbox, _store) = open();
    for folder in ["work", "work", "home"] {
        let id = capture(&inbox, &format!("filed to {folder}"));
        inbox
            .add_tag(id.clone(), "Project".into())
            .expect("tag the capture");
        inbox
            .file_to_folder(id, Some(folder.into()), Vec::new(), NOW.into())
            .expect("file");
    }
    let item = capture(&inbox, "notes about the weekly review");
    let index = InboxSuggestIndex {
        hits: vec![InboxSuggestHit {
            note_id: "note-1".into(),
            path: "meetings/weekly.md".into(),
            title: "Weekly".into(),
            emoji: None,
            snippet: Some("the weekly".into()),
            distance: 0.1,
        }],
        folders: Vec::new(),
        tagged_notes: Vec::new(),
    };

    let found = inbox.suggestions(item, index).expect("suggestions");

    let shape: Vec<_> = found
        .iter()
        .map(|s| {
            let target = s.path.clone().or(s.note_id.clone()).unwrap_or_default();
            (s.destination_type.as_str(), target, s.reason.as_str())
        })
        .collect();
    // Both `work` captures share a title, so they were filed to one path.
    assert_eq!(
        shape,
        [
            (
                "folder",
                "meetings".to_owned(),
                "Similar to \"Weekly\" in meetings"
            ),
            (
                "folder",
                "work".to_owned(),
                "You've filed 2 similar notes here"
            ),
            (
                "folder",
                "home".to_owned(),
                "You've filed 1 similar notes here"
            ),
            ("note", "note-1".to_owned(), "Similar content (75% match)"),
        ]
    );
    assert!((found[1].confidence - 0.5).abs() < 1e-12);
    // `mergedTags`: the capture's tags, then `inbox`.
    assert_eq!(found[2].suggested_tags, ["Project", "inbox"]);
    assert!(
        inbox
            .suggestions("missing".into(), InboxSuggestIndex::default())
            .expect("no capture")
            .is_empty()
    );
}

/// `trackSuggestionFeedback` and `getSuggestionStats`.
#[test]
fn feedback_counts_accepted_and_rejected_choices() {
    let (vault, inbox, _store) = open();
    let empty = inbox.suggestion_stats().expect("stats");
    assert_eq!((empty.total_suggestions, empty.acceptance_rate), (0, 0.0));
    inbox
        .track_suggestion(
            "i1".into(),
            "note".into(),
            "work".into(),
            "work".into(),
            0.875,
            vec!["a".into()],
            vec![],
        )
        .expect("track");
    for actual in ["home", "later"] {
        inbox
            .track_suggestion(
                "i2".into(),
                "link".into(),
                "work".into(),
                actual.into(),
                0.5,
                vec![],
                vec![],
            )
            .expect("track");
    }
    let stats = inbox.suggestion_stats().expect("stats");
    assert_eq!(
        (
            stats.total_suggestions,
            stats.accepted_count,
            stats.rejected_count
        ),
        (3, 1, 2)
    );
    assert!((stats.acceptance_rate - 1.0 / 3.0).abs() < 1e-12);
    let row: (i64, String, i64) = vault
        .db_handle()
        .read_blocking(|conn| {
            Ok(conn
                .query_row(
                    "SELECT confidence, suggested_tags, accepted FROM inbox_suggestion_feedback
                      WHERE item_id = 'i1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("the row"))
        })
        .expect("read");
    assert_eq!(row, (88, r#"["a"]"#.to_owned(), 1));
}

/// `runReviewTick`: nothing while off, nothing before the time, once a day
/// after it, and nothing with an empty inbox.
#[test]
fn the_review_tick_fires_once_per_local_day() {
    let (_vault, inbox, _store) = open();
    capture(&inbox, "something to review");
    assert_eq!(
        inbox.review_due("2026-11-18".into(), 20 * 60).expect("off"),
        None
    );
    inbox
        .set_review_settings(InboxReviewSettings {
            enabled: true,
            time: "18:00".into(),
        })
        .expect("turn it on");
    assert_eq!(
        inbox
            .review_due("2026-11-18".into(), 17 * 60)
            .expect("early"),
        None
    );
    assert_eq!(
        inbox.review_due("2026-11-18".into(), 18 * 60).expect("due"),
        Some(1)
    );
    assert_eq!(
        inbox
            .review_due("2026-11-18".into(), 23 * 60)
            .expect("again"),
        None
    );
    assert_eq!(
        inbox
            .review_due("2026-11-19".into(), 18 * 60)
            .expect("next"),
        Some(1)
    );
    assert!(inbox.review_due("2026-11-1".into(), 0).is_err());
    assert!(inbox.review_due("2026-11-20".into(), 24 * 60).is_err());

    let (_vault, empty, _store) = open();
    empty
        .set_review_settings(InboxReviewSettings {
            enabled: true,
            time: "00:00".into(),
        })
        .expect("turn it on");
    assert_eq!(
        empty.review_due("2026-11-18".into(), 0).expect("empty"),
        None
    );
}

/// A peer's settings payload: this device's synced settings with `edit`
/// applied and `path`'s clock ticked for `peer`, so it dominates.
fn peer_settings(vault: &Vault, path: &str, edit: impl FnOnce(&mut Value)) -> InboundRecord {
    let raw = vault
        .db_handle()
        .call_blocking(|conn| {
            Ok(sync_items::push_payload(conn, "settings", "synced_settings")?.expect("payload"))
        })
        .expect("the local settings");
    let mut payload: Value = serde_json::from_str(&raw).expect("json");
    edit(&mut payload["settings"]);
    payload["fieldClocks"][path]["peer"] = json!(1);
    InboundRecord {
        item_type: "settings".into(),
        item_id: "synced_settings".into(),
        payload_json: payload.to_string(),
        server_cursor: Some(9),
        signer_device_id: Some("peer".into()),
        updated_at: 1,
        deleted_at: None,
    }
}

/// Electron re-arms the once-a-day guard when the schedule changes, on a
/// local write (`writeInboxReviewSettings`) and synced in from a peer
/// (`propagateMergedSettings`), so the new time can fire again today.
#[test]
fn a_changed_review_schedule_re_arms_the_guard_locally_and_from_a_peer() {
    let (vault, inbox, _store) = open();
    capture(&inbox, "something to review");
    let at = |time: &str| InboxReviewSettings {
        enabled: true,
        time: time.into(),
    };
    inbox.set_review_settings(at("18:00")).expect("18:00");
    let due = |minutes: u32| {
        inbox
            .review_due("2026-11-18".into(), minutes)
            .expect("tick")
    };
    assert_eq!(due(18 * 60), Some(1));
    inbox.set_review_settings(at("20:00")).expect("20:00");
    assert_eq!(due(20 * 60), Some(1), "a new time fires again today");
    inbox.set_review_settings(at("20:00")).expect("unchanged");
    assert_eq!(
        due(20 * 60 + 30),
        None,
        "an unchanged schedule keeps the guard"
    );

    let apply = |record: InboundRecord| {
        vault
            .db_handle()
            .call_blocking(move |conn| apply_inbound(conn, &record, 2))
            .expect("apply")
    };
    let theme = peer_settings(&vault, "general.theme", |s| {
        s["general"] = json!({"theme": "dark"});
    });
    assert_eq!(apply(theme), ApplyOutcome::Applied);
    assert_eq!(due(21 * 60), None, "another setting keeps the guard");

    let moved = peer_settings(&vault, "inbox.reviewReminderTime", |s| {
        s["inbox"]["reviewReminderTime"] = json!("21:00");
    });
    assert_eq!(apply(moved), ApplyOutcome::Applied);
    assert_eq!(inbox.review_settings().expect("read").time, "21:00");
    assert_eq!(due(21 * 60), Some(1), "a synced-in time fires again today");
}

/// `convertToEvent`: a UTC event titled from the capture with its text as
/// the description, and the capture filed as `event`.
#[test]
fn convert_to_event_files_the_capture_as_its_event() {
    let (vault, inbox, store) = open();
    let id = inbox
        .capture_text("Dentist at noon".into(), Some("Dentist".into()), None, true)
        .expect("capture")
        .item
        .id;
    let filed = inbox
        .convert_to_event(
            id.clone(),
            "2026-11-20T12:00:00.000Z".into(),
            Some("2026-11-20T13:00:00.000Z".into()),
            false,
            Some("Main St".into()),
            NOW.into(),
        )
        .expect("convert");
    let event_id = filed.target_id.expect("the event");
    assert_eq!(filed.filed_to, event_id);
    let event = vault
        .calendar(store)
        .expect("calendar")
        .event(event_id.clone())
        .expect("read")
        .expect("the event");
    assert_eq!(event.title, "Dentist");
    assert_eq!(event.description.as_deref(), Some("Dentist at noon"));
    assert_eq!(event.location.as_deref(), Some("Main St"));
    assert_eq!(event.timezone, "UTC");
    assert!(!event.is_all_day);
    let item = inbox.get(id.clone()).expect("read").expect("the capture");
    assert_eq!(item.filed_to.as_deref(), Some(event_id.as_str()));
    assert_eq!(item.filed_action.as_deref(), Some("event"));

    let again = inbox.convert_to_event(
        id,
        "2026-11-20T12:00:00.000Z".into(),
        None,
        false,
        None,
        NOW.into(),
    );
    assert!(
        again
            .unwrap_err()
            .to_string()
            .contains("already been filed")
    );
}

/// `convertToEvent` refuses file captures (`isNoteOnlyType`).
#[test]
fn a_file_capture_cannot_become_an_event() {
    let (_vault, inbox, _store) = open();
    let id = inbox.new_id();
    inbox
        .capture_file(
            id.clone(),
            "image/png".into(),
            "a.png".into(),
            10,
            format!("attachments/inbox/{id}/a.png"),
            None,
            None,
            None,
        )
        .expect("capture");
    let refused = inbox
        .convert_to_event(
            id,
            "2026-11-20T12:00:00.000Z".into(),
            None,
            true,
            None,
            NOW.into(),
        )
        .unwrap_err();
    assert!(refused.to_string().contains("Only text and voice items"));
}
