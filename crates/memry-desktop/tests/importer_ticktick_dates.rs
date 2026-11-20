//! TickTick's dates and reminders: Electron's `dates` and `duration` tests, the time zones
//! `Intl.DateTimeFormat` takes, years as `en-CA` writes them, zone-less times in the machine's
//! zone, and reminders past the Date range, which fail their file as Electron's `RangeError` did.

use jiff::tz::TimeZone;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use memry_desktop::import::ticktick::TickTickImporter;

use crate::importer_ticktick::{Run, backup, importer, preview, row, run_rows, run_with, write};

/// The `(dueDate, dueTime)` each `(Due Date, Timezone, Is All Day)` gives.
fn dues(cells: &[(&str, &str, &str)], local: Option<&str>) -> Vec<(Value, Value)> {
    let rows: Vec<String> = cells
        .iter()
        .map(|(due, zone, all_day)| {
            row(&[
                ("Due Date", due),
                ("Timezone", zone),
                ("Is All Day", all_day),
            ])
        })
        .collect();
    let run = match local {
        None => run_rows(&rows),
        Some(zone) => {
            let dir = tempfile::tempdir().unwrap();
            let path = write(dir.path(), "t.csv", &backup(&rows));
            let importer = TickTickImporter {
                local: Some(TimeZone::get(zone).unwrap()),
                ..importer()
            };
            run_with(&importer, &[path], |_| {}, CancellationToken::new())
        }
    };
    run.ops("createTask")
        .iter()
        .map(|t| (t["dueDate"].clone(), t["dueTime"].clone()))
        .collect()
}

fn due(date: &str, time: &str) -> (Value, Value) {
    let time = if time.is_empty() {
        Value::Null
    } else {
        json!(time)
    };
    (json!(date), time)
}

const NONE: (Value, Value) = (Value::Null, Value::Null);

#[test]
fn a_due_instant_splits_into_the_tasks_zone() {
    let istanbul = "2020-05-07T08:00:00+0000";
    assert_eq!(
        dues(
            &[
                (istanbul, "Europe/Istanbul", "false"),
                (istanbul, "Europe/Istanbul", "TRUE "),
                ("", "UTC", "false"),
                ("nope", "UTC", "false"),
                ("2024-02-30T00:00:00Z", "UTC", "false"),
                ("2024-02-32T00:00:00Z", "UTC", "false"),
            ],
            None
        ),
        [
            due("2020-05-07", "11:00"),
            due("2020-05-07", ""),
            NONE,
            NONE,
            due("2024-03-01", "00:00"),
            NONE
        ]
    );
}

#[test]
fn a_zone_is_what_intl_takes_and_utc_where_intl_throws() {
    let at = "2020-05-07T08:00:00Z";
    let zones = [
        "europe/istanbul",
        " US/Eastern ",
        "+0330",
        "\u{2212}0300",
        "+03",
        "-00:00",
        "+23:59",
        "",
        "Nope/Zone",
        "Factory",
        "+24:00",
        "+3",
        "+03:30:00",
        "Etc/GMT+14",
        "Etc/GMT-14",
    ];
    let cells: Vec<(&str, &str, &str)> = zones.iter().map(|z| (at, *z, "false")).collect();
    let times: Vec<Value> = dues(&cells, None)
        .into_iter()
        .map(|(_, time)| time)
        .collect();
    let want = [
        "11:00", "04:00", "11:30", "05:00", "11:00", "08:00", "07:59", "08:00", "08:00", "08:00",
        "08:00", "08:00", "08:00", "08:00", "22:00",
    ];
    assert_eq!(times, want.map(|t| json!(t)));
}

