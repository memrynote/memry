//! Moves a template's dates from the day it was exported to today, so the
//! sandbox shows today's tasks, this week's journal and next week's events
//! the way Electron's generator, which runs on the current day, does.
//!
//! `delta` is the whole-day difference between the device's local date and the
//! template's date (UTC). Every ISO date and instant inside a string moves,
//! whether it is a whole database value, part of note text, a vault path
//! (`journal/2026-01-14.md`, `Weekly sync 2026-01-12.md`) or the payload of a
//! `((date:…))` mention token. Rules:
//! - Only dates within [`WINDOW_DAYS`] of the template's date move: the
//!   generator's own dates are weeks or a few years from it, while dates that
//!   are content (`1968-12-24` in an Apollo 8 photo URL) stay as written.
//! - A date moves by `delta` days, except that a date nearer to an anniversary
//!   in another year (the past years of On this day) moves to the same day
//!   that many years before its moved anniversary, with Feb 29 becoming Feb 28
//!   in a non-leap year (`shiftJournalYear` in `@memry/domain-notes`).
//! - An instant (`…T09:00:00.000Z`) keeps its wall time, read in the template's
//!   zone (UTC), on its moved day in the device's zone.
//! - A date not bounded by non-digits, or not a real calendar day, is left alone.
//! - A task repeating monthly on a day of the month is due on that day of next
//!   month, as the generator sets it (`dayOfMonthOffset` in `content/tasks.ts`).
//! - A task repeating weekly on given weekdays and due after the template's
//!   date is due on the first of those weekdays on or after today
//!   (`content/tasks.ts`: Call Mum's `(7 - weekday) % 7`). Known difference:
//!   the generator's `nextFriday` skips today, so on a Friday Weekly review is
//!   due today here and next Friday in Electron. A weekly task due on the
//!   template's date stays due today (the standup's `due: 0`).
//! - `calendar_events.timezone` holding the template's zone becomes the
//!   device's IANA name, which the generator stamps on every event.
//! - `inbox_stats` is derived, so it is rebuilt from the moved inbox items the
//!   way `rebuildInboxStatsTable` (and the generator's `post/inbox.ts`) builds
//!   it: on the UTC dates of their instants, which a device zone can regroup.
//! - [`Rebase::file`] also moves a canvas's `memry.createdAt`/`updatedAt`
//!   (epoch milliseconds, `steps/canvases.ts`) as instants.

use std::borrow::Cow;
use std::sync::LazyLock;

use base64::Engine as _;
use base64::alphabet::Alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc,
};
use regex::{Captures, Regex};

use super::manifest::{Manifest, Row, TEMPLATE_ZONE};

/// How far from the template's date a date may be and still move: five years.
pub const WINDOW_DAYS: i64 = 5 * 366;

static DATE_OR_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\(\(date:(?P<token>[A-Za-z0-9,;_\\-]+)\)\)",
        r"|(?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})",
        r"(?:(?P<sep>[T ])(?P<time>[0-9]{2}:[0-9]{2}:[0-9]{2})(?P<frac>\.[0-9]{1,3})?(?P<z>Z)?)?",
    ))
    .expect("static regex")
});

/// `packages/shared/src/date-mention.ts`: base64 with `,` and `;` for `+` and `/`, no padding.
static TOKEN_ENGINE: LazyLock<GeneralPurpose> = LazyLock::new(|| {
    let alphabet =
        Alphabet::new("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789,;")
            .expect("static alphabet");
    GeneralPurpose::new(
        &alphabet,
        GeneralPurposeConfig::new()
            .with_encode_padding(false)
            .with_decode_padding_mode(DecodePaddingMode::Indifferent),
    )
});

/// A canvas's `memry.createdAt`/`updatedAt` as a JSON member; the quote is checked to be unescaped.
static CANVAS_TIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""(?:createdAt|updatedAt)": ?(?P<ms>[0-9]{1,15})"#).expect("static regex")
});

