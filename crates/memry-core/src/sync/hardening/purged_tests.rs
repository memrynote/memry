//! Admission of one `purgedTombstones` entry (`admitTombstone`,
//! `RecordPullPurgedTombstoneSchema`), before any key or local row.

use serde_json::json;

use super::*;

fn entry() -> Json {
    json!({
        "id": "task-1", "type": "task", "deletedAt": 7, "serverCursor": 3,
        "clock": {"dev-a": 2}, "signerDeviceId": "dev-a", "deleteAttestation": "c2ln",
    })
}

fn read(entries: Vec<Json>) -> Entries {
    let mut read = Entries::default();
    read.read(
        &json!({ "items": [], "purgedTombstones": entries }),
        &["task-1".to_owned()],
    );
    read
}

fn with(key: &str, value: Json) -> Json {
    let mut entry = entry();
    entry[key] = value;
    entry
}

fn without(key: &str) -> Json {
    let mut entry = entry();
    entry.as_object_mut().unwrap().remove(key);
    entry
}

#[test]
fn a_requested_clocked_entry_is_admitted_with_its_attestation() {
    let read = read(vec![entry()]);
    assert_eq!(
        read.markers,
        [Marker {
            item_type: "task".to_owned(),
            item_id: "task-1".to_owned(),
            deleted_at: 7,
            clock: VectorClock::from([("dev-a".to_owned(), 2)]),
            server_cursor: 3,
            attestation: Some(("dev-a".to_owned(), "c2ln".to_owned())),
        }]
    );
    assert!(read.refused.is_empty());
}

#[test]
fn each_admission_rule_refuses_on_its_own() {
    let cases = [
        (with("id", json!("task-2")), Refusal::NotRequested),
        (with("type", json!("settings")), Refusal::TypeNotClocked),
        (without("clock"), Refusal::Clockless),
        (with("clock", json!({})), Refusal::Clockless),
        (with("type", json!("attachment")), Refusal::Shape),
        (with("deletedAt", json!(-1)), Refusal::Shape),
        (with("deletedAt", json!(1.5)), Refusal::Shape),
        (without("serverCursor"), Refusal::Shape),
        (with("clock", json!({"dev-a": -1})), Refusal::Shape),
        (with("clock", json!(null)), Refusal::Shape),
        (with("signerDeviceId", json!("")), Refusal::Shape),
        (json!("task-1"), Refusal::Shape),
    ];
    for (entry, refusal) in cases {
        let read = read(vec![entry.clone()]);
        assert!(read.markers.is_empty(), "{entry}");
        assert_eq!(read.refused, [refusal], "{entry}");
    }
}

#[test]
fn half_an_attestation_is_none() {
    for key in ["signerDeviceId", "deleteAttestation"] {
        let read = read(vec![without(key)]);
        assert_eq!(read.markers[0].attestation, None, "{key}");
    }
}

#[test]
fn every_named_id_is_reported_whatever_its_entry_says() {
    let read = read(vec![
        entry(),
        with("id", json!("task-2")),
        with("deletedAt", json!("soon")),
        json!({"type": "task"}),
    ]);
    assert_eq!(
        read.named.into_iter().collect::<Vec<_>>(),
        ["task-1", "task-2"]
    );
}

#[test]
fn a_body_without_entries_reads_nothing() {
    let mut read = Entries::default();
    read.read(&json!({ "items": [] }), &["task-1".to_owned()]);
    read.read(
        &json!({ "purgedTombstones": {"id": "task-1"} }),
        &["task-1".to_owned()],
    );
    assert!(read.markers.is_empty() && read.refused.is_empty() && read.named.is_empty());
}

#[test]
fn a_deleted_at_is_read_in_the_unit_it_was_pushed_in() {
    assert_eq!(to_ms(1_760_000_000), 1_760_000_000_000);
    assert_eq!(to_ms(1_760_000_000_123), 1_760_000_000_123);
}

#[test]
fn payload_timestamps_are_read_as_iso_or_epoch() {
    let payload =
        json!({"createdAt": "2025-10-09T08:53:20.000Z", "modifiedAt": 1_760_000_100}).to_string();
    let touched: Vec<i64> = touched_ms(Some(&payload), 5).collect();
    assert_eq!(touched, [1_760_000_000_000, 1_760_000_100_000, 5]);
}

fn arbitrary_value() -> impl proptest::strategy::Strategy<Value = Json> {
    use proptest::prelude::*;
    let leaf = prop_oneof![
        Just(Json::Null),
        any::<bool>().prop_map(Json::from),
        any::<i64>().prop_map(Json::from),
        (0u64..20).prop_map(Json::from),
        prop_oneof![
            Just("task-1"),
            Just("task"),
            Just("settings"),
            Just(""),
            Just("dev-a")
        ]
        .prop_map(Json::from),
    ];
    leaf.prop_recursive(3, 24, 6, |inner| {
        let keys = prop_oneof![
            Just("id"),
            Just("type"),
            Just("deletedAt"),
            Just("serverCursor"),
            Just("clock"),
            Just("signerDeviceId"),
            Just("deleteAttestation"),
            Just("dev-a"),
        ];
        prop_oneof![
            proptest::collection::vec(inner.clone(), 0..4).prop_map(Json::from),
            proptest::collection::btree_map(keys.prop_map(str::to_owned), inner, 0..7)
                .prop_map(|map| Json::Object(map.into_iter().collect())),
        ]
    })
}

proptest::proptest! {
    #![proptest_config(memry_test_kit::proptest_config(256))]

    /// Any entry list reads without panicking, and only a requested,
    /// clock-required, non-empty-clocked entry is admitted.
    #[test]
    fn an_arbitrary_entry_list_admits_only_what_the_rules_allow(
        entries in proptest::collection::vec(arbitrary_value(), 0..8),
        base in proptest::collection::vec(proptest::strategy::Just(entry()), 0..2),
    ) {
        let total = entries.len() + base.len();
        let read = read(entries.into_iter().chain(base).collect());
        proptest::prop_assert_eq!(read.markers.len() + read.refused.len(), total);
        for marker in &read.markers {
            proptest::prop_assert_eq!(marker.item_id.as_str(), "task-1");
            proptest::prop_assert_ne!(marker.item_type.as_str(), "settings");
            proptest::prop_assert!(!marker.clock.is_empty());
        }
    }
}
