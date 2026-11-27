//! `rruleToRepeatConfig` (`packages/importers/src/ticktick/rrule.ts`).

use std::collections::HashMap;

use memry_core::markdown::frontmatter::js_trim;

use super::super::todoist::parse_int;
use crate::import::{ImportedRepeat, MonthlyRepeat, RepeatEnd, RepeatFrequency};

/// `DAY[token.replace(/^[+-]?\d+/, '').toUpperCase()]`.
fn day_token(token: &str) -> Option<u8> {
    let rest = token.strip_prefix(['+', '-']).unwrap_or(token);
    let rest = match rest.trim_start_matches(|c: char| c.is_ascii_digit()) {
        unsigned if unsigned.len() < rest.len() => unsigned,
        _ => token,
    };
    let day = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
        .iter()
        .position(|day| *day == rest.to_uppercase())?;
    Some(day as u8)
}

/// `untilToDate`: the leading `YYYYMMDD` of the trimmed text.
fn until_to_date(until: &str) -> Option<String> {
    let digits = js_trim(until).as_bytes().get(..8)?;
    digits.iter().all(u8::is_ascii_digit).then(|| {
        let d = std::str::from_utf8(digits).expect("ASCII digits");
        format!("{}-{}-{}", &d[..4], &d[4..6], &d[6..])
    })
}

/// `parseInt(text, 10)`, which skips leading whitespace itself.
fn int(text: &str) -> f64 {
    parse_int(js_trim(text))
}

/// A TickTick RRULE as a repeat, or `None` when Memry has no such frequency. `now` is the run's
/// start, as `toISOString` writes it.
pub(super) fn rrule_to_repeat(rrule: &str, now: &str) -> Option<ImportedRepeat> {
    let body = js_trim(rrule);
    let body = match body.get(..6) {
        Some(prefix) if prefix.eq_ignore_ascii_case("RRULE:") => &body[6..],
        _ => body,
    };
    if body.is_empty() {
        return None;
    }
    let mut parts: HashMap<String, &str> = HashMap::new();
    for kv in body.split(';') {
        let mut pieces = kv.split('=');
        let key = pieces.next().unwrap_or_default();
        if !key.is_empty() {
            parts.insert(key.to_uppercase(), pieces.next().unwrap_or_default());
        }
    }
    let part = |key: &str| parts.get(key).copied().filter(|v| !v.is_empty());
    let frequency = match parts
        .get("FREQ")
        .copied()
        .unwrap_or_default()
        .to_uppercase()
        .as_str()
    {
        "DAILY" => RepeatFrequency::Daily,
        "WEEKLY" => RepeatFrequency::Weekly,
        "MONTHLY" => RepeatFrequency::Monthly,
        "YEARLY" => RepeatFrequency::Yearly,
        _ => return None,
    };
    let interval = match int(parts.get("INTERVAL").copied().unwrap_or("1")) {
        n if n.is_nan() || n == 0.0 => 1.0,
        n => n.max(1.0),
    };
    let days_of_week = match (part("BYDAY"), frequency) {
        (Some(days), RepeatFrequency::Weekly) => {
            Some(days.split(',').filter_map(day_token).collect())
        }
        _ => None,
    };
    let monthly = match (part("BYMONTHDAY"), part("BYDAY"), part("BYSETPOS")) {
        _ if frequency != RepeatFrequency::Monthly => None,
        (Some(day), _, _) => Some(MonthlyRepeat::DayOfMonth(int(day))),
        (None, Some(day), Some(pos)) => Some(MonthlyRepeat::WeekPattern {
            week_of_month: int(pos),
            day_of_week: day_token(day),
        }),
        _ => None,
    };
    let end = if let Some(count) = part("COUNT") {
        RepeatEnd::Count(int(count))
    } else {
        part("UNTIL")
            .and_then(until_to_date)
            .map_or(RepeatEnd::Never, RepeatEnd::Date)
    };
    Some(ImportedRepeat {
        frequency,
        interval,
        days_of_week,
        monthly,
        end,
        created_at: now.to_owned(),
    })
}
