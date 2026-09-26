//! RRULE expansion in wall time (RFC 5545 §3.3.10), the subset `ical.js`
//! walks for desktop's feeds: FREQ (SECONDLY..YEARLY), INTERVAL, COUNT, UNTIL,
//! BYMONTH, BYMONTHDAY, BYYEARDAY, BYDAY (with ordinals), BYHOUR, BYMINUTE,
//! BYSECOND, BYSETPOS and WKST. Occurrences come out in order as wall-clock
//! seconds; the caller turns them into instants in the event's zone.

use super::rrule_days::{day_allowed, monthly_days, weekly_days, yearly_days};
use crate::domain::calendar::CivilDate;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Freq {
    Secondly,
    Minutely,
    Hourly,
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Until {
    /// A DATE: the last allowed day (inclusive).
    Date(CivilDate),
    /// A UTC DATE-TIME, in epoch seconds.
    Instant(i64),
    /// A floating / zoned DATE-TIME, in wall seconds.
    Wall(i64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub freq: Freq,
    pub interval: i64,
    pub count: Option<u64>,
    pub until: Option<Until>,
    pub by_month: Vec<u32>,
    pub by_month_day: Vec<i64>,
    pub by_year_day: Vec<i64>,
    /// `(ordinal, weekday 0 = Sunday)`; ordinal 0 = every such weekday.
    pub by_day: Vec<(i64, u32)>,
    pub by_hour: Vec<u32>,
    pub by_minute: Vec<u32>,
    pub by_second: Vec<u32>,
    pub by_set_pos: Vec<i64>,
    /// 0 = Sunday .. 6 = Saturday; RFC default Monday.
    pub week_start: u32,
}

fn weekday_code(code: &str) -> Option<u32> {
    Some(match code {
        "SU" => 0,
        "MO" => 1,
        "TU" => 2,
        "WE" => 3,
        "TH" => 4,
        "FR" => 5,
        "SA" => 6,
        _ => return None,
    })
}

fn numbers<T: std::str::FromStr>(value: &str) -> Vec<T> {
    value
        .split(',')
        .filter_map(|part| part.trim().parse().ok())
        .collect()
}

/// Parses `FREQ=WEEKLY;BYDAY=MO,WE`. `until` reads the UNTIL value the way the
/// caller's event reads its times. `None` without a valid FREQ.
pub fn parse_rule(value: &str, until: impl Fn(&str) -> Option<Until>) -> Option<Rule> {
    let mut rule = Rule {
        freq: Freq::Daily,
        interval: 1,
        count: None,
        until: None,
        by_month: Vec::new(),
        by_month_day: Vec::new(),
        by_year_day: Vec::new(),
        by_day: Vec::new(),
        by_hour: Vec::new(),
        by_minute: Vec::new(),
        by_second: Vec::new(),
        by_set_pos: Vec::new(),
        week_start: 1,
    };
    let mut has_freq = false;
    for part in value.trim().trim_start_matches("RRULE:").split(';') {
        let Some((key, raw)) = part.split_once('=') else {
            continue;
        };
        let raw = raw.trim();
        match key.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                has_freq = true;
                rule.freq = match raw.to_ascii_uppercase().as_str() {
                    "SECONDLY" => Freq::Secondly,
                    "MINUTELY" => Freq::Minutely,
                    "HOURLY" => Freq::Hourly,
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                };
            }
            "INTERVAL" => rule.interval = raw.parse::<i64>().ok().filter(|n| *n > 0).unwrap_or(1),
            "COUNT" => rule.count = raw.parse().ok(),
            "UNTIL" => rule.until = until(raw),
            "BYMONTH" => rule.by_month = numbers(raw),
            "BYMONTHDAY" => rule.by_month_day = numbers(raw),
            "BYYEARDAY" => rule.by_year_day = numbers(raw),
            "BYHOUR" => rule.by_hour = numbers(raw),
            "BYMINUTE" => rule.by_minute = numbers(raw),
            "BYSECOND" => rule.by_second = numbers(raw),
            "BYSETPOS" => rule.by_set_pos = numbers(raw),
            "WKST" => rule.week_start = weekday_code(&raw.to_ascii_uppercase()).unwrap_or(1),
            "BYDAY" => {
                rule.by_day = raw
                    .split(',')
                    .filter_map(|entry| {
                        let entry = entry.trim().to_ascii_uppercase();
                        let split = entry.len().checked_sub(2)?;
                        let day = weekday_code(entry.get(split..)?)?;
                        let ordinal = match entry.get(..split)? {
                            "" | "+" => 0,
                            n => n.trim_start_matches('+').parse().ok()?,
                        };
                        Some((ordinal, day))
                    })
                    .collect();
            }
            _ => {}
        }
    }
    has_freq.then_some(rule)
}