/// The device's IANA zone name, from where chrono's `Local` reads the zone: `TZ` on Unix,
/// then the OS setting. Resolve it once, beside the `Local` handed to [`Rebase::new`].
pub fn device_zone_name() -> String {
    #[cfg(unix)]
    if let Some(name) = std::env::var("TZ")
        .ok()
        .map(|tz| tz.trim_start_matches(':').to_owned())
        .filter(|tz| !tz.is_empty() && !tz.starts_with('/'))
    {
        return name;
    }
    iana_time_zone::get_timezone().unwrap_or_else(|error| {
        tracing::warn!(%error, "device time zone has no IANA name; sandbox events use UTC");
        TEMPLATE_ZONE.to_owned()
    })
}

/// A rebase from a template's date to today in the device's zone `tz`, named `zone`.
#[derive(Debug, Clone)]
pub struct Rebase<Tz: TimeZone> {
    from: NaiveDate,
    delta: i64,
    tz: Tz,
    zone: String,
}

impl<Tz: TimeZone> Rebase<Tz> {
    /// `from` is the template's date; today is `now`'s date in `tz`; `zone` is `tz`'s IANA name.
    pub fn new(from: NaiveDate, now: DateTime<Utc>, tz: Tz, zone: impl Into<String>) -> Self {
        let today = now.with_timezone(&tz).date_naive();
        Self {
            from,
            delta: (today - from).num_days(),
            tz,
            zone: zone.into(),
        }
    }

    pub fn for_manifest(
        manifest: &Manifest,
        now: DateTime<Utc>,
        tz: Tz,
        zone: impl Into<String>,
    ) -> Self {
        Self::new(manifest.template_date(), now, tz, zone)
    }

    /// Today in the device's zone.
    pub fn today(&self) -> NaiveDate {
        add_days(self.from, self.delta).unwrap_or(self.from)
    }

    /// Days between the template's date and today.
    pub fn delta_days(&self) -> i64 {
        self.delta
    }

    fn in_window(&self, date: NaiveDate) -> bool {
        (date - self.from).num_days().abs() <= WINDOW_DAYS
    }

    /// A calendar date, by the anniversary rule of the module docs.
    pub fn date(&self, date: NaiveDate) -> NaiveDate {
        if self.delta == 0 || !self.in_window(date) {
            return date;
        }
        let base = self.from.year() - date.year();
        let years = [base - 1, base, base + 1]
            .into_iter()
            .filter_map(|years| Some((years, (shift_year(date, years)? - self.from).num_days())))
            .min_by_key(|(years, distance)| (distance.abs(), years.abs()))
            .map_or(0, |(years, _)| years);
        let moved = (|| {
            if years == 0 {
                return add_days(date, self.delta);
            }
            shift_year(add_days(shift_year(date, years)?, self.delta)?, -years)
        })();
        moved.unwrap_or(date)
    }

    /// An instant: its UTC wall time on the moved day, read in the device's zone.
    pub fn instant(&self, at: DateTime<Utc>) -> DateTime<Utc> {
        let wall = at.naive_utc();
        if !self.in_window(wall.date()) {
            return at;
        }
        let moved = NaiveDateTime::new(self.date(wall.date()), wall.time());
        self.local_to_utc(moved).unwrap_or(at)
    }

    /// An instant that marks a calendar day (an all-day event's UTC midnight): its date moves, its time stays UTC.
    pub fn day_instant(&self, at: DateTime<Utc>) -> DateTime<Utc> {
        let wall = at.naive_utc();
        NaiveDateTime::new(self.date(wall.date()), wall.time()).and_utc()
    }

    fn local_to_utc(&self, wall: NaiveDateTime) -> Option<DateTime<Utc>> {
        let local = match self.tz.from_local_datetime(&wall) {
            LocalResult::Single(at) | LocalResult::Ambiguous(at, _) => at,
            // A wall time inside a spring-forward gap does not exist; use the first time after it.
            LocalResult::None => self
                .tz
                .from_local_datetime(&(wall + Duration::hours(1)))
                .earliest()?,
        };
        Some(local.with_timezone(&Utc))
    }