#[test]
fn years_are_written_as_intl_writes_them_and_history_and_far_rules_apply() {
    assert_eq!(
        dues(
            &[
                ("0005-03-01T00:00:00Z", "UTC", "false"),
                ("-000005-03-01T00:00:00Z", "UTC", "false"),
                ("0000-03-01T00:00:00Z", "UTC", "false"),
                ("+275760-09-13T00:00:00Z", "Asia/Tokyo", "false"),
                ("+275760-09-13T00:00:00.001Z", "UTC", "false"),
                ("1800-01-01T00:00:00Z", "Europe/Istanbul", "false"),
                ("2100-07-01T12:00:00Z", "America/New_York", "false"),
                ("+100000-07-01T12:00:00Z", "America/New_York", "false"),
                ("-100000-07-01T12:00:00Z", "America/New_York", "false"),
                ("+100000-01-01T12:00:00Z", "America/New_York", "false"),
                ("+250000-03-12T12:00:00Z", "America/New_York", "false"),
                ("+012345-11-05T05:30:00Z", "Europe/London", "false"),
            ],
            None
        ),
        [
            due("5-03-01", "00:00"),
            due("6-03-01", "00:00"),
            due("1-03-01", "00:00"),
            due("275760-09-13", "09:00"),
            NONE,
            due("1800-01-01", "01:55"),
            due("2100-07-01", "08:00"),
            due("100000-07-01", "08:00"),
            due("100001-07-01", "07:03"),
            due("100000-01-01", "07:00"),
            due("250000-03-12", "08:00"),
            due("12345-11-05", "05:30"),
        ]
    );
}

#[test]
fn a_time_without_a_zone_is_local_with_the_offset_before_a_gap_or_fold() {
    assert_eq!(
        dues(
            &[
                ("2020-03-08T02:30", "UTC", "false"),
                ("2020-11-01T01:30", "UTC", "false"),
                ("2020-05-07", "UTC", "false"),
                ("May 7 2020 08:00", "UTC", "false"),
                ("May 7 2020 08:00 GMT", "UTC", "false"),
                ("-271821-04-19T21:00", "UTC", "false"),
                ("+275760-09-12T21:00", "UTC", "false"),
            ],
            Some("America/New_York")
        ),
        [
            due("2020-03-08", "07:30"),
            due("2020-11-01", "05:30"),
            due("2020-05-07", "00:00"),
            due("2020-05-07", "12:00"),
            due("2020-05-07", "08:00"),
            due("271822-04-20", "01:56"),
            NONE,
        ]
    );
}

#[test]
fn the_start_date_is_the_all_day_date_in_the_tasks_zone() {
    let run = run_rows(&[row(&[
        ("Start Date", "2020-05-06T22:00:00+0000"),
        ("Timezone", "Europe/Istanbul"),
    ])]);
    let task = run.ops("createTask")[0];
    assert_eq!(
        (&task["startDate"], &task["dueTime"]),
        (&json!("2020-05-07"), &Value::Null)
    );
}

fn reminders(due: &str, start: &str, reminder: &str) -> Run {
    run_rows(&[row(&[
        ("Due Date", due),
        ("Start Date", start),
        ("Reminder", reminder),
    ])])
}

#[test]
fn reminders_are_iso_durations_from_the_due_or_start_date() {
    let run = reminders(
        "2999-01-02T00:00:00+0000",
        "",
        "PT0S; -PT1440M;-P0DT9H0M0S;;P1D;P;PT;P1W2DT3H4M5S",
    );
    let at: Vec<&Value> = run
        .ops("createReminder")
        .iter()
        .map(|r| &r["remindAt"])
        .collect();
    let want = [
        "2999-01-02T00:00:00.000Z",
        "2999-01-01T00:00:00.000Z",
        "2999-01-01T15:00:00.000Z",
        "2999-01-03T00:00:00.000Z",
        "2999-01-02T00:00:00.000Z",
        "2999-01-02T00:00:00.000Z",
        "2999-01-11T03:04:05.000Z",
    ];
    assert_eq!(at, want.map(|w| json!(w)).iter().collect::<Vec<_>>());
    assert!(
        run.ops("createReminder")
            .iter()
            .all(|r| r["targetId"] == "task-1")
    );

    let start = reminders("", "2999-01-02T00:00:00+0000", "-PT1H");
    assert_eq!(
        start.ops("createReminder")[0]["remindAt"],
        "2999-01-01T23:00:00.000Z"
    );
}

#[test]
fn a_reminder_in_the_past_is_skipped() {
    let run = reminders("2020-05-07T08:00:00+0000", "", "PT0S;P99999D");
    assert_eq!(run.ops("createReminder").len(), 1);
    assert_eq!((run.summary.imported, run.summary.skipped), (1, 1));
}

