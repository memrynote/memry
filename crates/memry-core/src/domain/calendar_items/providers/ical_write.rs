//! A Memry item as a CalDAV object (spec 007 CL074, desktop
//! `ical/ical-write.ts`): `eventToICalendar` for a new object and
//! `patchICalendar` for one the server already holds, rewriting only the
//! properties Memry owns so a server's own extras survive an edit.

use serde_json::Value;

use crate::api::calendar_records::CalendarZone;
use crate::domain::calendar::CivilDate;
use crate::domain::calendar_items::ical::IcalZones;
use crate::domain::calendar_items::ical::occurrence::ObjectTimes;
use crate::domain::calendar_items::ical::parse::{Component, NotACalendar, parse_calendar};
use crate::domain::calendar_items::zone::LocalZone;
use crate::storage::repositories::instants;

const PRODID: &str = "-//memrynote//Calendar//EN";
const MEMRY_SOURCE: &str = "X-MEMRY-SOURCE-ID";
const MEMRY_SOURCE_TYPE: &str = "X-MEMRY-SOURCE-TYPE";
const MEANINGFUL: [&str; 7] = [
    "DTSTART", "DTEND", "DURATION", "RRULE", "EXDATE", "SUMMARY", "LOCATION",
];

/// RFC 7986 COLOR names per Google colour id (`COLOR_NAME_BY_ID`).
fn color_name(id: &str) -> Option<&'static str> {
    Some(match id {
        "11" => "tomato",
        "4" => "lightcoral",
        "6" => "darkorange",
        "5" => "gold",
        "2" => "mediumseagreen",
        "10" => "seagreen",
        "7" => "deepskyblue",
        "9" => "royalblue",
        "1" => "mediumpurple",
        "3" => "darkviolet",
        "8" => "gray",
        _ => return None,
    })
}

fn stamp(ms: i64) -> String {
    let iso = instants::to_iso8601(ms).unwrap_or_default();
    format!(
        "{}Z",
        iso.split('.')
            .next()
            .unwrap_or(&iso)
            .replace(['-', ':'], "")
            .trim_end_matches('Z')
    )
}

