//! Zone names `Intl.DateTimeFormat` takes that jiff's bundled tzdb lacks. ICU keeps names tzdata
//! dropped (`US/Pacific-New`, `Canada/East-Saskatchewan`, the `SystemV/*` zones) and Java's
//! three-letter ids (`PST`, `IST`). Without an entry here such a zone reads as UTC and a timed
//! task shifts by the zone's offset.
//!
//! An alias is the zone ICU resolves the name to; each was compared with Node's ICU for every day
//! from 1900 to 2099. The `SystemV/*` zones with daylight time are not aliases: ICU gives them one
//! frozen rule (the last Sunday of April to the last Sunday of October, at 02:00), which no modern
//! zone follows. Here that rule is a POSIX TZ string. It differs from ICU only in 1900 and 1901,
//! before ICU's rule starts, and in 1974 and 1975, where ICU has the energy-crisis dates.

use jiff::tz::TimeZone;

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

const SYSTEM_V_DST: [(&str, &str); 6] = [
    ("SystemV/AST4ADT", "AST4ADT,M4.5.0,M10.5.0"),
    ("SystemV/CST6CDT", "CST6CDT,M4.5.0,M10.5.0"),
    ("SystemV/EST5EDT", "EST5EDT,M4.5.0,M10.5.0"),
    ("SystemV/MST7MDT", "MST7MDT,M4.5.0,M10.5.0"),
    ("SystemV/PST8PDT", "PST8PDT,M4.5.0,M10.5.0"),
    ("SystemV/YST9YDT", "YST9YDT,M4.5.0,M10.5.0"),
];

/// The zone ICU reads `name` as, for a name jiff's tzdb lacks; ICU matches ids without regard to
/// case.
pub(super) fn legacy_zone(name: &str) -> Option<TimeZone> {
    if let Some((_, target)) = ALIASES
        .iter()
        .find(|(alias, _)| alias.eq_ignore_ascii_case(name))
    {
        return Some(
            jiff::tz::db()
                .get(target)
                .expect("an alias names a tzdb zone"),
        );
    }
    SYSTEM_V_DST
        .iter()
        .find(|(alias, _)| alias.eq_ignore_ascii_case(name))
        .map(|(_, rule)| TimeZone::posix(rule).expect("a static POSIX TZ string"))
}
