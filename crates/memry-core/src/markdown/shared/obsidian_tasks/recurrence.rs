//! `parseRecurrence` of `packages/shared/src/obsidian-tasks.ts`: the subset of
//! the plugin's rrule text Memry can honour exactly.

use serde_json::{Map, Value as Json, json};

use crate::markdown::frontmatter::js::js_trim;
use crate::markdown::shared::block_colors::js_value::number_json;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Frequency {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
            Self::Yearly => "yearly",
        }
    }
}

/// `ObsidianRecurrence`.
#[derive(Debug, Clone, PartialEq)]
pub struct ObsidianRecurrence {
    pub frequency: Frequency,
    /// A JS number: `Number("9" * 400)` is infinite, which JSON writes as `null`.
    pub interval: f64,
    pub days_of_week: Option<Vec<u8>>,
    pub from_completion: bool,
}

impl ObsidianRecurrence {
    /// Keys in the order the TypeScript builds them.
    pub fn to_json(&self) -> Json {
        let mut map = Map::new();
        map.insert("frequency".to_owned(), json!(self.frequency.as_str()));
        map.insert("interval".to_owned(), number_json(self.interval));
        if let Some(days) = &self.days_of_week {
            map.insert("daysOfWeek".to_owned(), json!(days));
        }
        map.insert("fromCompletion".to_owned(), json!(self.from_completion));
        Json::Object(map)
    }
}

fn weekday(name: &str) -> Option<u8> {
    Some(match name {
        "sun" | "sunday" => 0,
        "mon" | "monday" => 1,
        "tue" | "tuesday" => 2,
        "wed" | "wednesday" => 3,
        "thu" | "thursday" => 4,
        "fri" | "friday" => 5,
        "sat" | "saturday" => 6,
        _ => return None,
    })
}

/// `text.split(/,| and /)`.
fn split_weekday_list(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        if rest.starts_with(',') {
            parts.push(&text[start..i]);
            i += 1;
            start = i;
        } else if rest.starts_with(" and ") {
            parts.push(&text[start..i]);
            i += 5;
            start = i;
        } else {
            i += rest.chars().next().map_or(1, char::len_utf8);
        }
    }
    parts.push(&text[start..]);
    parts
}

fn parse_weekdays(text: &str) -> Option<Vec<u8>> {
    let mut days: Vec<u8> = Vec::new();
    for token in split_weekday_list(text) {
        let name = js_trim(token);
        if name.is_empty() {
            continue;
        }
        let day = weekday(name)?;
        if !days.contains(&day) {
            days.push(day);
        }
    }
    if days.is_empty() {
        return None;
    }
    days.sort_unstable();
    Some(days)
}

/// `^(?:(\d+) +)?(day|week|month|year)s?$`: the optional count and the unit.
fn parse_interval(rest: &str) -> Option<(Option<&str>, Frequency)> {
    let (count, unit) = match rest.split_once(' ') {
        Some((count, unit)) if !count.is_empty() && count.bytes().all(|b| b.is_ascii_digit()) => {
            (Some(count), unit.trim_start_matches(' '))
        }
        _ => (None, rest),
    };
    let unit = unit
        .strip_suffix('s')
        .filter(|u| !u.is_empty())
        .map_or(unit, |u| {
            if matches!(u, "day" | "week" | "month" | "year") {
                u
            } else {
                unit
            }
        });
    let frequency = match unit {
        "day" => Frequency::Daily,
        "week" => Frequency::Weekly,
        "month" => Frequency::Monthly,
        "year" => Frequency::Yearly,
        _ => return None,
    };
    Some((count, frequency))
}

pub(super) fn parse_recurrence(text: &str) -> Option<ObsidianRecurrence> {
    const WHEN_DONE: &str = " when done";
    let mut rule = js_trim(text).to_lowercase();
    let mut from_completion = false;
    if rule.ends_with(WHEN_DONE) {
        from_completion = true;
        rule = js_trim(&rule[..rule.len() - WHEN_DONE.len()]).to_owned();
    }
    let rest = js_trim(rule.strip_prefix("every")?);
    if rest == "weekday" {
        return Some(ObsidianRecurrence {
            frequency: Frequency::Weekly,
            interval: 1.0,
            days_of_week: Some(vec![1, 2, 3, 4, 5]),
            from_completion,
        });
    }
    if let Some((count, frequency)) = parse_interval(rest) {
        return Some(ObsidianRecurrence {
            frequency,
            interval: count.map_or(1.0, |digits| digits.parse::<f64>().unwrap_or(f64::INFINITY)),
            days_of_week: None,
            from_completion,
        });
    }
    Some(ObsidianRecurrence {
        frequency: Frequency::Weekly,
        interval: 1.0,
        days_of_week: Some(parse_weekdays(rest)?),
        from_completion,
    })
}
