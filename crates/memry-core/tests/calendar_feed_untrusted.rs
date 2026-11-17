//! A subscribed feed is untrusted input of up to 20 MiB (the shell's fetch
//! cap). The reader keeps nesting, work and output bounded whatever it gets:
//! depth on a 2 MiB stack, steps counted by `ical::budget::visits`, the
//! instances' bytes under `budget::MAX_OUTPUT_BYTES`.

use std::collections::HashMap;

use memry_core::api::calendar_records::CalendarZone;
use memry_core::domain::calendar_items::ical::budget::{self, MAX_OUTPUT_BYTES, MAX_STEPS};
use memry_core::domain::calendar_items::ical::parse::parse_calendar;
use memry_core::domain::calendar_items::ical::{
    FeedError, IcalFeed, IcalWindow, IcalZones, parse_feed, zone_ids,
};
use memry_core::domain::calendar_items::ics;
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;

const NOW: i64 = 1_773_000_000_000; // 2026-03-08

fn zones() -> IcalZones {
    IcalZones {
        named: HashMap::new(),
        local: CalendarZone {
            identifier: "UTC".into(),
            base_offset_ms: 0,
            transitions: Vec::new(),
        },
    }
}

fn window() -> IcalWindow {
    ics::window(NOW)
}

fn read(text: &str) -> Result<IcalFeed, FeedError> {
    parse_feed(text, window(), &zones())
}

fn calendar(body: &str) -> String {
    format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{body}END:VCALENDAR\r\n")
}

fn event(uid: &str, extra: &str) -> String {
    format!(
        "BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTART:20260301T090000Z\r\nDTEND:20260301T100000Z\r\nSUMMARY:{uid}\r\n{extra}END:VEVENT\r\n"
    )
}

fn text_bytes(feed: &IcalFeed) -> usize {
    feed.events
        .iter()
        .map(|e| {
            e.remote_event_id.len()
                + e.title.len()
                + e.description.as_ref().map_or(0, String::len)
                + e.location.as_ref().map_or(0, String::len)
                + e.timezone.as_ref().map_or(0, String::len)
                + budget::INSTANCE_OVERHEAD
        })
        .sum()
}

#[test]
fn deep_nesting_is_not_a_calendar_on_a_small_stack() {
    let depth = 200_000;
    let text = calendar(&format!(
        "{}{}",
        "BEGIN:X\r\n".repeat(depth),
        "END:X\r\n".repeat(depth)
    ));
    let (feed, ids) = on_small_stack(move || (read(&text).map(|_| ()), zone_ids(&text)));
    assert_eq!(feed, Err(FeedError::NotACalendar));
    assert!(ids.is_empty());
}

#[test]
fn real_nesting_still_reads() {
    let alarm = "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n";
    let feed = read(&calendar(&event("a", alarm))).expect("feed");
    assert_eq!(feed.events.len(), 1);
}

#[test]
fn parsing_visits_each_line_once() {
    let lines = 20_000;
    let text = calendar(&event("a", &"X-PAD:1\r\n".repeat(lines)));
    let total = text.matches('\n').count();
    assert_steps_at_most("parse_calendar lines", budget::visits, total + 2, || {
        parse_calendar(&text).expect("calendar");
    });
}

#[test]
fn many_long_series_stop_at_the_step_bound() {
    // Each daily series from 1900 walks 50 000 occurrences before it reaches the
    // window: 400 of them would be 20 million steps in under 40 KiB.
    let body: String = (0..400)
        .map(|n| {
            format!(
                "BEGIN:VEVENT\r\nUID:s{n}\r\nDTSTART:19000101T090000Z\r\nRRULE:FREQ=DAILY\r\nSUMMARY:x\r\nEND:VEVENT\r\n"
            )
        })
        .collect();
    let text = calendar(&body);
    let mut result = Ok(());
    assert_steps_at_most("feed expansion", budget::visits, MAX_STEPS, || {
        result = read(&text).map(|_| ());
    });
    assert_eq!(result, Err(FeedError::TooLarge));
}

