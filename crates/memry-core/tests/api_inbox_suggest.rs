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
    assert_eq!(found[2].suggested_tags, ["Project"]);
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
