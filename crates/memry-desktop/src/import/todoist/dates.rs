//! `resolveDueDate` (`packages/importers/src/todoist/dates.ts`): a Todoist DATE cell as a due
//! date, English only, counted from the day the import runs.

use chrono::{Datelike, Days, NaiveDate};
use memry_core::markdown::frontmatter::{is_js_whitespace, js_trim};

use crate::import::csv_lex::step;

/// A due date, `YYYY-MM-DD`, and an optional `HH:mm` time.
pub(super) type DueDate = (String, Option<String>);

const MONTHS: [(&str, u32); 24] = [
    ("jan", 0),
    ("january", 0),
    ("feb", 1),
    ("february", 1),
    ("mar", 2),
    ("march", 2),
    ("apr", 3),
    ("april", 3),
    ("may", 4),
    ("jun", 5),
    ("june", 5),
    ("jul", 6),
    ("july", 6),
    ("aug", 7),
    ("august", 7),
    ("sep", 8),
    ("sept", 8),
    ("september", 8),
    ("oct", 9),
    ("october", 9),
    ("nov", 10),
    ("november", 10),
    ("dec", 11),
    ("december", 11),
];

const WEEKDAYS: [(&str, u32); 18] = [
    ("sun", 0),
    ("sunday", 0),
    ("mon", 1),
    ("monday", 1),
    ("tue", 2),
    ("tues", 2),
    ("tuesday", 2),
    ("wed", 3),
    ("weds", 3),
    ("wednesday", 3),
    ("thu", 4),
    ("thur", 4),
    ("thurs", 4),
    ("thursday", 4),
    ("fri", 5),
    ("friday", 5),
    ("sat", 6),
    ("saturday", 6),
];

fn lookup(table: &[(&str, u32)], key: &str) -> Option<u32> {
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| *value)
}

/// `fmt`: the year as `getFullYear` prints it, unpadded.
fn fmt(date: NaiveDate) -> String {
    format!("{}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// `new Date(y, m, d + n)`. `None` past chrono's range (year 262,143), where Electron's date
/// became invalid (`NaN-NaN-NaN`) or, up to year 275,760, one chrono cannot hold.
fn add_days(today: NaiveDate, days: f64) -> Option<NaiveDate> {
    today.checked_add_days(Days::new(days as u64))
}

/// `new Date(y, m + n, d)`: a day past the month's end rolls into the next month. `None` past
/// chrono's range, as [`add_days`].
fn add_months(today: NaiveDate, months: f64) -> Option<NaiveDate> {
    let total =
        (i64::from(today.year()) * 12 + i64::from(today.month0())).checked_add(months as i64)?;
    let first = NaiveDate::from_ymd_opt(
        i32::try_from(total.div_euclid(12)).ok()?,
        u32::try_from(total.rem_euclid(12)).ok()? + 1,
        1,
    )?;
    first.checked_add_days(Days::new(u64::from(today.day0())))
}

/// `resolveDueDate(raw, { now: today, lang })`.
pub(super) fn resolve_due_date(raw: &str, today: NaiveDate, lang: &str) -> Option<DueDate> {
    let s = js_trim(raw);
    if s.is_empty() || (!lang.is_empty() && lang.to_lowercase() != "en") {
        return None;
    }
    let lower = s.to_lowercase();
    if lower.starts_with("every ") {
        return None;
    }
    match lower.as_str() {
        "today" => return Some((fmt(today), None)),
        "tomorrow" => return Some((fmt(today.succ_opt()?), None)),
        "yesterday" => return Some((fmt(today.pred_opt()?), None)),
        _ => {}
    }
    if let Some(due) = iso(s) {
        return Some(due);
    }
    if let Some((n, unit)) = relative(&lower) {
        let date = match unit {
            "day" | "days" => add_days(today, n),
            "week" | "weeks" => add_days(today, n * 7.0),
            _ => add_months(today, n),
        }?;
        return Some((fmt(date), None));
    }
    if let Some(target) = lookup(&WEEKDAYS, &lower) {
        let delta = (target + 7 - today.weekday().num_days_from_sunday()) % 7;
        return Some((fmt(add_days(today, f64::from(delta))?), None));
    }
    named_month(&lower, today).map(|date| (date, None))
}

/// `^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?`, read as written.
fn iso(s: &str) -> Option<DueDate> {
    let b = s.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        b.get(range.clone())
            .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    };
    let dash = |at: usize| b.get(at) == Some(&b'-');
    if !(digits(0..4) && dash(4) && digits(5..7) && dash(7) && digits(8..10)) {
        return None;
    }
    let time = (matches!(b.get(10), Some(b'T' | b' '))
        && digits(11..13)
        && b.get(13) == Some(&b':')
        && digits(14..16))
    .then(|| s[11..16].to_owned());
    Some((s[..10].to_owned(), time))
}

/// `^in\s+(\d+)\s+(day|days|week|weeks|month|months)$`: the count as `parseInt` reads it.
fn relative(lower: &str) -> Option<(f64, &str)> {
    let rest = lower.strip_prefix("in")?;
    let after = rest.trim_start_matches(is_js_whitespace);
    if after.len() == rest.len() {
        return None;
    }
    let digits_end = after
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(after.len());
    let (digits, rest) = after.split_at(digits_end);
    let unit = rest.trim_start_matches(is_js_whitespace);
    if digits.is_empty() || unit.len() == rest.len() {
        return None;
    }
    matches!(unit, "day" | "days" | "week" | "weeks" | "month" | "months")
        .then(|| (digits.parse().unwrap_or(f64::INFINITY), unit))
}

/// `parseNamedMonth`: "Jun 20", "20 June", "June 20 2026", "20 Jun 2027"; without a year, the
/// next such day from today on.
fn named_month(lower: &str, today: NaiveDate) -> Option<String> {
    let (mut month, mut day, mut year) = (None, None, None);
    for token in lower
        .split(|c: char| c == ',' || is_js_whitespace(c))
        .filter(|token| !token.is_empty())
    {
        step();
        let all_digits = token.bytes().all(|b| b.is_ascii_digit());
        if let Some(m) = lookup(&MONTHS, token) {
            month = Some(m);
        } else if all_digits && token.len() == 4 {
            year = token.parse::<i32>().ok();
        } else if all_digits && token.len() <= 2 {
            day = token.parse::<u32>().ok();
        }
    }
    let (month, day) = (month?, day.filter(|d| (1..=31).contains(d))?);
    let year = match year {
        Some(year) => year,
        None => {
            let year = today.year();
            let candidate = NaiveDate::from_ymd_opt(year, month + 1, 1)?
                .checked_add_days(Days::new(u64::from(day - 1)))?;
            if candidate < today { year + 1 } else { year }
        }
    };
    Some(format!("{year}-{:02}-{day:02}", month + 1))
}