#[test]
fn a_reminder_without_an_anchor_or_a_duration_warns() {
    let dir = tempfile::tempdir().unwrap();
    let rows = [
        row(&[("Reminder", "PT0S")]),
        row(&[
            ("Due Date", "2999-01-01T00:00:00Z"),
            ("Reminder", "soon;P1Y"),
        ]),
    ];
    let path = write(dir.path(), "t.csv", &backup(&rows));
    let warning = |token: &str| {
        json!({
            "code": "ticktick.reminderNoAnchor",
            "message": format!("Reminder \"{token}\" skipped (no date anchor)"),
            "params": { "reminder": token },
        })
    };
    let group = &preview(&importer(), &[path])["groups"][0];
    assert_eq!(
        group["warnings"],
        json!([warning("PT0S"), warning("soon"), warning("P1Y")])
    );
    assert_eq!(group["counts"][3]["value"], 0);
}

#[test]
fn a_reminder_past_the_date_range_fails_its_file() {
    for (due, reminder) in [
        ("nope", "PT0S"),
        ("+275760-09-13T00:00:00Z", "PT1S"),
        ("2020-05-07T08:00:00Z", "P99999999999999999999W"),
        ("2020-05-07T08:00:00Z", &format!("P{}D", "9".repeat(400))),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            "t.csv",
            &backup(&[
                row(&[("Title", "a")]),
                row(&[("Due Date", due), ("Reminder", reminder)]),
            ]),
        );
        let run = run_with(
            &importer(),
            std::slice::from_ref(&path),
            |_| {},
            CancellationToken::new(),
        );
        assert!(run.writes.is_empty(), "{due} {reminder}");
        assert_eq!(run.summary.failed[0].error, "Invalid time value");
        assert_eq!(
            preview(&importer(), &[path])["groups"][0]["error"],
            json!({ "message": "Invalid time value" })
        );
    }
}

/// Names ICU accepts and jiff's tzdb lacks, one test each: the local `month-day hour:minute` that
/// Node's ICU gives for 12:00Z on 2020-07-01, 2020-01-01 and 2020-03-15. US daylight time began on
/// 03-08 and the `SystemV/*` rule begins on 04-26, so those zones are on standard time on 03-15.
mod legacy_zones {
    use super::*;

    const INSTANTS: [&str; 3] = [
        "2020-07-01T12:00:00Z",
        "2020-01-01T12:00:00Z",
        "2020-03-15T12:00:00Z",
    ];

    fn local_at(zone: &str, instants: &[&str]) -> Vec<String> {
        let cells: Vec<(&str, &str, &str)> =
            instants.iter().map(|at| (*at, zone, "false")).collect();
        dues(&cells, None)
            .into_iter()
            .map(|(date, time)| {
                format!(
                    "{} {}",
                    &date.as_str().unwrap()[5..],
                    time.as_str().unwrap()
                )
            })
            .collect()
    }

    macro_rules! zones {
        ($($test:ident $zone:literal $want:expr;)*) => {$(
            #[test]
            fn $test() {
                assert_eq!(local_at($zone, &INSTANTS), $want, $zone);
            }
        )*};
    }

