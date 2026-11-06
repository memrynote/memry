//! Inline tokens rewritten to what a reader sees (`engine-tokens.ts`). A date pill is stored
//! as `((date:<base64 JSON>))` and a link mention as `((mention:<url>))`; neither is prose, so
//! both are replaced before anything else reads the note, and hashes, sentences and Markdown
//! agree. A token that cannot be decoded is dropped, never shown raw.
//!
//! Dates format as `Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short' })`
//! does for the tags [`super::text::detect_language`] answers ([`long_date`]),
//! in the local time zone. `new Date` reads the ECMAScript date-time format here; the other
//! strings V8 also parses read as no date.

use std::sync::LazyLock;

use crate::web::extract::utils::js::trim as js_trim;
use base64::Engine as _;
use base64::alphabet::STANDARD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use chrono::{
    Datelike as _, Months, NaiveDate, NaiveDateTime, TimeDelta, TimeZone as _, Timelike as _,
};
use regex::Regex;
use serde_json::{Map, Value};

static DATE_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(\(date:([A-Za-z0-9,;_\\-]+)\)\)").expect("date token"));
static MENTION_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(\(mention:([^()\n\r]+)\)\)").expect("mention token"));
static DATE_ONLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})$").expect("date only"));
static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$",
    )
    .expect("iso date")
});

/// The zone dates are shown in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    Utc,
    /// The device's zone, as `Intl.DateTimeFormat` uses.
    Local,
}

impl Zone {
    fn local_of_utc(self, utc: NaiveDateTime) -> NaiveDateTime {
        match self {
            Self::Utc => utc,
            Self::Local => chrono::Local.from_utc_datetime(&utc).naive_local(),
        }
    }
}

/// `atob` over the token alphabet: `-`/`,` were `+`, `_`/`;` were `/`, `\` is an escaper's.
fn decode_object(encoded: &str) -> Option<Map<String, Value>> {
    let base64: String = encoded
        .chars()
        .filter(|&c| c != '\\')
        .map(|c| match c {
            '-' | ',' => '+',
            '_' | ';' => '/',
            c => c,
        })
        .collect();
    let forgiving = GeneralPurpose::new(
        &STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let bytes = forgiving.decode(base64).ok()?;
    // `atob` yields one character per byte.
    let text: String = bytes.iter().map(|&b| char::from(b)).collect();
    match serde_json::from_str(&text).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

const REMIND_OFFSETS: [&str; 11] = [
    "none", "at", "5m", "10m", "15m", "30m", "1h", "2h", "1d", "2d", "1w",
];

/// `parseDateMentionToken`, else `salvageDateMentionToken`: the date and whether it has a time.
fn date_mention(encoded: &str) -> Option<(String, bool)> {
    let obj = decode_object(encoded)?;
    let text = |key: &str| obj.get(key).and_then(Value::as_str);
    let strict = text("anchorId").is_some()
        && text("dateISO").is_some()
        && obj.get("hasTime").is_some_and(Value::is_boolean)
        && text("remind").is_some_and(|r| REMIND_OFFSETS.contains(&r));
    let date_iso = text("dateISO")?;
    if !strict && (text("anchorId").is_none_or(str::is_empty) || parse_instant(date_iso).is_none())
    {
        return None;
    }
    let has_time = obj.get("hasTime") == Some(&Value::Bool(true));
    Some((date_iso.to_owned(), has_time))
}

/// What the device's clock reads at the instant `iso` names (`new Date(iso)`); `None` when it
/// names none. A date-time without an offset is already local time.
enum Instant {
    Utc(NaiveDateTime),
    Local(NaiveDateTime),
}

fn parse_instant(iso: &str) -> Option<Instant> {
    let c = ISO.captures(iso)?;
    let num = |i: usize, default: u32| c.get(i).map_or(Some(default), |m| m.as_str().parse().ok());
    let date = NaiveDate::from_ymd_opt(c[1].parse().ok()?, num(2, 1)?, num(3, 1)?)?;
    let Some(hour) = c.get(4) else {
        return Some(Instant::Utc(date.and_hms_opt(0, 0, 0)?));
    };
    let millis = c.get(7).map_or(Some(0), |m| {
        format!("{:0<3}", &m.as_str()[..m.len().min(3)])
            .parse()
            .ok()
    })?;
    let time =
        date.and_hms_milli_opt(hour.as_str().parse().ok()?, num(5, 0)?, num(6, 0)?, millis)?;
    match c.get(8).map(|m| m.as_str()) {
        None => Some(Instant::Local(time)),
        Some("Z") => Some(Instant::Utc(time)),
        Some(offset) => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let minutes =
                offset[1..3].parse::<i64>().ok()? * 60 + offset[4..6].parse::<i64>().ok()?;
            Some(Instant::Utc(time - TimeDelta::minutes(sign * minutes)))
        }
    }
}

/// `new Date(y, m - 1, d)`: an out-of-range month or day rolls over, and years 0-99 are
/// 1900-1999.
fn local_date(y: i32, m: i64, d: i64) -> Option<NaiveDate> {
    let y = if (0..=99).contains(&y) { y + 1900 } else { y };
    let start = NaiveDate::from_ymd_opt(y, 1, 1)?;
    let start = if m >= 1 {
        start.checked_add_months(Months::new(u32::try_from(m - 1).ok()?))?
    } else {
        start.checked_sub_months(Months::new(u32::try_from(1 - m).ok()?))?
    };
    start.checked_add_signed(TimeDelta::days(d - 1))
}

fn format_date(date_iso: &str, has_time: bool, language: &str, zone: Zone) -> Option<String> {
    if let Some(c) = DATE_ONLY.captures(date_iso) {
        let date = local_date(c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?)?;
        return Some(long_date(date, None, language));
    }
    let local = match parse_instant(date_iso)? {
        Instant::Utc(utc) => zone.local_of_utc(utc),
        Instant::Local(local) => local,
    };
    let time = has_time.then_some((local.hour(), local.minute()));
    Some(long_date(local.date(), time, language))
}

const EN_MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const RU_MONTHS: [&str; 12] = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
];
const AR_MONTHS: [&str; 12] = [
    "يناير",
    "فبراير",
    "مارس",
    "أبريل",
    "مايو",
    "يونيو",
    "يوليو",
    "أغسطس",
    "سبتمبر",
    "أكتوبر",
    "نوفمبر",
    "ديسمبر",
];

