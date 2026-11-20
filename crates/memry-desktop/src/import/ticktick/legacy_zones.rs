//! Zone names `Intl.DateTimeFormat` takes that jiff's bundled tzdb lacks. ICU keeps names tzdata
//! dropped (`US/Pacific-New`, `Canada/East-Saskatchewan`, the `SystemV/*` zones) and Java's
//! three-letter ids (`PST`, `IST`). Without an entry here such a zone reads as UTC and a timed
//! task shifts by the zone's offset.
//!
//! An alias is the zone ICU resolves the name to; each was compared with Node's ICU for every day
//! from 1900 to 2099. The `SystemV/*` zones with daylight time are not aliases: ICU gives them
//! tzdata's old `SystemV` rule, which no modern zone follows. A zone is on standard time before
//! 02:00 on 1902-04-27, in every earlier year. From then on daylight time runs from the last
//! Sunday of April to the last Sunday of October at 02:00, except in 1974 (January 6 to the last
//! Sunday of November) and 1975 (February 23 to the last Sunday of October). [`system_v_offset`]
//! is that rule. It was compared with Electron 43.1.1 (ICU 78.2) at every transition from 1800
//! to 2400, to the second, and at instants spread over the whole range of a JS Date, with no
//! difference. No difference from ICU is known for any name here.

use jiff::Timestamp;
use jiff::civil::{Weekday, date};
use jiff::tz::{Offset, TimeZone};

/// The first year of the `SystemV` rule in ICU.
const SYSTEM_V_FIRST_YEAR: i16 = 1902;

const ALIASES: [(&str, &str); 34] = [
    ("ACT", "Australia/Darwin"),
    ("AET", "Australia/Sydney"),
    ("AGT", "America/Buenos_Aires"),
    ("ART", "Africa/Cairo"),
    ("AST", "America/Anchorage"),
    ("BET", "America/Sao_Paulo"),
    ("BST", "Asia/Dhaka"),
    ("CAT", "Africa/Maputo"),
    ("CNT", "America/St_Johns"),
    ("CST", "America/Chicago"),
    ("CTT", "Asia/Shanghai"),
    ("EAT", "Africa/Nairobi"),
    ("ECT", "Europe/Paris"),
    ("IET", "America/Indianapolis"),
    ("IST", "Asia/Calcutta"),
    ("JST", "Asia/Tokyo"),
    ("MIT", "Pacific/Apia"),
    ("NET", "Asia/Yerevan"),
    ("NST", "Pacific/Auckland"),
    ("PLT", "Asia/Karachi"),
    ("PNT", "America/Phoenix"),
    ("PRT", "America/Puerto_Rico"),
    ("PST", "America/Los_Angeles"),
    ("SST", "Pacific/Guadalcanal"),
    ("VST", "Asia/Saigon"),
    ("US/Pacific-New", "America/Los_Angeles"),
    ("Canada/East-Saskatchewan", "America/Regina"),
    ("SystemV/AST4", "Etc/GMT+4"),
    ("SystemV/CST6", "Etc/GMT+6"),
    ("SystemV/EST5", "Etc/GMT+5"),
    ("SystemV/HST10", "Etc/GMT+10"),
    ("SystemV/MST7", "Etc/GMT+7"),
    ("SystemV/PST8", "Etc/GMT+8"),
    ("SystemV/YST9", "Etc/GMT+9"),
];

/// Each zone with its standard time's hours west of UTC.
const SYSTEM_V_DST: [(&str, i8); 6] = [
    ("SystemV/AST4ADT", 4),
    ("SystemV/CST6CDT", 6),
    ("SystemV/EST5EDT", 5),
    ("SystemV/MST7MDT", 7),
    ("SystemV/PST8PDT", 8),
    ("SystemV/YST9YDT", 9),
];

/// The offset ICU gives the zone `name` at `at`, for a name jiff's tzdb lacks; ICU matches ids
/// without regard to case.
pub(super) fn legacy_offset(name: &str, at: Timestamp) -> Option<Offset> {
    if let Some((_, target)) = ALIASES
        .iter()
        .find(|(alias, _)| alias.eq_ignore_ascii_case(name))
    {
        return Some(
            jiff::tz::db()
                .get(target)
                .expect("an alias names a tzdb zone")
                .to_offset(at),
        );
    }
    SYSTEM_V_DST
        .iter()
        .find(|(alias, _)| alias.eq_ignore_ascii_case(name))
        .map(|(_, west)| system_v_offset(*west, at))
}

/// The offset of a `SystemV/*` zone with daylight time at `at`, standard time `west` hours west
/// of UTC.
fn system_v_offset(west: i8, at: Timestamp) -> Offset {
    let standard = Offset::constant(-west);
    let wall = at.to_zoned(TimeZone::fixed(standard)).datetime();
    let year = wall.year();
    let last_sunday = |month| {
        date(year, month, 1)
            .nth_weekday_of_month(-1, Weekday::Sunday)
            .expect("a month has a last Sunday")
    };
    let (start, end) = match year {
        1974 => (date(1974, 1, 6), last_sunday(11)),
        1975 => (date(1975, 2, 23), last_sunday(10)),
        _ => (last_sunday(4), last_sunday(10)),
    };
    // The rule ends at 02:00 daylight time, which is 01:00 on the standard-time wall clock.
    let daylight =
        year >= SYSTEM_V_FIRST_YEAR && start.at(2, 0, 0, 0) <= wall && wall < end.at(1, 0, 0, 0);
    if daylight {
        Offset::constant(1 - west)
    } else {
        standard
    }
}
