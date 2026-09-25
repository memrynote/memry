//! Which template a journal day starts from, and what applying it writes.
//!
//! Mirrors `domain-notes/src/journal/templates.ts`. The locale strings
//! (`{{date}}` without a pattern, `{{time}}`, `{{day-of-week}}`) are formatted
//! by each shell and passed in; this module does the substitution both
//! platforms must agree on (spec 005-journal D4).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::domain::calendar::CivilDate;

#[derive(Debug, Clone, PartialEq)]
pub struct JournalTemplateSettings {
    pub default_template: Option<String>,
    /// Keyed by the weekday as a string, `"0"` (Sunday) to `"6"`.
    pub weekday_templates: Option<BTreeMap<String, Option<String>>>,
}

/// The strings a shell formats for the day being seeded, in its own locale.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalTemplateFormatted {
    /// `{{date}}` without a pattern: weekday, month, day and year, long form.
    pub long_date: String,
    /// `{{time}}`: the current time, hour and minutes.
    pub time: String,
    /// `{{day-of-week}}`: the long weekday name of the day.
    pub day_of_week: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JournalTemplateProperty {
    pub name: String,
    pub value: Value,
}

/// A template's seedable parts.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalTemplateSource {
    pub content: String,
    pub tags: Vec<String>,
    pub properties: Vec<JournalTemplateProperty>,
}

/// What a seeded day is created with.
#[derive(Debug, Clone, PartialEq)]
pub struct AppliedJournalTemplate {
    pub content: String,
    pub tags: Vec<String>,
    /// One entry per name, at its first position, holding its last value.
    pub properties: Vec<JournalTemplateProperty>,
}

/// JS `Number(part)` for a date part: blank is 0, a non-integer is `None`.
fn js_number(part: &str) -> Option<i64> {
    let part = super::js_trim(part);
    if part.is_empty() {
        return Some(0);
    }
    part.parse().ok()
}

/// `weekdayOf`: weekday of a `YYYY-MM-DD` key, 0 = Sunday, time-zone free
/// (`Date.UTC(year, month - 1, day).getUTCDay()`, including its rollover and
/// its 0-99 → 1900-1999 year mapping). `None` where JS computes `NaN`.
pub fn weekday_of(iso_date: &str) -> Option<u32> {
    let mut parts = iso_date.split('-');
    let mut next = || parts.next().and_then(js_number);
    let (year, month, day) = (next()?, next()?, next()?);
    let year = if (0..=99).contains(&year) {
        year + 1900
    } else {
        year
    };
    Some(CivilDate::from_js_parts(year, month - 1, day).weekday())
}

/// `resolveJournalTemplateId`: the weekday's template when it names one, else
/// the default. A missing, `null` or empty weekday entry falls back.
pub fn resolve_journal_template_id(
    settings: &JournalTemplateSettings,
    iso_date: &str,
) -> Option<String> {
    let key = weekday_of(iso_date).map_or_else(|| "NaN".to_owned(), |day| day.to_string());
    let per_day = settings
        .weekday_templates
        .as_ref()
        .and_then(|map| map.get(&key))
        .and_then(Option::as_ref)
        .filter(|id| !id.is_empty());
    per_day.or(settings.default_template.as_ref()).cloned()
}

/// `orderedWeekdays`: the seven weekdays in display order for a
/// first-day-of-week preference, 0 (Sunday) or 1 (Monday).
pub fn ordered_weekdays(week_starts_on: u32) -> Vec<u32> {
    (0..7).map(|day| (day + week_starts_on) % 7).collect()
}

/// `formatDatePattern`: `YYYY`, `MM` and `DD` in `pattern` replaced, in that
/// order, from the calendar key's `-`-separated parts.
pub fn format_date_pattern(iso_date: &str, pattern: &str) -> String {
    let mut parts = iso_date.split('-');
    let mut next = || parts.next().unwrap_or("undefined");
    let (year, month, day) = (next(), next(), next());
    let pattern = replace_js(pattern, "YYYY", year);
    let pattern = replace_js(&pattern, "MM", month);
    replace_js(&pattern, "DD", day)
}