#[test]
fn a_rule_whose_by_lists_multiply_is_refused_before_it_allocates() {
    // 24 x 60 x 1 000 000 times a day: 11 GB of candidates if built.
    let seconds = vec!["0"; 1_000_000].join(",");
    let hours = (0..24).map(|h| h.to_string()).collect::<Vec<_>>().join(",");
    let minutes = (0..60).map(|m| m.to_string()).collect::<Vec<_>>().join(",");
    let rule = format!("RRULE:FREQ=DAILY;BYHOUR={hours};BYMINUTE={minutes};BYSECOND={seconds}\r\n");
    let text = calendar(&event("bomb", &rule));
    assert_eq!(read(&text).map(|_| ()), Err(FeedError::TooLarge));
}

#[test]
fn a_period_with_no_days_builds_no_by_list_product() {
    // The same product, in a rule whose periods hold no day: building it once
    // per empty period is 11 GB each time, and nothing pays for it.
    let seconds = vec!["0"; 1_000_000].join(",");
    let hours = (0..24).map(|h| h.to_string()).collect::<Vec<_>>().join(",");
    let minutes = (0..60).map(|m| m.to_string()).collect::<Vec<_>>().join(",");
    for days in ["BYMONTH=13", "BYMONTH=2;BYMONTHDAY=30"] {
        let rule = format!(
            "RRULE:FREQ=DAILY;{days};BYHOUR={hours};BYMINUTE={minutes};BYSECOND={seconds}\r\n"
        );
        let text = calendar(&event("empty", &rule));
        let mut result = Ok(0);
        assert_steps_at_most(days, budget::visits, 100_000, || {
            result = read(&text).map(|feed| feed.events.len());
        });
        assert_eq!(result, Ok(1), "{days}: DTSTART alone");
    }
}

#[test]
fn occurrences_before_the_window_are_not_built() {
    // Four daily series that end before the window, each with a 64 KiB
    // description and 20 more properties: 46 000 occurrences each, none of
    // which is an instance.
    let description = "d".repeat(64 * 1024);
    let pad = "X-P:1\r\n".repeat(20);
    let body: String = (0..4)
        .map(|n| {
            format!(
                "BEGIN:VEVENT\r\nUID:old{n}\r\nDTSTART:19000101T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;UNTIL=20251201T000000Z\r\nSUMMARY:old\r\nDESCRIPTION:{description}\r\n{pad}END:VEVENT\r\n"
            )
        })
        .collect();
    let text = calendar(&body);
    let mut result = Ok(1);
    assert_steps_at_most("past occurrences", budget::visits, 4 * 50_000 * 6, || {
        result = read(&text).map(|feed| feed.events.len());
    });
    assert_eq!(result, Ok(0));
}

fn standup(uid: &str, since: &str, extra: &str) -> String {
    // A weekday standup with the 21 properties a Google or Outlook export
    // carries (attendees, organizer, stamps, conference fields).
    format!(
        "BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTART:{since}T090000Z\r\nDTEND:{since}T091500Z\r\n\
         RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\nDTSTAMP:20260301T000000Z\r\n\
         CREATED:20150101T000000Z\r\nLAST-MODIFIED:20250101T000000Z\r\nSEQUENCE:3\r\n\
         STATUS:CONFIRMED\r\nTRANSP:OPAQUE\r\nCLASS:PUBLIC\r\nSUMMARY:Standup {uid}\r\n\
         LOCATION:Room 4\r\nORGANIZER:mailto:lead@example.com\r\n\
         ATTENDEE:mailto:a@example.com\r\nATTENDEE:mailto:b@example.com\r\n\
         ATTENDEE:mailto:c@example.com\r\nATTENDEE:mailto:d@example.com\r\n\
         X-MICROSOFT-CDO-BUSYSTATUS:BUSY\r\nX-GOOGLE-CONFERENCE:https://meet.example.com/x\r\n\
         {extra}END:VEVENT\r\n"
    )
}