/// `dateStyle: 'long'`, plus `timeStyle: 'short'` when `time` is given, as ICU 78 writes them.
pub fn long_date(date: NaiveDate, time: Option<(u32, u32)>, language: &str) -> String {
    let (y, m, d) = (date.year(), date.month(), date.day());
    let month = (m - 1) as usize;
    let h12 = |h: u32| if h.is_multiple_of(12) { 12 } else { h % 12 };
    match language {
        "ja" | "zh" => {
            let day = format!("{y}年{m}月{d}日");
            match time {
                Some((h, min)) if language == "ja" => format!("{day} {h}:{min:02}"),
                Some((h, min)) => format!("{day} {h:02}:{min:02}"),
                None => day,
            }
        }
        "ko" => {
            let day = format!("{y}년 {m}월 {d}일");
            match time {
                Some((h, min)) => {
                    let half = if h < 12 { "오전" } else { "오후" };
                    format!("{day} {half} {}:{min:02}", h12(h))
                }
                None => day,
            }
        }
        "ru" => {
            let day = format!("{d} {} {y} г.", RU_MONTHS[month]);
            match time {
                Some((h, min)) => format!("{day} в {h:02}:{min:02}"),
                None => day,
            }
        }
        "ar" => {
            let day = format!("{d} {} {y}", AR_MONTHS[month]);
            match time {
                Some((h, min)) => {
                    let half = if h < 12 { "ص" } else { "م" };
                    format!("{day} في {}:{min:02} {half}", h12(h))
                }
                None => day,
            }
        }
        // `en`, and `und` (no letters), which the runtime reads in its default locale.
        _ => {
            let day = format!("{} {d}, {y}", EN_MONTHS[month]);
            match time {
                Some((h, min)) => {
                    let half = if h < 12 { "AM" } else { "PM" };
                    format!("{day} at {}:{min:02} {half}", h12(h))
                }
                None => day,
            }
        }
    }
}

/// `decodeURIComponent`: `None` where it throws.
fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The host of a mention's URL (`new URL(...).hostname`), `""` when it is not one.
fn mention_label(encoded: &str) -> String {
    decode_uri_component(js_trim(encoded))
        .and_then(|url| url::Url::parse(&url).ok())
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default()
}

/// The note with every `((date:…))` and `((mention:…))` token replaced by its visible text.
pub fn expand_inline_tokens(markdown: &str, language: &str, zone: Zone) -> String {
    let dated = DATE_TOKEN.replace_all(markdown, |c: &regex::Captures<'_>| {
        date_mention(&c[1])
            .and_then(|(iso, has_time)| format_date(&iso, has_time, language, zone))
            .unwrap_or_default()
    });
    MENTION_TOKEN
        .replace_all(&dated, |c: &regex::Captures<'_>| mention_label(&c[1]))
        .into_owned()
}

/// The note with tokens blanked, so their payload never skews language detection.
pub fn without_inline_tokens(markdown: &str) -> String {
    let blanked = DATE_TOKEN.replace_all(markdown, " ");
    MENTION_TOKEN.replace_all(&blanked, " ").into_owned()
}
