//! A model's text for a field, read as the field's value (`toProposal`, `parseLocaleNumber`
//! and `isCalendarDate` of Electron's `ai-inline/fill-fields.ts`). A value the field cannot
//! take is dropped, never coerced.

use memry_core::domain::tag_objects::search::ObjectMatch;
use memry_core::domain::tag_schema::ResolvedField;
use memry_core::markdown::frontmatter::js_trim;
use serde_json::{Value, json};

use super::{FieldFillProposal, FillCreate};

/// The number separators of `locale` as ICU formats `12345.6` there (Node's
/// `Intl.NumberFormat(locale).formatToParts`), for the app's languages: `(group, decimal)`. A
/// space group (`U+00A0` or `U+202F`) is `None`: the spaces are stripped before parsing, as
/// Electron strips them. A language not listed formats as English does.
fn separators(locale: &str) -> (Option<char>, char) {
    let language = locale.split(['-', '_']).next().unwrap_or(locale);
    match language {
        "cs" | "fi" | "fr" | "hu" | "no" | "nb" | "pl" | "ru" | "sk" | "sv" | "uk" => (None, ','),
        "da" | "de" | "el" | "es" | "hr" | "id" | "it" | "nl" | "pt" | "ro" | "tr" | "vi" => {
            (Some('.'), ',')
        }
        _ => (Some(','), '.'),
    }
}

/// `-?\d+(?:<decimal>\d+)?` with ASCII digits.
fn plain(text: &str, decimal: char) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match digits.split_once(decimal) {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    let all_digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    all_digits(whole) && fraction.is_none_or(all_digits)
}

/// `-?\d{1,3}(?:<group>\d{3})+(?:<decimal>\d+)?`.
fn grouped(text: &str, group: char, decimal: char) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match digits.split_once(decimal) {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    let all_digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    let mut groups = whole.split(group);
    let first = groups.next().unwrap_or_default();
    let rest: Vec<&str> = groups.collect();
    (1..=3).contains(&first.len())
        && all_digits(first)
        && !rest.is_empty()
        && rest.iter().all(|part| part.len() == 3 && all_digits(part))
        && fraction.is_none_or(|part| !part.is_empty() && all_digits(part))
}

/// A number as written in `locale` (`parseLocaleNumber`): `1.500` is 1500 where `.` groups
/// thousands and 1.5 where it is the decimal point. A form the locale does not decide (a
/// separator that neither groups three digits nor is the locale's decimal point, like `1,5` in
/// English) is refused, never read as 15.
pub fn parse_locale_number(raw: &str, locale: &str) -> Option<f64> {
    let stripped: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '\u{00a0}' | '\u{202f}'))
        .collect();
    let text = match stripped.strip_prefix('\u{2212}') {
        Some(rest) => format!("-{rest}"),
        None => stripped,
    };
    let (group, decimal) = separators(locale);
    let number =
        if group.is_some_and(|group| grouped(&text, group, decimal)) || plain(&text, decimal) {
            let ungrouped: String = text.chars().filter(|c| Some(*c) != group).collect();
            ungrouped.replacen(decimal, ".", 1).parse::<f64>().ok()
        } else if plain(&text, '.') && text.contains('.') {
            // A `.` decimal point the locale does not use for grouping three digits (`1.5` in Turkish).
            text.parse::<f64>().ok()
        } else {
            None
        };
    number.filter(|number| number.is_finite())
}

/// `YYYY-MM-DD` naming a real day from year 100 on: `2026-02-30` is refused, not rolled into
/// March.
pub fn is_calendar_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let number = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = &text[range];
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let (Some(year), Some(month), Some(day)) = (number(0..4), number(5..7), number(8..10)) else {
        return false;
    };
    // `Date.UTC` reads years 0 to 99 as 1900 to 1999, so Electron refuses them.
    if year < 100 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

/// The option values of a select, status or multiselect field.
fn options(field: &ResolvedField) -> Vec<&str> {
    field
        .options
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| option.get("value")?.as_str())
        .collect()
}

fn option_named<'a>(field: &'a ResolvedField, text: &str) -> Option<&'a str> {
    let wanted = text.to_lowercase();
    options(field)
        .into_iter()
        .find(|option| option.to_lowercase() == wanted)
}

/// `toProposal`: the model's `raw` text as a value of `field`, `None` when the field cannot
/// take it. `candidates` are the objects of a relation field's target.
pub fn to_proposal(
    field: &ResolvedField,
    raw: &str,
    candidates: &[ObjectMatch],
    locale: &str,
) -> Option<FieldFillProposal> {
    let text = js_trim(raw);
    if text.is_empty() {
        return None;
    }
    let proposal = |value: Value, display: &str| FieldFillProposal {
        field: field.name.clone(),
        value,
        display: display.to_owned(),
        source_text: String::new(),
        create: None,
    };
    match field.type_name.as_str() {
        "number" => parse_locale_number(text, locale).map(|number| proposal(json!(number), text)),
        "date" => is_calendar_date(text).then(|| proposal(json!(text), text)),
        "select" | "status" => {
            option_named(field, text).map(|option| proposal(json!(option), option))
        }
        "multiselect" => {
            let values: Vec<&str> = text
                .split(',')
                .filter_map(|part| option_named(field, js_trim(part)))
                .collect();
            (!values.is_empty()).then(|| proposal(json!(values), &values.join(", ")))
        }
        "relation" => {
            let wanted = text.to_lowercase();
            if let Some(found) = candidates
                .iter()
                .find(|candidate| js_trim(&candidate.title).to_lowercase() == wanted)
            {
                let uri = format!("memry://note/{}", found.note_id);
                return Some(proposal(json!([uri]), &found.title));
            }
            let target = field.relation.as_ref()?.target.clone()?;
            Some(FieldFillProposal {
                create: Some(FillCreate {
                    title: text.to_owned(),
                    tag: target,
                }),
                ..proposal(Value::Null, text)
            })
        }
        _ => Some(proposal(json!(text), text)),
    }
}