    zones! {
        act "ACT" ["07-01 21:30", "01-01 21:30", "03-15 21:30"];
        aet "AET" ["07-01 22:00", "01-01 23:00", "03-15 23:00"];
        agt "AGT" ["07-01 09:00", "01-01 09:00", "03-15 09:00"];
        art "ART" ["07-01 14:00", "01-01 14:00", "03-15 14:00"];
        ast "AST" ["07-01 04:00", "01-01 03:00", "03-15 04:00"];
        bet "BET" ["07-01 09:00", "01-01 09:00", "03-15 09:00"];
        bst "BST" ["07-01 18:00", "01-01 18:00", "03-15 18:00"];
        cat "CAT" ["07-01 14:00", "01-01 14:00", "03-15 14:00"];
        cnt "CNT" ["07-01 09:30", "01-01 08:30", "03-15 09:30"];
        cst "CST" ["07-01 07:00", "01-01 06:00", "03-15 07:00"];
        ctt "CTT" ["07-01 20:00", "01-01 20:00", "03-15 20:00"];
        eat "EAT" ["07-01 15:00", "01-01 15:00", "03-15 15:00"];
        ect "ECT" ["07-01 14:00", "01-01 13:00", "03-15 13:00"];
        iet "IET" ["07-01 08:00", "01-01 07:00", "03-15 08:00"];
        ist "IST" ["07-01 17:30", "01-01 17:30", "03-15 17:30"];
        jst "JST" ["07-01 21:00", "01-01 21:00", "03-15 21:00"];
        mit "MIT" ["07-02 01:00", "01-02 02:00", "03-16 02:00"];
        net "NET" ["07-01 16:00", "01-01 16:00", "03-15 16:00"];
        nst "NST" ["07-02 00:00", "01-02 01:00", "03-16 01:00"];
        plt "PLT" ["07-01 17:00", "01-01 17:00", "03-15 17:00"];
        pnt "PNT" ["07-01 05:00", "01-01 05:00", "03-15 05:00"];
        prt "PRT" ["07-01 08:00", "01-01 08:00", "03-15 08:00"];
        pst "PST" ["07-01 05:00", "01-01 04:00", "03-15 05:00"];
        sst "SST" ["07-01 23:00", "01-01 23:00", "03-15 23:00"];
        vst "VST" ["07-01 19:00", "01-01 19:00", "03-15 19:00"];
        us_pacific_new "US/Pacific-New" ["07-01 05:00", "01-01 04:00", "03-15 05:00"];
        canada_east_saskatchewan "Canada/East-Saskatchewan" ["07-01 06:00", "01-01 06:00", "03-15 06:00"];
        systemv_ast4 "SystemV/AST4" ["07-01 08:00", "01-01 08:00", "03-15 08:00"];
        systemv_cst6 "SystemV/CST6" ["07-01 06:00", "01-01 06:00", "03-15 06:00"];
        systemv_est5 "SystemV/EST5" ["07-01 07:00", "01-01 07:00", "03-15 07:00"];
        systemv_hst10 "SystemV/HST10" ["07-01 02:00", "01-01 02:00", "03-15 02:00"];
        systemv_mst7 "SystemV/MST7" ["07-01 05:00", "01-01 05:00", "03-15 05:00"];
        systemv_pst8 "SystemV/PST8" ["07-01 04:00", "01-01 04:00", "03-15 04:00"];
        systemv_yst9 "SystemV/YST9" ["07-01 03:00", "01-01 03:00", "03-15 03:00"];
        systemv_ast4adt "SystemV/AST4ADT" ["07-01 09:00", "01-01 08:00", "03-15 08:00"];
        systemv_cst6cdt "SystemV/CST6CDT" ["07-01 07:00", "01-01 06:00", "03-15 06:00"];
        systemv_est5edt "SystemV/EST5EDT" ["07-01 08:00", "01-01 07:00", "03-15 07:00"];
        systemv_mst7mdt "SystemV/MST7MDT" ["07-01 06:00", "01-01 05:00", "03-15 05:00"];
        systemv_pst8pdt "SystemV/PST8PDT" ["07-01 05:00", "01-01 04:00", "03-15 04:00"];
        systemv_yst9ydt "SystemV/YST9YDT" ["07-01 04:00", "01-01 03:00", "03-15 03:00"];
    }

    #[test]
    fn a_legacy_zone_name_matches_without_regard_to_case() {
        let want = |zone: &str| local_at(zone, &INSTANTS);
        assert_eq!(want("us/pacific-new"), want("US/Pacific-New"));
        assert_eq!(want("pst"), want("PST"));
        assert_eq!(want("SYSTEMV/pst8pdt"), want("SystemV/PST8PDT"));
        assert_eq!(want("pst"), ["07-01 05:00", "01-01 04:00", "03-15 05:00"]);
        assert_eq!(
            want("SYSTEMV/pst8pdt"),
            ["07-01 05:00", "01-01 04:00", "03-15 04:00"]
        );
    }

    #[test]
    fn a_systemv_zone_changes_on_the_last_sundays_of_april_and_october_at_02_00() {
        let edges = [
            "2020-04-26T09:59:00Z",
            "2020-04-26T10:00:00Z",
            "2020-10-25T08:59:00Z",
            "2020-10-25T09:00:00Z",
        ];
        assert_eq!(
            local_at("SystemV/PST8PDT", &edges),
            ["04-26 01:59", "04-26 03:00", "10-25 01:59", "10-25 01:00"]
        );
        assert_eq!(
            local_at("SystemV/AST4ADT", &edges),
            ["04-26 06:59", "04-26 07:00", "10-25 04:59", "10-25 05:00"]
        );
    }
}