    /// Every date, instant and date token in `text`; borrows when nothing moves.
    pub fn text<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let mut changed = false;
        let out = DATE_OR_TOKEN.replace_all(text, |caps: &Captures| {
            let whole = caps.get(0).expect("match").as_str();
            let replaced = if let Some(token) = caps.name("token") {
                self.token(token.as_str())
            } else {
                self.date_match(text, caps)
            };
            match replaced {
                Some(next) if next != whole => {
                    changed = true;
                    next
                }
                _ => whole.to_owned(),
            }
        });
        if changed {
            Cow::Owned(out.into_owned())
        } else {
            Cow::Borrowed(text)
        }
    }

    fn date_match(&self, text: &str, caps: &Captures) -> Option<String> {
        let whole = caps.get(0)?;
        let bytes = text.as_bytes();
        let digit_before = whole.start() > 0 && bytes[whole.start() - 1].is_ascii_digit();
        let digit_after = bytes.get(whole.end()).is_some_and(u8::is_ascii_digit);
        if digit_before || digit_after {
            return None;
        }
        let date = NaiveDate::parse_from_str(caps.name("date")?.as_str(), "%Y-%m-%d").ok()?;
        let Some(time) = caps.name("time") else {
            return Some(self.date(date).format("%Y-%m-%d").to_string());
        };
        let sep = caps.name("sep")?.as_str();
        let frac = caps.name("frac").map_or("", |frac| frac.as_str());
        let zoned = caps.name("z").is_some();
        // `T…` with no zone is a floating wall time: only its day moves.
        if sep == "T" && !zoned {
            return Some(format!(
                "{}{sep}{}{frac}",
                self.date(date).format("%Y-%m-%d"),
                time.as_str()
            ));
        }
        let time =
            NaiveTime::parse_from_str(&format!("{}{frac}", time.as_str()), "%H:%M:%S%.f").ok()?;
        let at = self.instant(NaiveDateTime::new(date, time).and_utc());
        let fraction = if frac.is_empty() { "" } else { "%.3f" };
        let zone = if zoned { "Z" } else { "" };
        Some(
            at.format(&format!("%Y-%m-%d{sep}%H:%M:%S{fraction}{zone}"))
                .to_string(),
        )
    }

    /// A vault file's text: [`Rebase::text`], plus a canvas's millisecond timestamps.
    pub fn file<'a>(&self, path: &str, text: &'a str) -> Cow<'a, str> {
        let moved = self.text(text);
        if !path.ends_with(".excalidraw") {
            return moved;
        }
        if let Some(out) = self.canvas_times(&moved) {
            Cow::Owned(out)
        } else {
            moved
        }
    }

    fn canvas_times(&self, text: &str) -> Option<String> {
        let mut changed = false;
        let bytes = text.as_bytes();
        let out = CANVAS_TIME.replace_all(text, |caps: &Captures| {
            let whole = caps.get(0).expect("match");
            let ms = caps.name("ms").expect("group");
            let escaped = whole.start() > 0 && bytes[whole.start() - 1] == b'\\';
            let digit_after = bytes.get(ms.end()).is_some_and(u8::is_ascii_digit);
            let moved = (!escaped && !digit_after)
                .then(|| ms.as_str().parse::<i64>().ok())
                .flatten()
                .and_then(DateTime::from_timestamp_millis)
                .map(|at| self.instant(at).timestamp_millis().to_string())
                .filter(|moved| moved != ms.as_str());
            match moved {
                Some(moved) => {
                    changed = true;
                    let head = &text[whole.start()..ms.start()];
                    format!("{head}{moved}")
                }
                None => whole.as_str().to_owned(),
            }
        });
        changed.then(|| out.into_owned())
    }

    /// A `((date:…))` token: rebases its JSON payload and re-encodes it when a date moved.
    fn token(&self, payload: &str) -> Option<String> {
        // Older writers used base64url's `-` and `_`, and escapers add `\`; all decode the same.
        let normalized: String = payload
            .chars()
            .filter(|c| *c != '\\')
            .map(|c| match c {
                '-' => ',',
                '_' => ';',
                c => c,
            })
            .collect();
        let bytes = TOKEN_ENGINE.decode(normalized).ok()?;
        // btoa/atob work on Latin-1 code units, one char per byte.
        let json: String = bytes.iter().map(|&b| char::from(b)).collect();
        let moved = self.text(&json);
        let Cow::Owned(moved) = moved else {
            return None;
        };
        let bytes: Vec<u8> = moved
            .chars()
            .map(|c| u8::try_from(u32::from(c)).ok())
            .collect::<Option<_>>()?;
        Some(format!("((date:{}))", TOKEN_ENGINE.encode(bytes)))
    }

    /// Every string in a JSON value, including JSON documents stored as strings.
    pub fn value(&self, value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(text) => {
                if let Cow::Owned(moved) = self.text(text) {
                    *text = moved;
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|item| self.value(item)),
            serde_json::Value::Object(map) => map.values_mut().for_each(|item| self.value(item)),
            _ => {}
        }
    }

    /// Every row value and asset path of a template. All-day events keep UTC midnights.
    pub fn manifest(&self, manifest: &mut Manifest) {
        for (table, rows) in manifest.data.iter_mut().chain(manifest.index.iter_mut()) {
            let events = table == "calendar_events";
            for row in rows {
                let all_day = events && is_truthy(row.get("is_all_day"));
                let repeat_due = (table == "tasks").then(|| self.repeat_due(row)).flatten();
                for (column, value) in row.iter_mut() {
                    if all_day && (column == "start_at" || column == "end_at") {
                        self.all_day_value(value);
                    } else if events && column == "timezone" && *value == TEMPLATE_ZONE {
                        *value = serde_json::Value::String(self.zone.clone());
                    } else {
                        self.value(value);
                    }
                }
                if let Some(due) = repeat_due {
                    let due = due.format("%Y-%m-%d").to_string();
                    row.insert("due_date".to_owned(), serde_json::Value::String(due));
                }
            }
        }
        if let Some(template) = manifest.data.remove("inbox_stats") {
            let items = manifest
                .data
                .get("inbox_items")
                .map_or(&[][..], Vec::as_slice);
            let rebuilt = inbox_stats(items, &template);
            manifest.data.insert("inbox_stats".to_owned(), rebuilt);
        }
        for copy in &mut manifest.assets {
            if let Cow::Owned(moved) = self.text(&copy.path) {
                copy.path = moved;
            }
        }
    }

    fn all_day_value(&self, value: &mut serde_json::Value) {
        let serde_json::Value::String(text) = value else {
            return;
        };
        if let Ok(at) = DateTime::parse_from_rfc3339(text) {
            *text = self
                .day_instant(at.with_timezone(&Utc))
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
        }
    }
}