const DAY: i64 = 86_400;

/// The rule's occurrences from `start` (wall seconds), in order, `start`
/// itself first (RFC: DTSTART is always the first instance). The iterator
/// ends at COUNT / UNTIL, or when `limit` periods pass without a match.
pub struct Occurrences<'a> {
    rule: &'a Rule,
    start: i64,
    period: i64,
    buffer: std::collections::VecDeque<i64>,
    emitted: u64,
    started: bool,
    done: bool,
    empty_periods: u32,
    until: Option<i64>,
    until_date: Option<CivilDate>,
    to_utc: &'a dyn Fn(i64) -> i64,
}

impl<'a> Occurrences<'a> {
    /// `to_utc` turns a wall time into epoch seconds (for a UTC UNTIL).
    pub fn new(rule: &'a Rule, start: i64, to_utc: &'a dyn Fn(i64) -> i64) -> Self {
        let (until, until_date) = match &rule.until {
            Some(Until::Date(date)) => (None, Some(*date)),
            Some(Until::Instant(seconds)) => (Some(*seconds), None),
            Some(Until::Wall(seconds)) => (Some(*seconds), None),
            None => (None, None),
        };
        Self {
            rule,
            start,
            period: 0,
            buffer: std::collections::VecDeque::new(),
            emitted: 0,
            started: false,
            done: false,
            empty_periods: 0,
            until,
            until_date,
            to_utc,
        }
    }

    fn past_until(&self, wall: i64) -> bool {
        if let Some(date) = self.until_date {
            return wall.div_euclid(DAY) > date.days_since_epoch();
        }
        match (&self.rule.until, self.until) {
            (Some(Until::Instant(_)), Some(limit)) => (self.to_utc)(wall) > limit,
            (_, Some(limit)) => wall > limit,
            _ => false,
        }
    }

    fn fill(&mut self) {
        // A rule that can never match (BYMONTHDAY=31 with BYMONTH=2) stops
        // instead of spinning; 400 years of empty periods is enough proof.
        while self.buffer.is_empty() && !self.done {
            let set = candidates(self.rule, self.start, self.period);
            self.period += 1;
            let mut any = false;
            for wall in set {
                if wall <= self.start {
                    continue;
                }
                any = true;
                self.buffer.push_back(wall);
            }
            if any {
                self.empty_periods = 0;
            } else {
                self.empty_periods += 1;
                if self.empty_periods > 5_000 {
                    self.done = true;
                }
            }
        }
    }
}

impl Iterator for Occurrences<'_> {
    type Item = i64;

    fn next(&mut self) -> Option<i64> {
        if self.done {
            return None;
        }
        if self.rule.count.is_some_and(|count| self.emitted >= count) {
            self.done = true;
            return None;
        }
        let next = if self.started {
            self.fill();
            self.buffer.pop_front()?
        } else {
            self.started = true;
            self.start
        };
        if self.past_until(next) {
            self.done = true;
            return None;
        }
        self.emitted += 1;
        Some(next)
    }
}

/// Every candidate of period `index` (the start's period is 0), sorted,
/// after BYxxx expansion / limiting and BYSETPOS.
fn candidates(rule: &Rule, start: i64, index: i64) -> Vec<i64> {
    let start_date = CivilDate::from_days_since_epoch(start.div_euclid(DAY));
    let time = start.rem_euclid(DAY);
    let step = index * rule.interval;
    let days: Vec<CivilDate> = match rule.freq {
        Freq::Yearly => yearly_days(rule, start_date, start_date.year + step),
        Freq::Monthly => {
            let first = CivilDate::new(start_date.year, start_date.month, 1)
                .unwrap_or(start_date)
                .add_months(step);
            monthly_days(rule, start_date, first)
        }
        Freq::Weekly => {
            let week = start_date.start_of_week(rule.week_start).add_days(step * 7);
            weekly_days(rule, start_date, week)
        }
        Freq::Daily => {
            let day = start_date.add_days(step);
            if day_allowed(rule, day) {
                vec![day]
            } else {
                Vec::new()
            }
        }
        Freq::Hourly | Freq::Minutely | Freq::Secondly => {
            let unit = match rule.freq {
                Freq::Hourly => 3_600,
                Freq::Minutely => 60,
                _ => 1,
            };
            let wall = start + step * unit;
            let day = CivilDate::from_days_since_epoch(wall.div_euclid(DAY));
            let parts = split_time(wall.rem_euclid(DAY));
            let keep = day_allowed(rule, day)
                && (rule.by_hour.is_empty() || rule.by_hour.contains(&parts.0))
                && (rule.by_minute.is_empty() || rule.by_minute.contains(&parts.1))
                && (rule.by_second.is_empty() || rule.by_second.contains(&parts.2));
            return if keep { vec![wall] } else { Vec::new() };
        }
    };
    let mut set: Vec<i64> = days
        .into_iter()
        .flat_map(|day| {
            times(rule, time)
                .into_iter()
                .map(move |t| day.days_since_epoch() * DAY + t)
        })
        .collect();
    set.sort_unstable();
    set.dedup();
    apply_set_pos(rule, set)
}