/// `applyJournalTemplate`: substitute `{{title}}`, `{{date}}` /
/// `{{date:FORMAT}}`, `{{time}}` and `{{day-of-week}}`, in that order, and
/// copy the tags and properties (a later property with the same name wins).
pub fn apply_journal_template(
    template: &JournalTemplateSource,
    iso_date: &str,
    formatted: &JournalTemplateFormatted,
) -> AppliedJournalTemplate {
    let content = replace_js(&template.content, "{{title}}", iso_date);
    let content = replace_date_tokens(&content, iso_date, &formatted.long_date);
    let content = replace_js(&content, "{{time}}", &formatted.time);
    let content = replace_js(&content, "{{day-of-week}}", &formatted.day_of_week);

    let mut properties: Vec<JournalTemplateProperty> = Vec::new();
    for property in &template.properties {
        match properties
            .iter_mut()
            .find(|kept| kept.name == property.name)
        {
            Some(kept) => kept.value = property.value.clone(),
            None => properties.push(property.clone()),
        }
    }

    AppliedJournalTemplate {
        content,
        tags: template.tags.clone(),
        properties,
    }
}

/// `/\{\{date(?::([^}]+))?\}\}/g` with a function replacement (no `$`
/// expansion). The optional group cannot backtrack into a match: without it
/// the `}}` must follow `{{date` directly, where the group needs a `:`.
fn replace_date_tokens(content: &str, iso_date: &str, long_date: &str) -> String {
    const OPEN: &str = "{{date";
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + OPEN.len()..];
        let matched = if let Some(tail) = after.strip_prefix("}}") {
            Some((long_date.to_owned(), tail))
        } else if let Some(body) = after.strip_prefix(':') {
            body.find('}').filter(|&close| close > 0).and_then(|close| {
                let tail = body[close..].strip_prefix("}}")?;
                Some((format_date_pattern(iso_date, &body[..close]), tail))
            })
        } else {
            None
        };
        match matched {
            Some((replacement, tail)) => {
                out.push_str(&replacement);
                rest = tail;
            }
            None => {
                // A failed match advances one position; `{` is one byte.
                out.push('{');
                rest = &rest[start + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `text.replace(/needle/g, replacement)` for a needle with no regex
/// metacharacters and no capture groups, including JS's `$` patterns in a
/// string replacement: `$$`, `$&`, `` $` `` and `$'`; anything else after `$`
/// (`$1` included, there being no groups) stays literal.
fn replace_js(text: &str, needle: &str, replacement: &str) -> String {
    if !text.contains(needle) {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (start, _) in text.match_indices(needle) {
        let end = start + needle.len();
        out.push_str(&text[last..start]);
        let mut chars = replacement.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '$' {
                out.push(c);
                continue;
            }
            match chars.peek() {
                Some('$') => out.push('$'),
                Some('&') => out.push_str(needle),
                Some('`') => out.push_str(&text[..start]),
                Some('\'') => out.push_str(&text[end..]),
                _ => {
                    out.push('$');
                    continue;
                }
            }
            chars.next();
        }
        last = end;
    }
    out.push_str(&text[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_dollar_patterns_follow_js() {
        assert_eq!(
            replace_js("a{{time}}b", "{{time}}", "$$|$&|$`|$'|$1|$"),
            "a$|{{time}}|a|b|$1|$b"
        );
    }

    #[test]
    fn date_token_needs_a_nonempty_pattern_and_closing_braces() {
        let long = "LONG";
        assert_eq!(
            replace_date_tokens("{{date:}}", "2099-06-15", long),
            "{{date:}}"
        );
        assert_eq!(
            replace_date_tokens("{{date:a}b}}", "2099-06-15", long),
            "{{date:a}b}}"
        );
        assert_eq!(
            replace_date_tokens("{{{date}}", "2099-06-15", long),
            "{LONG"
        );
        assert_eq!(replace_date_tokens("{{date:DD}}", "2099-06-05", long), "05");
    }

    #[test]
    fn weekday_of_rolls_over_like_date_utc() {
        assert_eq!(weekday_of("2099-06-15"), Some(1));
        assert_eq!(weekday_of("2099-02-29"), weekday_of("2099-03-01"));
        assert_eq!(weekday_of("2099-xx-01"), None);
        assert_eq!(weekday_of("99-01-01"), weekday_of("1999-01-01"));
    }
}
