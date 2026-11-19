use chrono::{Local, TimeZone};

use super::*;

/// Below 23 notes the TypeScript throws on the third link (`(index + count - 23) % count` is
/// negative); the port wraps around, so every note still links its neighbours.
#[test]
fn a_vault_under_23_notes_links_around_the_end() {
    let vault = generate(5, 42);
    assert_eq!(vault.notes.len(), 5);
    let first = &vault.notes[0];
    // (0 + 5 - 23) mod 5 = 2.
    let wrapped = format!("- [[{}]]", vault.notes[2].title);
    assert!(first.body.contains(&wrapped), "{}", first.body);
}

/// `seedPastISOAt`: a past day keeps its time; today's time still ahead of now moves back
/// before now, to the minute.
#[test]
fn seed_dates_never_land_in_the_future() {
    let now = Local.with_ymd_and_hms(2026, 3, 10, 0, 30, 20).unwrap();
    let day = now.date_naive() - TimeDelta::days(3);
    assert_eq!(
        seed_past_iso_at(-3, 16, 45, now),
        format!("{}T16:45:00.000Z", day.format("%Y-%m-%d"))
    );
    let today = seed_past_iso_at(0, 16, 45, now);
    let at = DateTime::parse_from_rfc3339(&today).unwrap();
    assert!(at <= now, "{today} is after {now}");
    // min((16 - 6) * 20 + 45, 30 minutes since midnight) = 30 minutes back, seconds dropped.
    let expected = (now - TimeDelta::minutes(30)).with_timezone(&Utc);
    assert_eq!(at.timestamp(), expected.timestamp() / 60 * 60);
}
