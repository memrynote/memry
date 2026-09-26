//! `calendar-ical.json` (spec 007 CL070): every feed expands to the instances
//! desktop's `parseIcsFeed` answers, field for field.

use memry_core::api::calendar_ical_conformance::calendar_ical_conformance;
use serde_json::Value;

#[test]
fn every_feed_expands_as_desktop_does() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/calendar-ical.json"
    );
    let text = std::fs::read_to_string(path).expect("calendar-ical.json");
    let file: Value = serde_json::from_str(&text).expect("JSON");
    let out: Value =
        serde_json::from_str(&calendar_ical_conformance(text)).expect("seam answers JSON");
    let expected = file["cases"].as_array().expect("cases");
    let actual = out["cases"].as_array().expect("results");
    assert_eq!(expected.len(), actual.len());
    for (want, got) in expected.iter().zip(actual) {
        assert!(
            got.get("error").is_none(),
            "{}: {}",
            want["name"],
            got["error"]
        );
        let (want_feed, got_feed) = (&want["expected"], &got["actual"]);
        for key in ["name", "timezone", "refreshIntervalMs"] {
            assert_eq!(got_feed[key], want_feed[key], "{} {key}", want["name"]);
        }
        let want_events = want_feed["events"].as_array().expect("events");
        let got_events = got_feed["events"].as_array().expect("events");
        for (w, g) in want_events.iter().zip(got_events) {
            assert_eq!(g, w, "{}", want["name"]);
        }
        assert_eq!(
            got_events.len(),
            want_events.len(),
            "{} count",
            want["name"]
        );
    }
}

#[test]
fn links_normalise_and_hash_as_desktop_does() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/calendar-ical.json"
    );
    let text = std::fs::read_to_string(path).expect("calendar-ical.json");
    let file: Value = serde_json::from_str(&text).expect("JSON");
    let out: Value =
        serde_json::from_str(&calendar_ical_conformance(text)).expect("seam answers JSON");
    assert_eq!(out["urls"], file["urls"]);
    assert_eq!(out["caldav"], file["caldav"]);
}