impl<Tz: TimeZone> Rebase<Tz> {
    /// The due date a repeating task's rule sets, by the module docs; `None` keeps the plain shift.
    fn repeat_due(&self, row: &Row) -> Option<NaiveDate> {
        let due = row.get("due_date")?.as_str()?;
        let config: serde_json::Value =
            serde_json::from_str(row.get("repeat_config")?.as_str()?).ok()?;
        match config.get("frequency")?.as_str()? {
            // `{"frequency":"monthly","dayOfMonth":n}`
            "monthly" => {
                let day = u32::try_from(config.get("dayOfMonth")?.as_u64()?)
                    .ok()
                    .filter(|day| (1..=31).contains(day))?;
                Some(next_month_day(self.today(), day))
            }
            // `{"frequency":"weekly","daysOfWeek":[0..6]}`, 0 = Sunday
            "weekly" => {
                if NaiveDate::parse_from_str(due, "%Y-%m-%d").ok()? <= self.from {
                    return None;
                }
                let days = config
                    .get("daysOfWeek")?
                    .as_array()?
                    .iter()
                    .map(|day| day.as_u64().filter(|day| *day <= 6))
                    .collect::<Option<Vec<u64>>>()?;
                (0..7)
                    .filter_map(|n| add_days(self.today(), n))
                    .find(|date| days.contains(&u64::from(date.weekday().num_days_from_sunday())))
            }
            _ => None,
        }
    }
}