fn split_time(seconds: i64) -> (u32, u32, u32) {
    let h = u32::try_from(seconds / 3_600).unwrap_or(0);
    let m = u32::try_from(seconds % 3_600 / 60).unwrap_or(0);
    let s = u32::try_from(seconds % 60).unwrap_or(0);
    (h, m, s)
}

/// BYHOUR / BYMINUTE / BYSECOND expand the start's time of day.
fn times(rule: &Rule, time: i64) -> Vec<i64> {
    let (h, m, s) = split_time(time);
    let hours = if rule.by_hour.is_empty() {
        vec![h]
    } else {
        rule.by_hour.clone()
    };
    let minutes = if rule.by_minute.is_empty() {
        vec![m]
    } else {
        rule.by_minute.clone()
    };
    let seconds = if rule.by_second.is_empty() {
        vec![s]
    } else {
        rule.by_second.clone()
    };
    let mut out = Vec::new();
    for hour in &hours {
        for minute in &minutes {
            for second in &seconds {
                out.push(i64::from(*hour) * 3_600 + i64::from(*minute) * 60 + i64::from(*second));
            }
        }
    }
    out
}

fn apply_set_pos(rule: &Rule, set: Vec<i64>) -> Vec<i64> {
    if rule.by_set_pos.is_empty() {
        return set;
    }
    let len = i64::try_from(set.len()).unwrap_or(0);
    let mut picked: Vec<i64> = rule
        .by_set_pos
        .iter()
        .filter_map(|pos| {
            let index = if *pos > 0 { pos - 1 } else { len + pos };
            usize::try_from(index)
                .ok()
                .and_then(|i| set.get(i).copied())
        })
        .collect();
    picked.sort_unstable();
    picked.dedup();
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wall(y: i64, m: u32, d: u32, h: i64) -> i64 {
        CivilDate::new(y, m, d).expect("date").days_since_epoch() * DAY + h * 3_600
    }

    fn run(rule: &str, start: i64, take: usize) -> Vec<String> {
        let rule = parse_rule(rule, |_| None).expect("rule");
        let identity = |w: i64| w;
        Occurrences::new(&rule, start, &identity)
            .take(take)
            .map(|w| CivilDate::from_days_since_epoch(w.div_euclid(DAY)).key())
            .collect()
    }

    #[test]
    fn weekly_by_day_and_count() {
        let got = run("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", wall(2026, 3, 2, 9), 10);
        assert_eq!(
            got,
            ["2026-03-02", "2026-03-04", "2026-03-09", "2026-03-11"]
        );
    }

    #[test]
    fn monthly_nth_weekday_and_last_friday() {
        let got = run("FREQ=MONTHLY;BYDAY=2TU;COUNT=3", wall(2026, 1, 13, 9), 5);
        assert_eq!(got, ["2026-01-13", "2026-02-10", "2026-03-10"]);
        let last = run("FREQ=MONTHLY;BYDAY=-1FR;COUNT=2", wall(2026, 1, 30, 9), 5);
        assert_eq!(last, ["2026-01-30", "2026-02-27"]);
    }

    #[test]
    fn monthly_31st_skips_short_months() {
        let got = run("FREQ=MONTHLY;COUNT=3", wall(2026, 1, 31, 9), 5);
        assert_eq!(got, ["2026-01-31", "2026-03-31", "2026-05-31"]);
    }

    #[test]
    fn yearly_by_month_by_day_and_until_date() {
        let rule = "FREQ=YEARLY;BYMONTH=3;BYDAY=2SU";
        let got = run(rule, wall(2026, 3, 8, 2), 3);
        assert_eq!(got, ["2026-03-08", "2027-03-14", "2028-03-12"]);
        let parsed = parse_rule("FREQ=DAILY;UNTIL=20260305", |raw| {
            CivilDate::new(
                raw[..4].parse().ok()?,
                raw[4..6].parse().ok()?,
                raw[6..8].parse().ok()?,
            )
            .map(Until::Date)
        })
        .expect("rule");
        let identity = |w: i64| w;
        assert_eq!(
            Occurrences::new(&parsed, wall(2026, 3, 1, 9), &identity).count(),
            5
        );
    }

    #[test]
    fn an_impossible_rule_ends() {
        let rule = parse_rule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", |_| None).expect("rule");
        let identity = |w: i64| w;
        assert_eq!(
            Occurrences::new(&rule, wall(2026, 1, 1, 9), &identity).count(),
            1
        );
    }
}
