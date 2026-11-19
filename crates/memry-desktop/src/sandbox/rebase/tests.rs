use std::borrow::Cow;

use chrono::{DateTime, FixedOffset, NaiveDate, Utc};
use serde_json::json;

use super::Rebase;
use crate::sandbox::Manifest;

const TEMPLATE_DATE: (i32, u32, u32) = (2026, 1, 14);

fn day(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
}

fn at(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text)
        .unwrap()
        .with_timezone(&Utc)
}

fn template() -> NaiveDate {
    let (y, m, d) = TEMPLATE_DATE;
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

fn utc(now: &str) -> Rebase<Utc> {
    Rebase::new(template(), at(now), Utc)
}

fn plus3(now: &str) -> Rebase<FixedOffset> {
    Rebase::new(
        template(),
        at(now),
        FixedOffset::east_opt(3 * 3600).unwrap(),
    )
}

#[test]
fn delta_is_days_from_template_date_to_local_today() {
    assert_eq!(utc("2026-01-20T12:00:00Z").delta_days(), 6);
    // 22:00 UTC is already the next day at +03:00.
    assert_eq!(plus3("2026-01-20T22:00:00Z").delta_days(), 7);
    assert_eq!(utc("2026-01-10T00:00:00Z").delta_days(), -4);
}

#[test]
fn dates_move_by_delta() {
    let rebase = utc("2026-01-20T12:00:00Z");
    assert_eq!(rebase.date(day("2026-01-15")), day("2026-01-21"));
    assert_eq!(rebase.date(day("2025-12-01")), day("2025-12-07"));
    assert_eq!(rebase.text("due 2026-01-14."), "due 2026-01-20.");
}

#[test]
fn past_years_keep_their_anniversary_across_leap_days() {
    // 2028-03-01 is a Wednesday, as is the template's 2026-01-14.
    let rebase = utc("2028-03-01T12:00:00Z");
    assert_eq!(rebase.date(day("2026-01-13")), day("2028-02-29"));
    // One year back from 2028-02-29 is 2027-02-28 (shiftJournalYear), not 2027-03-01.
    assert_eq!(rebase.date(day("2025-01-13")), day("2027-02-28"));
    assert_eq!(rebase.date(day("2025-01-14")), day("2027-03-01"));
    assert_eq!(rebase.date(day("2023-01-14")), day("2025-03-01"));
    assert_eq!(
        rebase.text("journal/2025-01-13.md"),
        "journal/2027-02-28.md"
    );
}

#[test]
fn content_dates_outside_the_window_stay() {
    let rebase = utc("2026-03-04T12:00:00Z");
    let url = "Earthrise_AS08-14-2383_Apollo_8_1968-12-24.jpg";
    assert!(matches!(rebase.text(url), Cow::Borrowed(_)));
    assert_eq!(rebase.text("1969-07-20T20:17:40Z"), "1969-07-20T20:17:40Z");
    assert_eq!(rebase.text("2019-01-01"), "2019-01-01");
}

#[test]
fn non_dates_and_digit_runs_stay() {
    let rebase = utc("2026-03-04T12:00:00Z");
    for text in [
        "12026-01-14",
        "2026-01-145",
        "2026-02-30",
        "2026-13-01",
        "no dates",
    ] {
        assert!(matches!(rebase.text(text), Cow::Borrowed(_)), "{text}");
    }
}

#[test]
fn instants_keep_wall_time_in_the_device_zone() {
    let rebase = plus3("2026-01-20T12:00:00Z");
    assert_eq!(
        rebase.text("2026-01-15T09:00:00.000Z"),
        "2026-01-21T06:00:00.000Z"
    );
    assert_eq!(rebase.text("2026-01-15T09:00:00Z"), "2026-01-21T06:00:00Z");
    // SQLite's `datetime('now')` shape is UTC without a zone letter.
    assert_eq!(rebase.text("2026-01-15 09:00:00"), "2026-01-21 06:00:00");
    // A floating wall time only changes day.
    assert_eq!(rebase.text("2026-01-15T09:00:00"), "2026-01-21T09:00:00");
}

#[test]
fn utc_rebase_by_zero_days_changes_nothing() {
    let rebase = utc("2026-01-14T23:59:00Z");
    for text in [
        "2026-01-14",
        "2025-01-13",
        "2026-01-15T09:00:00.000Z",
        "2026-01-15 09:00:00",
    ] {
        assert!(matches!(rebase.text(text), Cow::Borrowed(_)), "{text}");
    }
}

#[test]
fn date_mention_tokens_rebase_their_payload() {
    // btoa('{"anchorId":"dm_journal-2026-01-14_1","dateISO":"2026-01-16T14:00:00.000Z","hasTime":true}')
    // with `,`/`;` for `+`/`/` and no padding, as packages/shared/src/date-mention.ts encodes it.
    let before = "Review ((date:eyJhbmNob3JJZCI6ImRtX2pvdXJuYWwtMjAyNi0wMS0xNF8xIiwiZGF0ZUlTTyI6IjIwMjYtMDEtMTZUMTQ6MDA6MDAuMDAwWiIsImhhc1RpbWUiOnRydWV9)) then";
    let after = "Review ((date:eyJhbmNob3JJZCI6ImRtX2pvdXJuYWwtMjAyNi0wMS0yMF8xIiwiZGF0ZUlTTyI6IjIwMjYtMDEtMjJUMTQ6MDA6MDAuMDAwWiIsImhhc1RpbWUiOnRydWV9)) then";
    assert_eq!(utc("2026-01-20T12:00:00Z").text(before), after);
    assert!(matches!(
        utc("2026-01-14T12:00:00Z").text(before),
        Cow::Borrowed(_)
    ));
}

#[test]
fn json_documents_inside_values_rebase() {
    let mut value =
        json!({ "repeat": "{\"createdAt\":\"2026-01-10T10:00:00.000Z\",\"interval\":1}" });
    utc("2026-01-15T12:00:00Z").value(&mut value);
    assert_eq!(
        value,
        json!({ "repeat": "{\"createdAt\":\"2026-01-11T10:00:00.000Z\",\"interval\":1}" })
    );
}

#[test]
fn all_day_events_keep_utc_midnight() {
    let mut manifest: Manifest = serde_json::from_value(json!({
        "version": 1,
        "generatedAt": "2026-01-14T12:00:00.000Z",
        "timezone": "UTC",
        "assets": [{ "path": "journal-2026-01-14/a.jpg", "asset": "a.jpg", "sha256": "0" }],
        "data": { "calendar_events": [
            { "id": "a", "is_all_day": 1, "start_at": "2026-01-16T00:00:00.000Z", "end_at": "2026-01-17T00:00:00.000Z" },
            { "id": "b", "is_all_day": 0, "start_at": "2026-01-16T09:00:00.000Z", "end_at": "2026-01-16T10:00:00.000Z" }
        ] },
        "index": {}
    }))
    .unwrap();
    plus3("2026-01-20T12:00:00Z").manifest(&mut manifest);
    let rows = &manifest.data["calendar_events"];
    assert_eq!(rows[0]["start_at"], "2026-01-22T00:00:00.000Z");
    assert_eq!(rows[0]["end_at"], "2026-01-23T00:00:00.000Z");
    assert_eq!(rows[1]["start_at"], "2026-01-22T06:00:00.000Z");
    assert_eq!(rows[1]["id"], "b");
    assert_eq!(manifest.assets[0].path, "journal-2026-01-20/a.jpg");
}

#[test]
fn monthly_tasks_stay_on_their_day_of_the_month() {
    let mut manifest: Manifest = serde_json::from_value(json!({
        "version": 1,
        "generatedAt": "2026-01-14T12:00:00.000Z",
        "timezone": "UTC",
        "assets": [],
        "data": { "tasks": [
            { "id": "rent", "due_date": "2026-02-01", "repeat_config": "{\"frequency\":\"monthly\",\"interval\":1,\"dayOfMonth\":1}" },
            { "id": "late", "due_date": "2026-02-01", "repeat_config": "{\"frequency\":\"monthly\",\"interval\":1,\"dayOfMonth\":31}" },
            { "id": "week", "due_date": "2026-01-19", "repeat_config": "{\"frequency\":\"weekly\",\"interval\":1}" }
        ] },
        "index": {}
    }))
    .unwrap();
    utc("2028-03-01T12:00:00Z").manifest(&mut manifest);
    let rows = &manifest.data["tasks"];
    assert_eq!(rows[0]["due_date"], "2028-04-01");
    // April has 30 days: JavaScript's Date rolls day 31 into May 1.
    assert_eq!(rows[1]["due_date"], "2028-05-01");
    assert_eq!(rows[2]["due_date"], "2028-03-06");
}
