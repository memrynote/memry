//! `calendar-ical.json` through the core (spec 007 CL070): each feed parsed
//! and expanded the way desktop's `parseIcsFeed` does.

use serde_json::{Value, json};

use super::calendar_conformance::zone;
use crate::domain::calendar_items::ical::{IcalWindow, IcalZones, parse_feed};
use crate::domain::calendar_items::ics::{normalize_url, source_id};
use crate::domain::calendar_items::providers::caldav;
use crate::storage::repositories::instants::to_epoch_ms;

fn window(value: &Value) -> Option<IcalWindow> {
    Some(IcalWindow {
        start_ms: to_epoch_ms(value["startAt"].as_str()?)?,
        end_ms: to_epoch_ms(value["endAt"].as_str()?)?,
    })
}

/// Runs every case of `calendar-ical.json` and answers `{ cases: [{ name,
/// actual | error }] }`.
#[uniffi::export]
pub fn calendar_ical_conformance(vector_json: String) -> String {
    let Ok(file) = serde_json::from_str::<Value>(&vector_json) else {
        return json!({ "error": "not JSON" }).to_string();
    };
    let zones = IcalZones {
        named: file["zones"]
            .as_array()
            .map(|all| {
                all.iter()
                    .map(|z| (z["identifier"].as_str().unwrap_or("").to_owned(), zone(z)))
                    .collect()
            })
            .unwrap_or_default(),
        local: zone(&file["deviceZone"]),
    };
    let cases: Vec<Value> = file["cases"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|case| {
            let Some(window) = window(&case["window"]) else {
                return json!({ "name": case["name"], "error": "bad window" });
            };
            match parse_feed(case["text"].as_str().unwrap_or(""), window, &zones) {
                Ok(feed) => json!({
                    "name": case["name"],
                    "actual": {
                        "name": feed.name,
                        "timezone": feed.timezone,
                        "refreshIntervalMs": feed.refresh_interval_ms,
                        "events": feed.events.iter().map(|e| json!({
                            "remoteEventId": e.remote_event_id,
                            "title": e.title,
                            "description": e.description,
                            "location": e.location,
                            "startAt": e.start_at,
                            "endAt": e.end_at,
                            "isAllDay": e.is_all_day,
                            "timezone": e.timezone,
                            "status": e.status,
                            "remoteUpdatedAt": e.remote_updated_at,
                        })).collect::<Vec<_>>(),
                    }
                }),
                Err(_) => json!({ "name": case["name"], "error": "not_a_calendar" }),
            }
        })
        .collect();
    let urls: Vec<Value> = file["urls"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|case| {
            let normalized = normalize_url(case["input"].as_str().unwrap_or(""));
            json!({
                "input": case["input"],
                "normalized": normalized,
                "sourceId": normalized.as_deref().map(source_id),
            })
        })
        .collect();
    let caldav: Vec<Value> = file["caldav"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|case| {
            let server_url = caldav::normalize_server_url(case["server"].as_str().unwrap_or(""));
            let username = case["username"].as_str().unwrap_or("");
            json!({
                "server": case["server"],
                "username": case["username"],
                "serverUrl": server_url,
                "accountId": server_url.as_deref().map(|url| caldav::account_id(url, username)),
                "calendarSourceId": server_url.as_deref().map(|url| caldav::calendar_source_id(&format!("{url}calendars/work/"))),
            })
        })
        .collect();
    json!({ "cases": cases, "urls": urls, "caldav": caldav }).to_string()
}