fn wall_stamp(ms: i64, zone: &dyn LocalZone) -> String {
    let local = ms + zone.offset_ms(ms);
    let day = CivilDate::from_days_since_epoch(local.div_euclid(86_400_000));
    let rest = local.rem_euclid(86_400_000) / 1000;
    format!(
        "{}T{:02}{:02}{:02}",
        day.key().replace('-', ""),
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

/// `timeLines`: DATE values for an all-day item (its local days on this
/// device, §6 CL074), the item's zone when the shell resolved it, else UTC.
fn time_lines(event: &Value, zone: Option<&CalendarZone>, device: &dyn LocalZone) -> Vec<String> {
    let start = event["startAt"].as_str().unwrap_or("");
    let end = event["endAt"].as_str();
    let Some(start_ms) = instants::to_epoch_ms(start) else {
        return Vec::new();
    };
    if event["isAllDay"].as_bool().unwrap_or(false) {
        let first = crate::domain::calendar_items::zone::local_date(device, start_ms);
        let last_exclusive = end
            .and_then(instants::to_epoch_ms)
            .map(|ms| crate::domain::calendar_items::zone::local_date(device, ms))
            .filter(|d| d.days_since_epoch() > first.days_since_epoch())
            .unwrap_or_else(|| first.add_days(1));
        return vec![
            format!("DTSTART;VALUE=DATE:{}", first.key().replace('-', "")),
            format!("DTEND;VALUE=DATE:{}", last_exclusive.key().replace('-', "")),
        ];
    }
    let end_ms = end.and_then(instants::to_epoch_ms);
    match zone {
        Some(zone) if zone.identifier != "UTC" && zone.identifier != "Etc/UTC" => {
            let id = &zone.identifier;
            let mut lines = vec![format!("DTSTART;TZID={id}:{}", wall_stamp(start_ms, zone))];
            if let Some(end_ms) = end_ms {
                lines.push(format!("DTEND;TZID={id}:{}", wall_stamp(end_ms, zone)));
            }
            lines
        }
        _ => {
            let mut lines = vec![format!("DTSTART:{}", stamp(start_ms))];
            if let Some(end_ms) = end_ms {
                lines.push(format!("DTEND:{}", stamp(end_ms)));
            }
            lines
        }
    }
}

fn attendee_lines(attendees: &[Value]) -> Vec<String> {
    let quote = |v: &str| {
        if v.contains([';', ':', ',', '"']) {
            format!("\"{}\"", v.replace('"', "'"))
        } else {
            v.to_owned()
        }
    };
    attendees
        .iter()
        .flat_map(|a| {
            let email = a["email"].as_str().unwrap_or("");
            let name = a["displayName"].as_str();
            let partstat = match a["responseStatus"].as_str() {
                Some("accepted") => Some("ACCEPTED"),
                Some("declined") => Some("DECLINED"),
                Some("tentative") => Some("TENTATIVE"),
                Some(_) => Some("NEEDS-ACTION"),
                None => None,
            };
            let mut params: Vec<String> = Vec::new();
            if let Some(name) = name {
                params.push(format!("CN={}", quote(name)));
            }
            if let Some(p) = partstat {
                params.push(format!("PARTSTAT={p}"));
            }
            params.push(format!(
                "ROLE={}",
                if a["optional"].as_bool() == Some(true) {
                    "OPT-PARTICIPANT"
                } else {
                    "REQ-PARTICIPANT"
                }
            ));
            let line = format!("ATTENDEE;{}:mailto:{email}", params.join(";"));
            if a["organizer"].as_bool() == Some(true) {
                let organizer = match name {
                    Some(name) => format!("ORGANIZER;CN={}:mailto:{email}", quote(name)),
                    None => format!("ORGANIZER:mailto:{email}"),
                };
                vec![organizer, line]
            } else {
                vec![line]
            }
        })
        .collect()
}

fn meaningful(vevent: &Component) -> String {
    MEANINGFUL
        .iter()
        .map(|name| {
            vevent
                .all(name)
                .map(|p| p.to_line())
                .collect::<Vec<_>>()
                .join("|")
        })
        .collect::<Vec<_>>()
        .join("||")
}

/// `applyOwnedFields`.
fn apply_owned(
    vevent: &mut Component,
    event: &Value,
    zone: Option<&CalendarZone>,
    device: &dyn LocalZone,
    owns_recurrence: bool,
    now_ms: i64,
) {
    let before = meaningful(vevent);
    vevent.set_text("SUMMARY", event["title"].as_str());
    vevent.set_text("DESCRIPTION", event["description"].as_str());
    vevent.set_text("LOCATION", event["location"].as_str());
    vevent.set_lines(
        &["DTSTART", "DTEND", "DURATION"],
        &time_lines(event, zone, device),
    );
    let recurrence: Vec<String> = event["recurrence"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|line| {
            let upper = line.to_ascii_uppercase();
            ["RRULE:", "RRULE;", "EXDATE:", "EXDATE;", "RDATE:", "RDATE;"]
                .iter()
                .any(|p| upper.starts_with(p))
        })
        .map(str::to_owned)
        .collect();
    if owns_recurrence || !recurrence.is_empty() {
        vevent.set_lines(&["RRULE", "EXDATE", "RDATE"], &recurrence);
    }
    if let Some(attendees) = event["attendees"].as_array().filter(|a| !a.is_empty()) {
        vevent.set_lines(&["ATTENDEE", "ORGANIZER"], &attendee_lines(attendees));
    }
    if let Some(reminders) = event["reminders"].as_object()
        && reminders.get("useDefault").and_then(Value::as_bool) == Some(false)
    {
        vevent.children.retain(|c| c.name != "VALARM");
        for minutes in reminders
            .get("overrides")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let minutes = minutes["minutes"].as_f64().unwrap_or(0.0).round().max(0.0);
            let alarm = format!(
                "BEGIN:VCALENDAR\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT{minutes}M\r\nEND:VALARM\r\nEND:VCALENDAR\r\n"
            );
            if let Ok(root) = parse_calendar(&alarm) {
                vevent.children.extend(root.children);
            }
        }
    }
    if let Some(visibility) = event["visibility"].as_str() {
        let class = match visibility {
            "public" => Some("PUBLIC"),
            "private" => Some("PRIVATE"),
            "confidential" => Some("CONFIDENTIAL"),
            _ => None,
        };
        vevent.set_text("CLASS", class);
    }
    match event["colorId"].as_str().and_then(color_name) {
        Some(name) => vevent.set_text("COLOR", Some(name)),
        None if event["colorId"].is_null() => {
            let known = vevent
                .text("COLOR")
                .map(|c| c.to_ascii_lowercase())
                .is_some_and(|c| {
                    [
                        "tomato",
                        "lightcoral",
                        "darkorange",
                        "gold",
                        "mediumseagreen",
                        "seagreen",
                        "deepskyblue",
                        "royalblue",
                        "mediumpurple",
                        "darkviolet",
                        "gray",
                    ]
                    .contains(&c.as_str())
                });
            if known {
                vevent.remove("COLOR");
            }
        }
        None => {}
    }
    if before != meaningful(vevent) {
        let sequence = vevent
            .text("SEQUENCE")
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        vevent.set_lines(&["SEQUENCE"], &[format!("SEQUENCE:{}", sequence + 1)]);
    }
    vevent.set_lines(
        &["DTSTAMP", "LAST-MODIFIED"],
        &[
            format!("DTSTAMP:{}", stamp(now_ms)),
            format!("LAST-MODIFIED:{}", stamp(now_ms)),
        ],
    );
}

/// `ensureTimezone`: a VTIMEZONE for the event's zone when the object lacks
/// one, from the zone's transitions (desktop `buildVTimezone`).
fn ensure_timezone(root: &mut Component, event: &Value, zone: Option<&CalendarZone>) {
    let Some(zone) = zone.filter(|z| z.identifier != "UTC" && z.identifier != "Etc/UTC") else {
        return;
    };
    if event["isAllDay"].as_bool().unwrap_or(false) {
        return;
    }
    if root
        .children_named("VTIMEZONE")
        .any(|tz| tz.text("TZID").as_deref() == Some(zone.identifier.as_str()))
    {
        return;
    }
    let offset = |ms: i64| {
        let minutes = ms / 60_000;
        let sign = if minutes < 0 { '-' } else { '+' };
        format!("{sign}{:02}{:02}", minutes.abs() / 60, minutes.abs() % 60)
    };
    let mut text = format!(
        "BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:{}\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:{}\r\nTZOFFSETTO:{}\r\nEND:STANDARD\r\n",
        zone.identifier,
        offset(zone.base_offset_ms),
        offset(zone.base_offset_ms)
    );
    let mut previous = zone.base_offset_ms;
    for transition in &zone.transitions {
        let kind = if transition.offset_ms > previous {
            "DAYLIGHT"
        } else {
            "STANDARD"
        };
        let local = transition.at_ms + previous;
        let day = CivilDate::from_days_since_epoch(local.div_euclid(86_400_000));
        let rest = local.rem_euclid(86_400_000) / 1000;
        text.push_str(&format!(
            "BEGIN:{kind}\r\nDTSTART:{}T{:02}{:02}{:02}\r\nTZOFFSETFROM:{}\r\nTZOFFSETTO:{}\r\nEND:{kind}\r\n",
            day.key().replace('-', ""),
            rest / 3600,
            rest / 60 % 60,
            rest % 60,
            offset(previous),
            offset(transition.offset_ms)
        ));
        previous = transition.offset_ms;
    }
    text.push_str("END:VTIMEZONE\r\nEND:VCALENDAR\r\n");
    if let Ok(parsed) = parse_calendar(&text) {
        let at = root
            .children
            .iter()
            .position(|c| c.name == "VEVENT")
            .unwrap_or(root.children.len());
        for (offset, child) in parsed.children.into_iter().enumerate() {
            root.children.insert(at + offset, child);
        }
    }
}

/// `eventToICalendar`: a new object for a Memry item.
pub fn new_object(
    event: &Value,
    uid: &str,
    zone: Option<&CalendarZone>,
    device: &dyn LocalZone,
    now_ms: i64,
) -> String {
    let mut root = Component {
        name: "VCALENDAR".to_owned(),
        ..Component::default()
    };
    root.set_lines(&[], &["VERSION:2.0".to_owned(), format!("PRODID:{PRODID}")]);
    let mut vevent = Component {
        name: "VEVENT".to_owned(),
        ..Component::default()
    };
    vevent.set_lines(
        &[],
        &[
            format!("UID:{uid}"),
            format!("DTSTAMP:{}", stamp(now_ms)),
            format!("CREATED:{}", stamp(now_ms)),
            "SEQUENCE:0".to_owned(),
        ],
    );
    vevent.set_text(MEMRY_SOURCE, event["sourceId"].as_str());
    vevent.set_text(MEMRY_SOURCE_TYPE, event["sourceType"].as_str());
    apply_owned(&mut vevent, event, zone, device, true, now_ms);
    vevent.set_lines(&["SEQUENCE"], &["SEQUENCE:0".to_owned()]);
    ensure_timezone(&mut root, event, zone);
    root.children.push(vevent);
    root.to_text()
}

/// `patchICalendar`. With an occurrence (its recurrence id as epoch ms), the
/// change lands on that occurrence's override, created from the master when
/// the object has none yet; otherwise on the series master.
pub fn patch_object(
    raw: &str,
    event: &Value,
    zone: Option<&CalendarZone>,
    device: &dyn LocalZone,
    occurrence: Option<(i64, &IcalZones)>,
    now_ms: i64,
) -> Result<String, NotACalendar> {
    let mut root = parse_calendar(raw)?;
    let master_at = root
        .children
        .iter()
        .position(|c| c.name == "VEVENT" && !c.has("RECURRENCE-ID"));
    let owns = master_at.is_some_and(|i| root.children[i].has(MEMRY_SOURCE));
    let target = match occurrence {
        None => master_at.ok_or(NotACalendar)?,
        Some((rid_ms, zones)) => {
            let times = ObjectTimes::new(&root, zones);
            match root
                .children
                .iter()
                .position(|c| c.name == "VEVENT" && times.overrides(c, rid_ms))
            {
                Some(at) => at,
                None => {
                    let master = &root.children[master_at.ok_or(NotACalendar)?];
                    let mut copy = master.clone();
                    for name in ["RRULE", "EXDATE", "RDATE"] {
                        copy.remove(name);
                    }
                    copy.children.retain(|c| c.name != "VALARM");
                    let line = times.line("RECURRENCE-ID", &root, master, rid_ms);
                    copy.set_lines(&[], &[line]);
                    root.children.push(copy);
                    root.children.len() - 1
                }
            }
        }
    };
    let owns_recurrence = owns && occurrence.is_none();
    let vevent = &mut root.children[target];
    if occurrence.is_some() {
        // An override never carries the series' rule (`isOverride`).
        let mut plain = event.clone();
        plain["recurrence"] = Value::Null;
        apply_owned(vevent, &plain, zone, device, owns_recurrence, now_ms);
    } else {
        apply_owned(vevent, event, zone, device, owns_recurrence, now_ms);
    }
    ensure_timezone(&mut root, event, zone);
    Ok(root.to_text())
}

/// `excludeOccurrence`: EXDATE on the master, the occurrence's override
/// dropped, the series kept.
pub fn exclude_occurrence(
    raw: &str,
    rid_ms: i64,
    zones: &IcalZones,
    now_ms: i64,
) -> Result<String, NotACalendar> {
    let mut root = parse_calendar(raw)?;
    let times = ObjectTimes::new(&root, zones);
    root.children
        .retain(|c| !(c.name == "VEVENT" && times.overrides(c, rid_ms)));
    let at = root
        .children
        .iter()
        .position(|c| c.name == "VEVENT" && !c.has("RECURRENCE-ID"))
        .ok_or(NotACalendar)?;
    let line = times.line("EXDATE", &root, &root.children[at], rid_ms);
    let master = &mut root.children[at];
    let sequence = master
        .text("SEQUENCE")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    master.set_lines(&[], &[line]);
    master.set_lines(&["SEQUENCE"], &[format!("SEQUENCE:{}", sequence + 1)]);
    master.set_lines(&["DTSTAMP"], &[format!("DTSTAMP:{}", stamp(now_ms))]);
    Ok(root.to_text())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::calendar_items::ical::{IcalWindow, IcalZones, parse_feed};
    use crate::domain::calendar_items::zone::FixedZone;
    use serde_json::json;
    use std::collections::HashMap;

    fn utc() -> CalendarZone {
        CalendarZone {
            identifier: "UTC".into(),
            base_offset_ms: 0,
            transitions: vec![],
        }
    }

    #[test]
    fn a_new_object_reads_back_as_the_same_event() {
        let event = json!({
            "sourceType": "event", "sourceId": "e1", "title": "[agent] Plan; review, sync",
            "description": "Line one\nLine two", "location": null,
            "startAt": "2026-03-10T09:00:00.000Z", "endAt": "2026-03-10T10:30:00.000Z",
            "isAllDay": false, "timezone": "UTC", "recurrence": ["RRULE:FREQ=WEEKLY;COUNT=2"],
            "colorId": "11"
        });
        let text = new_object(&event, "uid-1", None, &FixedZone(0), 1_773_000_000_000);
        assert!(text.contains("X-MEMRY-SOURCE-ID:e1") && text.contains("COLOR:tomato"));
        let zones = IcalZones {
            named: HashMap::new(),
            local: utc(),
        };
        let window = IcalWindow {
            start_ms: 1_772_000_000_000,
            end_ms: 1_775_000_000_000,
        };
        let feed = parse_feed(&text, window, &zones).expect("parses");
        assert_eq!(feed.events.len(), 2);
        assert_eq!(feed.events[0].title, "[agent] Plan; review, sync");
        assert_eq!(
            feed.events[0].description.as_deref(),
            Some("Line one\nLine two")
        );
        assert_eq!(
            feed.events[0].end_at.as_deref(),
            Some("2026-03-10T10:30:00.000Z")
        );
    }

    #[test]
    fn a_patch_keeps_foreign_properties_and_bumps_the_sequence() {
        let raw = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSEQUENCE:3\r\nX-SERVER-THING:keep\r\nSUMMARY:Old\r\nDTSTART:20260310T090000Z\r\nDTEND:20260310T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let event = json!({"sourceType": "event", "sourceId": "e1", "title": "New", "startAt": "2026-03-10T11:00:00.000Z", "endAt": "2026-03-10T12:00:00.000Z", "isAllDay": false, "timezone": "UTC"});
        let text =
            patch_object(raw, &event, None, &FixedZone(0), None, 1_773_000_000_000).expect("patch");
        assert!(text.contains("X-SERVER-THING:keep"));
        assert!(text.contains("SUMMARY:New") && text.contains("SEQUENCE:4"));
        assert!(text.contains("DTSTART:20260310T110000Z"));
    }

    #[test]
    fn an_all_day_item_writes_its_local_days() {
        // Istanbul: local midnight Oct 12 is 21:00Z on Oct 11.
        let event = json!({"sourceType": "task", "sourceId": "t", "title": "Day", "startAt": "2026-10-11T21:00:00.000Z", "endAt": "2026-10-12T21:00:00.000Z", "isAllDay": true, "timezone": "Europe/Istanbul"});
        let text = new_object(&event, "u", None, &FixedZone(3 * 3_600_000), 0);
        assert!(
            text.contains("DTSTART;VALUE=DATE:20261012")
                && text.contains("DTEND;VALUE=DATE:20261013"),
            "{text}"
        );
    }
}