#[test]
fn a_team_calendar_with_long_running_standups_reads_whole() {
    // Electron imports each of these; they are what a large shared team
    // calendar looks like, not attacks.
    let since_2015: String = (0..200)
        .map(|n| standup(&format!("s{n}"), "20150105", "DESCRIPTION:daily sync\r\n"))
        .collect();
    let exdates: String = (0..150)
        .map(|n| format!("EXDATE:2016{:02}{:02}T090000Z\r\n", 1 + n % 12, 1 + n % 28))
        .collect::<String>()
        + "DESCRIPTION:daily sync\r\n";
    let with_exdates: String = (0..20)
        .map(|n| standup(&format!("x{n}"), "20150105", &exdates))
        .collect();
    let invite = format!("DESCRIPTION:{}\r\n", "Join the meeting: ".repeat(170));
    let invites: String = (0..128)
        .map(|n| standup(&format!("i{n}"), "20250106", &invite))
        .collect();
    for (what, body) in [
        ("200 standups since 2015", since_2015),
        ("20 standups with 150 EXDATEs", with_exdates),
        ("128 standups with a 3 KB invite", invites),
    ] {
        let feed = read(&calendar(&body));
        assert!(feed.is_ok(), "{what}: {:?}", feed.map(|_| ()));
    }
}

#[test]
fn a_vtimezone_of_secondly_observances_is_refused() {
    // 5 000 observances that each repeat every second: 2 000 onsets apiece
    // (10 million transitions) from a 300 KiB zone no event has to use.
    let observance = "BEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0100\r\n\
                      TZOFFSETTO:+0000\r\nRRULE:FREQ=SECONDLY\r\nEND:STANDARD\r\n";
    let zone = format!(
        "BEGIN:VTIMEZONE\r\nTZID:Bomb\r\n{}END:VTIMEZONE\r\n",
        observance.repeat(5_000)
    );
    let text = calendar(&(zone + &event("a", "")));
    assert_eq!(read(&text).map(|_| ()), Err(FeedError::TooLarge));
}

#[test]
fn long_by_lists_are_charged_per_period() {
    // One entry repeated 300 000 times: every period walks the list, and the
    // day lists walk it once per day of the month or year.
    let list = |entry: &str| vec![entry; 300_000].join(",");
    let rules = [
        format!("FREQ=SECONDLY;BYHOUR={}", list("23")),
        format!("FREQ=DAILY;BYMONTH=2;BYMONTHDAY={}", list("31")),
        format!("FREQ=WEEKLY;BYDAY={}", list("MO")),
        format!("FREQ=MONTHLY;BYDAY={}", list("MO")),
        format!("FREQ=MONTHLY;BYMONTH={}", list("13")),
        format!("FREQ=MONTHLY;BYMONTHDAY={}", list("1")),
        format!("FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY={}", list("1")),
        format!("FREQ=YEARLY;BYYEARDAY={}", list("1")),
        format!("FREQ=YEARLY;BYMONTH=3;BYDAY={}", list("MO")),
        format!("FREQ=YEARLY;BYDAY={}", list("-1MO")),
        format!("FREQ=YEARLY;BYMONTHDAY={}", list("1")),
        format!("FREQ=DAILY;BYSETPOS={}", list("1")),
    ];
    let read_whole: Vec<&str> = rules
        .iter()
        .filter(|rule| {
            let text = calendar(&event("long", &format!("RRULE:{rule}\r\n")));
            read(&text) != Err(FeedError::TooLarge)
        })
        .map(|rule| &rule[..rule.find('=').map_or(0, |i| i + 30).min(rule.len())])
        .collect();
    assert!(read_whole.is_empty(), "read past the bound: {read_whole:?}");
}