/// The item types `inbox_stats` has a capture column for (`STAT_COLUMNS`).
const CAPTURE_TYPES: [&str; 8] = [
    "link", "note", "image", "voice", "clip", "pdf", "social", "reminder",
];

/// `rebuildInboxStatsTable` over moved items: a capture counts on the UTC date of
/// `created_at`, a filing on that of `filed_at`, an archive on that of `archived_at`.
/// A row keeps the id of the (moved) template row of its date.
fn inbox_stats(items: &[Row], template: &[Row]) -> Vec<Row> {
    use serde_json::Value;
    let mut out: Vec<Row> = Vec::new();
    let mut by_date: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut bump = |at: Option<&Value>, column: &str| {
        let Some(date) = at.and_then(Value::as_str).and_then(|at| at.get(..10)) else {
            return;
        };
        let index = *by_date.entry(date.to_owned()).or_insert_with(|| {
            let id = template
                .iter()
                .find(|row| row.get("date").and_then(Value::as_str) == Some(date))
                .and_then(|row| row.get("id").cloned())
                .unwrap_or_else(|| Value::String(format!("istat_{date}")));
            let mut row = Row::new();
            row.insert("id".to_owned(), id);
            row.insert("date".to_owned(), Value::String(date.to_owned()));
            for kind in CAPTURE_TYPES {
                row.insert(format!("capture_count_{kind}"), Value::from(0));
            }
            row.insert("processed_count".to_owned(), Value::from(0));
            row.insert("archived_count".to_owned(), Value::from(0));
            out.push(row);
            out.len() - 1
        });
        let count = out[index].entry(column).or_insert(Value::from(0));
        *count = Value::from(count.as_i64().unwrap_or(0) + 1);
    };
    for item in items {
        let kind = item.get("type").and_then(Value::as_str);
        if let Some(kind) = kind.filter(|kind| CAPTURE_TYPES.contains(kind)) {
            bump(item.get("created_at"), &format!("capture_count_{kind}"));
        }
        bump(item.get("filed_at"), "processed_count");
        bump(item.get("archived_at"), "archived_count");
    }
    out
}

/// `new Date(year, month + 1, day)`: day `day` of next month, overflowing into the month after like JavaScript.
fn next_month_day(today: NaiveDate, day: u32) -> NaiveDate {
    let first = today
        .with_day(1)
        .and_then(|first| first.checked_add_months(chrono::Months::new(1)))
        .unwrap_or(today);
    add_days(first, i64::from(day) - 1).unwrap_or(first)
}

fn is_truthy(value: Option<&serde_json::Value>) -> bool {
    match value {
        Some(serde_json::Value::Bool(flag)) => *flag,
        Some(serde_json::Value::Number(n)) => n.as_i64().is_some_and(|n| n != 0),
        _ => false,
    }
}

fn add_days(date: NaiveDate, days: i64) -> Option<NaiveDate> {
    date.checked_add_signed(Duration::try_days(days)?)
}

/// `shiftJournalYear`: the same month and day `years` later; Feb 29 becomes Feb 28 in a non-leap year.
fn shift_year(date: NaiveDate, years: i32) -> Option<NaiveDate> {
    let year = date.year().checked_add(years)?;
    NaiveDate::from_ymd_opt(year, date.month(), date.day()).or_else(|| {
        NaiveDate::from_ymd_opt(year, 2, 28).filter(|_| date.month() == 2 && date.day() == 29)
    })
}

#[cfg(test)]
mod tests;
