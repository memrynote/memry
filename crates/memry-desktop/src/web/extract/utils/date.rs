//! The slice of JS `Date` the extractors and the TickTick importer use: `new Date(text)`,
//! `new Date(ms)` and `toISOString()`. [`parse_date`] reads text without a zone as UTC. JS reads
//! a zone-less date-time as local time, so the extractors' oracle generator pins `TZ=UTC`; on a
//! machine in another zone Electron's extractors disagree with this port by up to a day for such
//! text, which only the legacy (non-ISO) formats carry. [`parse_date_in`] takes the local zone.
//!
//! Supported: the ECMAScript ISO format (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, with `THH:mm[:ss[.s+]]`
//! and `Z` or `z`, or `±HH:mm` or V8's `±HHmm`), where V8 takes a day 1 to 31 in every month and
//! rolls the excess into the next (`2024-02-30` is `2024-03-01`), and V8's legacy forms of the
//! shape `[weekday,] Month D[,] YYYY [h:mm[:ss] [AM|PM] [GMT|UTC|±hhmm]]`, `D Month YYYY ...`,
//! `M/D/YYYY` and `YYYY/M/D`. Anything else is `NaN`, which V8 would sometimes still parse;
//! `tests/importer_raindrop.rs` pins the forms against node.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::error::ExtractError;

const MAX_TIME: f64 = 8.64e15;
/// V8's `kMaxTimeBeforeUTCInMs`: how far a zone-less time may reach before its local offset
/// applies, ten days past the Date range.
const MAX_LOCAL_TIME: f64 = MAX_TIME + 864e6;

/// Days since the epoch of a proleptic Gregorian date (month 1 to 12).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `MakeDate` of the fields, before `TimeClip`; `None` for a field V8 refuses.
#[allow(clippy::too_many_arguments)]
fn make_time(
    y: i64,
    mo: i64,
    d: i64,
    h: i64,
    mi: i64,
    s: i64,
    ms: i64,
    offset_min: i64,
) -> Option<f64> {
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    if h > 24 || mi > 59 || s > 59 || (h == 24 && (mi > 0 || s > 0 || ms > 0)) {
        return None;
    }
    // Past every Date either way; the bound keeps the arithmetic below in range.
    if y.abs() > 400_000 {
        return None;
    }
    let days = i128::from(days_from_civil(y, mo, d));
    let t = ((days * 24 + i128::from(h)) * 60 + i128::from(mi) - i128::from(offset_min)) * 60
        + i128::from(s);
    Some(t as f64 * 1000.0 + ms as f64)
}

/// `TimeClip`.
fn clip(t: f64) -> Option<f64> {
    (t.abs() <= MAX_TIME).then_some(t)
}

static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?)?$",
    )
    .expect("static pattern")
});

/// The time `text` names, and whether it named no zone (a date-time V8 reads as local time).
fn parse_iso(text: &str) -> Option<(f64, bool)> {
    let m = ISO.captures(text)?;
    if &m[1] == "-000000" {
        return None;
    }
    let num = |i: usize, default: i64| {
        m.get(i)
            .map_or(default, |g| g.as_str().parse().unwrap_or(default))
    };
    let ms = m.get(7).map_or(0, |g| {
        let digits: String = g.as_str().chars().chain("00".chars()).take(3).collect();
        digits.parse().unwrap_or(0)
    });
    let offset = match m.get(8).map(|g| g.as_str()) {
        Some(z) if !z.eq_ignore_ascii_case("z") => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let digits = z[1..].replace(':', "");
            let oh: i64 = digits[..2].parse().ok()?;
            let om: i64 = digits[2..].parse().ok()?;
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 60 + om)
        }
        _ => 0,
    };
    let local = m.get(4).is_some() && m.get(8).is_none();
    let t = make_time(
        num(1, 0),
        num(2, 1),
        num(3, 1),
        num(4, 0),
        num(5, 0),
        num(6, 0),
        ms,
        offset,
    )?;
    Some((t, local))
}

