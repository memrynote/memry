//! `calendar-write.json` (spec 007 CL070): what the phone writes to CalDAV
//! and Google matches desktop's own writers. Objects are compared per VEVENT
//! property, stamps and VTIMEZONE text aside (each side writes a zone's rules
//! its own way; both name the same TZID).

use std::collections::HashMap;

use memry_core::api::calendar_records::{CalendarZone, CalendarZoneTransition};
use memry_core::domain::calendar_items::ical::IcalZones;
use memry_core::domain::calendar_items::ical::parse::{Component, parse_calendar};
use memry_core::domain::calendar_items::providers::{ical_write, recurrence_lines};
use memry_core::domain::calendar_items::zone::FixedZone;
use memry_core::storage::repositories::instants;
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/calendar-write.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("calendar-write.json"))
        .expect("JSON")
}

fn zones(file: &Value) -> HashMap<String, CalendarZone> {
    file["zones"]
        .as_array()
        .expect("zones")
        .iter()
        .map(|z| {
            let zone = CalendarZone {
                identifier: z["identifier"].as_str().expect("id").to_owned(),
                base_offset_ms: z["baseOffsetMs"].as_i64().expect("base"),
                transitions: z["transitions"]
                    .as_array()
                    .expect("transitions")
                    .iter()
                    .map(|t| CalendarZoneTransition {
                        at_ms: t["atMs"].as_i64().expect("at"),
                        offset_ms: t["offsetMs"].as_i64().expect("offset"),
                    })
                    .collect(),
            };
            (zone.identifier.clone(), zone)
        })
        .collect()
}

fn utc() -> CalendarZone {
    CalendarZone {
        identifier: "UTC".into(),
        base_offset_ms: 0,
        transitions: vec![],
    }
}

const STAMPS: [&str; 3] = ["DTSTAMP", "LAST-MODIFIED", "CREATED"];

/// A component's own lines (stamps aside), sorted, then its children's.
fn shape(component: &Component) -> Vec<String> {
    let mut lines: Vec<String> = component
        .properties
        .iter()
        .filter(|p| !STAMPS.contains(&p.name.as_str()))
        .map(|p| p.to_line())
        .collect();
    lines.sort();
    for child in &component.children {
        lines.push(format!("BEGIN:{}", child.name));
        lines.extend(shape(child));
        lines.push(format!("END:{}", child.name));
    }
    lines
}

fn assert_same_object(name: &str, got: &str, want: &str) {
    let (got, want) = (
        parse_calendar(got).expect("ours parses"),
        parse_calendar(want).expect("desktop's parses"),
    );
    let events = |root: &Component| -> Vec<Vec<String>> {
        root.children_named("VEVENT").map(shape).collect()
    };
    let zones = |root: &Component| -> Vec<String> {
        root.children_named("VTIMEZONE")
            .filter_map(|z| z.text("TZID"))
            .collect()
    };
    assert!(!events(&want).is_empty(), "{name}: desktop wrote no VEVENT");
    assert_eq!(events(&got), events(&want), "{name}: VEVENTs");
    assert_eq!(zones(&got), zones(&want), "{name}: VTIMEZONE ids");
}

fn now_ms(file: &Value) -> i64 {
    instants::to_epoch_ms(file["now"].as_str().expect("now")).expect("instant")
}

#[test]
fn new_objects_match_desktop() {
    let file = vectors();
    let named = zones(&file);
    for case in file["newObjects"].as_array().expect("cases") {
        let event = &case["event"];
        let zone = event["timezone"].as_str().and_then(|id| named.get(id));
        let got = ical_write::new_object(
            event,
            case["uid"].as_str().expect("uid"),
            zone,
            &FixedZone(0),
            now_ms(&file),
        );
        assert_same_object(
            case["name"].as_str().unwrap_or(""),
            &got,
            case["expected"].as_str().expect("expected"),
        );
    }
}

#[test]
fn patches_and_occurrences_match_desktop() {
    let file = vectors();
    let named = zones(&file);
    let ical_zones = IcalZones {
        named: named.clone(),
        local: utc(),
    };
    for case in file["patches"].as_array().expect("cases") {
        let event = &case["event"];
        let zone = event["timezone"].as_str().and_then(|id| named.get(id));
        let occurrence = case["recurrenceId"]
            .as_str()
            .and_then(instants::to_epoch_ms)
            .map(|ms| (ms, &ical_zones));
        let got = ical_write::patch_object(
            case["raw"].as_str().expect("raw"),
            event,
            zone,
            &FixedZone(0),
            occurrence,
            now_ms(&file),
        )
        .expect("patch");
        assert_same_object(
            case["name"].as_str().unwrap_or(""),
            &got,
            case["expected"].as_str().expect("expected"),
        );
    }
    for case in file["exclusions"].as_array().expect("cases") {
        let rid = instants::to_epoch_ms(case["recurrenceId"].as_str().expect("rid")).expect("ms");
        let got = ical_write::exclude_occurrence(
            case["raw"].as_str().expect("raw"),
            rid,
            &ical_zones,
            now_ms(&file),
        )
        .expect("exclude");
        assert_same_object(
            case["name"].as_str().unwrap_or(""),
            &got,
            case["expected"].as_str().expect("expected"),
        );
    }
}

#[test]
fn recurrence_lines_match_desktop() {
    let file = vectors();
    let named = zones(&file);
    for case in file["recurrences"].as_array().expect("cases") {
        let got = recurrence_lines(
            &case["rule"],
            &case["exceptions"],
            case["timezone"].as_str().expect("tz"),
            (&FixedZone(0), "UTC"),
            &named,
        );
        assert_eq!(got, case["expected"], "{}", case["name"]);
    }
}