#[test]
fn properties_read_per_instance_count_toward_the_bound() {
    // 100 000 properties read again by each of a year of daily instances.
    let pad = "X-P:1\r\n".repeat(100_000);
    let text = calendar(&event("wide", &format!("RRULE:FREQ=DAILY\r\n{pad}")));
    assert_eq!(read(&text).map(|_| ()), Err(FeedError::TooLarge));
}

#[test]
fn amplified_output_is_refused() {
    // One 1 MiB description copied into every daily instance of the window.
    let description = format!("DESCRIPTION:{}\r\n", "d".repeat(1024 * 1024));
    let text = calendar(&event(
        "loud",
        &format!("RRULE:FREQ=DAILY\r\n{description}"),
    ));
    assert_eq!(read(&text).map(|_| ()), Err(FeedError::TooLarge));
}

#[test]
fn a_large_real_feed_reads_whole() {
    let body: String = (0..2_000)
        .map(|n| event(&format!("e{n}"), "DESCRIPTION:a meeting\r\n"))
        .collect::<String>()
        + &(0..200)
            .map(|n| {
                format!(
                    "BEGIN:VEVENT\r\nUID:w{n}\r\nDTSTART:20200106T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\nSUMMARY:w\r\nEND:VEVENT\r\n"
                )
            })
            .collect::<String>();
    let feed = read(&calendar(&body)).expect("a real feed reads");
    assert!(feed.events.len() > 2_000);
}

fn line() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("BEGIN:VEVENT".to_owned()),
        Just("END:VEVENT".to_owned()),
        Just("BEGIN:VTIMEZONE".to_owned()),
        Just("END:VTIMEZONE".to_owned()),
        Just("BEGIN:STANDARD".to_owned()),
        Just("END:STANDARD".to_owned()),
        Just("TZID:Z".to_owned()),
        Just("TZOFFSETFROM:+0100".to_owned()),
        Just("TZOFFSETTO:+0200".to_owned()),
        (1u32..9).prop_map(|n| format!("UID:u{n}")),
        (1900u32..2030).prop_map(|y| format!("DTSTART:{y}0301T090000Z")),
        (1900u32..2030).prop_map(|y| format!("DTSTART;TZID=Z:{y}0301T090000")),
        (1900u32..2030).prop_map(|y| format!("RECURRENCE-ID:{y}0302T090000Z")),
        (1900u32..2030).prop_map(|y| format!("EXDATE:{y}0303T090000Z,{y}0304")),
        (1900u32..2030).prop_map(|y| format!("RDATE:{y}0305T090000Z")),
        "(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)"
            .prop_map(|f| format!("RRULE:FREQ={f}")),
        "[0-9,]{0,40}"
            .prop_map(|l| format!("RRULE:FREQ=YEARLY;BYHOUR={l};BYMINUTE={l};BYSECOND={l}")),
        "[-0-9,]{0,20}".prop_map(|l| format!("RRULE:FREQ=MONTHLY;BYMONTHDAY={l};BYSETPOS={l}")),
        "[A-Z;=:,0-9-]{0,30}",
        "[ -~]{0,40}".prop_map(|v| format!("SUMMARY:{v}")),
    ]
}

proptest! {
    #![proptest_config(proptest_config(64))]

    #[test]
    fn any_feed_reads_within_its_bounds(lines in proptest::collection::vec(line(), 0..120)) {
        let text = calendar(&(lines.join("\r\n") + "\r\n"));
        let (outcome, steps) = on_small_stack(move || {
            let before = budget::visits();
            let outcome = read(&text).map(|feed| text_bytes(&feed));
            (outcome, budget::visits() - before)
        });
        prop_assert!(steps <= MAX_STEPS, "{steps} steps");
        if let Ok(bytes) = outcome {
            prop_assert!(bytes <= MAX_OUTPUT_BYTES);
        }
    }
}
