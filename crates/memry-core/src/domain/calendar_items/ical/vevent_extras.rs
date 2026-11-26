//! The event fields `icalToRemoteEvent` reads besides times and text (`ical-write.ts`
//! `parseAttendees`, `parseReminders`, `parseVisibility`, `COLOR_ID_BY_NAME`): what a CalDAV
//! write-back or 412 merge takes from the server, as `mapGoogleEventToCalendarEventChanges` does.

use serde_json::{Value, json};

use super::budget;
use super::parse::{Component, parse_duration};
use crate::domain::calendar_items::colors::color_id_for_ical_color;

fn strip_mailto(value: &str) -> &str {
    match value.get(..7) {
        Some(scheme) if scheme.eq_ignore_ascii_case("mailto:") => &value[7..],
        _ => value,
    }
}

pub(super) fn attendees(event: &Component) -> Option<Value> {
    let organizer = event
        .text("ORGANIZER")
        .map(|o| strip_mailto(&o).to_lowercase());
    let list: Vec<Value> = event
        .all("ATTENDEE")
        .map(|property| {
            let email = strip_mailto(&property.value);
            let status =
                property
                    .param("PARTSTAT")
                    .and_then(|p| match p.to_ascii_uppercase().as_str() {
                        "ACCEPTED" => Some("accepted"),
                        "DECLINED" => Some("declined"),
                        "TENTATIVE" => Some("tentative"),
                        "NEEDS-ACTION" => Some("needsAction"),
                        _ => None,
                    });
            json!({
                "email": email,
                "displayName": property.param("CN"),
                "responseStatus": status,
                "optional": (property.param("ROLE") == Some("OPT-PARTICIPANT")).then_some(true),
                "organizer": organizer.as_ref().map(|o| email.to_lowercase() == *o),
                "self": null,
            })
        })
        .collect();
    (!list.is_empty()).then(|| Value::Array(list))
}

/// A relative TRIGGER only (`trigger instanceof ICAL.Duration`); `Math.round` rounds a half up.
pub(super) fn reminders(event: &Component) -> Option<Value> {
    budget::step(event.children.len());
    let overrides: Vec<Value> = event
        .children
        .iter()
        .filter(|c| c.name == "VALARM")
        .filter_map(|alarm| {
            let seconds = parse_duration(&alarm.first("TRIGGER")?.value)?;
            let minutes = (-(seconds as f64) / 60.0 + 0.5).floor().max(0.0) as i64;
            Some(json!({ "method": "popup", "minutes": minutes }))
        })
        .collect();
    (!overrides.is_empty()).then(|| json!({ "useDefault": false, "overrides": overrides }))
}

pub(super) fn visibility(event: &Component) -> Option<String> {
    let class = event.text("CLASS")?.to_ascii_uppercase();
    match class.as_str() {
        "PUBLIC" => Some("public"),
        "PRIVATE" => Some("private"),
        "CONFIDENTIAL" => Some("confidential"),
        _ => None,
    }
    .map(str::to_owned)
}

pub(super) fn color_id(event: &Component) -> Option<String> {
    color_id_for_ical_color(&event.text("COLOR")?).map(str::to_owned)
}