static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]").expect("static pattern"));
static COMMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\([^)]*\)").expect("static pattern"));

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// The legacy parser for the supported shapes (see the module docs), as [`parse_iso`].
fn parse_legacy(text: &str) -> Option<(f64, bool)> {
    let cleaned = COMMENT.replace_all(text, " ");
    let tokens: Vec<&str> = TOKEN.find_iter(&cleaned).map(|m| m.as_str()).collect();
    let (mut month, mut meridiem) = (None::<i64>, None::<&str>);
    let mut numbers: Vec<i64> = Vec::new();
    let mut time = (0i64, 0i64, 0i64, 0i64);
    let (mut has_time, mut offset, mut zoned) = (false, 0i64, false);
    let mut slash_date = false;
    let mut i = 0;
    while i < tokens.len() {
        let t = tokens[i];
        let first = t.as_bytes()[0];
        if first.is_ascii_alphabetic() {
            let lower = t.to_ascii_lowercase();
            let key = &lower[..lower.len().min(3)];
            if let Some(idx) = MONTHS.iter().position(|m| *m == key) {
                month = Some(idx as i64 + 1);
            } else if DAYS.contains(&key) || lower == "t" && !numbers.is_empty() {
            } else if lower == "am" || lower == "pm" {
                meridiem = Some(if lower == "am" { "am" } else { "pm" });
            } else if matches!(lower.as_str(), "utc" | "gmt" | "ut" | "z") {
                offset = 0;
                zoned = true;
            } else if !numbers.is_empty() || has_time {
                return None;
            }
            i += 1;
        } else if first.is_ascii_digit() {
            let n: i64 = t.parse().ok()?;
            if tokens.get(i + 1) == Some(&":")
                && tokens
                    .get(i + 2)
                    .is_some_and(|x| x.as_bytes()[0].is_ascii_digit())
            {
                has_time = true;
                time.0 = n;
                time.1 = tokens[i + 2].parse().ok()?;
                i += 3;
                if tokens.get(i) == Some(&":")
                    && tokens
                        .get(i + 1)
                        .is_some_and(|x| x.as_bytes()[0].is_ascii_digit())
                {
                    time.2 = tokens[i + 1].parse().ok()?;
                    i += 2;
                    if tokens.get(i) == Some(&".")
                        && tokens
                            .get(i + 1)
                            .is_some_and(|x| x.as_bytes()[0].is_ascii_digit())
                    {
                        let frac: String =
                            tokens[i + 1].chars().chain("00".chars()).take(3).collect();
                        time.3 = frac.parse().ok()?;
                        i += 2;
                    }
                }
            } else {
                numbers.push(n);
                i += 1;
            }
        } else if (t == "+" || t == "-")
            && has_time
            && tokens
                .get(i + 1)
                .is_some_and(|x| x.as_bytes()[0].is_ascii_digit())
        {
            let digits = tokens[i + 1];
            let sign = if t == "-" { -1 } else { 1 };
            let (oh, om, used) = if digits.len() == 4 {
                (
                    digits[..2].parse::<i64>().ok()?,
                    digits[2..].parse::<i64>().ok()?,
                    2,
                )
            } else if tokens.get(i + 2) == Some(&":") && tokens.get(i + 3).is_some() {
                (
                    digits.parse::<i64>().ok()?,
                    tokens[i + 3].parse::<i64>().ok()?,
                    4,
                )
            } else {
                (digits.parse::<i64>().ok()?, 0, 2)
            };
            offset = sign * oh.saturating_mul(60).saturating_add(om);
            zoned = true;
            i += used;
        } else {
            if t == "/" {
                slash_date = true;
            }
            i += 1;
        }
    }
    let (y, mo, d) = match (month, numbers.as_slice()) {
        (Some(m), [a, b]) => {
            if *a > 31 {
                (*a, m, *b)
            } else {
                (*b, m, *a)
            }
        }
        (None, [a, b, c]) if slash_date && *a > 31 => (*a, *b, *c),
        (None, [a, b, c]) if slash_date => (*c, *a, *b),
        _ => return None,
    };
    let year = if (0..50).contains(&y) {
        y + 2000
    } else if (50..100).contains(&y) {
        y + 1900
    } else {
        y
    };
    let mut hour = time.0;
    match meridiem {
        Some(_) if !(1..=12).contains(&hour) => return None,
        Some("pm") => hour = hour % 12 + 12,
        Some(_) => hour %= 12,
        None => {}
    }
    let t = make_time(year, mo, d, hour, time.1, time.2, time.3, offset)?;
    Some((t, !zoned))
}

fn parse_parts(text: &str) -> Option<(f64, bool)> {
    let text = crate::web::extract::utils::js::trim(text);
    parse_iso(text).or_else(|| parse_legacy(text))
}

/// `Date.parse(text)` in milliseconds, `None` for `NaN`, with a zone-less time read as UTC.
pub fn parse_date(text: &str) -> Option<f64> {
    clip(parse_parts(text)?.0)
}

/// `Date.parse(text)` on a machine whose zone is `local_offset`: the offset in milliseconds that
/// zone adds to UTC at a local wall time, given as milliseconds since the epoch read as UTC.
/// V8 refuses a zone-less time more than ten days past the Date range before the offset applies,
/// and the result after.
pub fn parse_date_in(text: &str, local_offset: impl Fn(f64) -> f64) -> Option<f64> {
    let (t, local) = parse_parts(text)?;
    if !local {
        return clip(t);
    }
    if t.abs() > MAX_LOCAL_TIME {
        return None;
    }
    clip(t - local_offset(t))
}

/// `new Date(ms).toISOString()`; `RangeError: Invalid time value` outside the Date range.
pub fn iso_string(ms: Option<f64>) -> Result<String, ExtractError> {
    let Some(t) = ms.filter(|t| t.abs() <= MAX_TIME) else {
        return Err(ExtractError::Js("RangeError: Invalid time value".into()));
    };
    let t = t.trunc() as i64;
    let (days, rem) = (t.div_euclid(86_400_000), t.rem_euclid(86_400_000));
    let (y, m, d) = civil_from_days(days);
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else {
        format!("{}{:06}", if y < 0 { '-' } else { '+' }, y.abs())
    };
    Ok(format!(
        "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    ))
}

/// `new Date(text).toISOString()`.
pub fn iso_from_text(text: &str) -> Result<String, ExtractError> {
    iso_string(parse_date(text))
}

/// `new Date(text).toISOString().split('T')[0]`.
pub fn iso_date_from_text(text: &str) -> Result<String, ExtractError> {
    Ok(iso_from_text(text)?
        .split('T')
        .next()
        .unwrap_or_default()
        .to_string())
}

/// `new Date(ms).toISOString().split('T')[0]`.
pub fn iso_date_from_millis(ms: f64) -> Result<String, ExtractError> {
    Ok(iso_string(Some(ms))?
        .split('T')
        .next()
        .unwrap_or_default()
        .to_string())
}

/// `try { return new Date(text).toISOString().split('T')[0] } catch { return '' }`.
pub fn iso_date_or_empty(text: &str) -> String {
    iso_date_from_text(text).unwrap_or_default()
}
