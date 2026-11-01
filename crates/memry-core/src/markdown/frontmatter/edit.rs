//! Port of desktop `vault/frontmatter-edit.ts` and `serializeUpdatedNote` (`vault/frontmatter.ts`):
//! a frontmatter edit changes the block in place. A key whose value did not change keeps its
//! lines byte for byte, a changed key gets new lines where the old ones were, a removed key
//! loses its lines and a new key goes at the end. Comments, blank lines, quoting, key order and
//! line ends survive. Re-stringifying the whole block would reorder keys and re-spell every
//! scalar (`due: 2026-10-07` becomes an ISO timestamp), so that happens only for a block whose
//! lines cannot be matched one to one with the keys it parses to (anchors, duplicate keys, a
//! flow mapping).

use std::collections::HashSet;
use std::sync::Arc;

use super::js::{civil_from_days, date_utc, days_from_civil, is_js_whitespace, iso_string};
use super::note::{
    Eol, ParsedMarkdownNote, entries_of, gray_matter_data, serialize_parsed_markdown_note,
    stringify_frontmatter_block,
};
use super::value::{MAX_YAML_DUMP_DEPTH, YamlMap, YamlValue};
use super::yaml_load::YamlError;

const MS_PER_DAY: i64 = 86_400_000;
const MIDNIGHT: &str = "T00:00:00.000Z";

enum Segment<'a> {
    /// A top-level entry with its continuation lines.
    Entry {
        key: String,
        value: YamlValue,
        lines: &'a [&'a str],
    },
    /// A blank or comment line between entries.
    Loose(&'a str),
}

fn without_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// `/^(?:[^\s#-]|-\S)/`
fn starts_entry(line: &str) -> bool {
    let mut chars = line.chars();
    match chars.next() {
        Some('-') => chars.next().is_some_and(|c| !is_js_whitespace(c)),
        Some(c) => !is_js_whitespace(c) && c != '#',
        None => false,
    }
}

/// `/^(?:[ \t]|-(?:\s|$))/`
fn continues_entry(line: &str) -> bool {
    let mut chars = line.chars();
    match chars.next() {
        Some(' ' | '\t') => true,
        Some('-') => chars.next().is_none_or(is_js_whitespace),
        _ => false,
    }
}

/// `matter('---\n' + lines + '\n---\n', {}).data` as `Object.entries` sees it, or `None` when
/// the lines do not parse.
fn read_yaml(lines: &[&str]) -> Option<YamlMap> {
    let text = lines
        .iter()
        .map(|line| without_cr(line))
        .collect::<Vec<_>>()
        .join("\n");
    gray_matter_data(&format!("---\n{text}\n---\n"))
        .ok()
        .map(|data| entries_of(&data))
}

/// Top-level entries with their continuation lines; blank and comment lines between them stand
/// alone. `None` when an entry's lines do not parse to exactly one key.
fn segment<'a>(lines: &'a [&'a str]) -> Option<Vec<Segment<'a>>> {
    let mut segments = Vec::new();
    let mut start = 0;
    while start < lines.len() {
        if !starts_entry(without_cr(lines[start])) {
            segments.push(Segment::Loose(lines[start]));
            start += 1;
            continue;
        }
        let mut end = start + 1;
        for (next, line) in lines.iter().enumerate().skip(end) {
            let line = without_cr(line);
            if starts_entry(line) {
                break;
            }
            if continues_entry(line) {
                end = next + 1;
            }
        }
        let entry = &lines[start..end];
        let data = read_yaml(entry).unwrap_or_default();
        if data.len() != 1 {
            return None;
        }
        let (key, value) = data.iter().next().expect("one entry");
        segments.push(Segment::Entry {
            key: key.to_owned(),
            value: value.clone(),
            lines: entry,
        });
        start = end;
    }
    Some(segments)
}

thread_local! {
    static EQUAL_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Values [`deep_strict_equal`] has visited on this thread, for tests that bound its work by
/// steps rather than by the clock.
#[doc(hidden)]
pub fn equal_visits() -> usize {
    EQUAL_VISITS.with(std::cell::Cell::get)
}

/// `util.isDeepStrictEqual` over frontmatter values: numbers compare as `Object.is` does (`NaN`
/// equals itself, `0` is not `-0`), dates by their time, maps whatever their key order. A pair
/// of collections found equal once is not walked again, so values that share subtrees through
/// aliases compare in time linear in the text. Values nested deeper than the dumper writes are
/// unequal, so an edit to one fails where it is written instead of overflowing the stack here.
pub fn deep_strict_equal(a: &YamlValue, b: &YamlValue) -> bool {
    // One level more than the dumper's collections: their leaves.
    equal(a, b, MAX_YAML_DUMP_DEPTH + 1, &mut HashSet::new())
}

fn equal(a: &YamlValue, b: &YamlValue, depth: usize, same: &mut HashSet<(usize, usize)>) -> bool {
    EQUAL_VISITS.with(|visits| visits.set(visits.get() + 1));
    let Some(depth) = depth.checked_sub(1) else {
        return false;
    };
    match (a, b) {
        (YamlValue::Null, YamlValue::Null) => true,
        (YamlValue::Bool(a), YamlValue::Bool(b)) => a == b,
        (YamlValue::Number(a), YamlValue::Number(b)) => {
            a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()) || (a == b && *a != 0.0)
        }
        (YamlValue::String(a), YamlValue::String(b)) => a == b,
        (YamlValue::Date(a), YamlValue::Date(b)) => a == b,
        (YamlValue::Binary(a), YamlValue::Binary(b)) => a == b,
        (YamlValue::Seq(a), YamlValue::Seq(b)) => once(a, b, same, |same| {
            a.len() == b.len()
                && a.iter()
                    .zip(b.iter())
                    .all(|(a, b)| equal(a, b, depth, same))
        }),
        (YamlValue::Map(a), YamlValue::Map(b)) => once(a, b, same, |same| {
            a.len() == b.len()
                && a.iter().all(|(key, value)| {
                    b.get(key)
                        .is_some_and(|other| equal(value, other, depth, same))
                })
        }),
        _ => false,
    }
}

/// `compare` for a pair of collections not already found equal; a pair found unequal ends the
/// whole comparison, so only equal pairs are remembered.
fn once<T>(
    a: &Arc<T>,
    b: &Arc<T>,
    same: &mut HashSet<(usize, usize)>,
    compare: impl FnOnce(&mut HashSet<(usize, usize)>) -> bool,
) -> bool {
    let pair = (Arc::as_ptr(a) as usize, Arc::as_ptr(b) as usize);
    if Arc::ptr_eq(a, b) || same.contains(&pair) {
        return true;
    }
    let equal = compare(same);
    if equal {
        same.insert(pair);
    }
    equal
}

/// `parseYamlDate` (`vault/yaml-dates.ts`): the date a string spells as YAML or as the index's
/// JSON text of a date (`"2026-10-07T00:00:00.000Z"`, quotes included), else `None`.
fn parse_yaml_date(value: &str) -> Option<i64> {
    let text = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .filter(|inner| inner.len() == 24 && inner.as_bytes()[19] == b'.' && inner.ends_with('Z'))
        .unwrap_or(value);
    let bytes = text.as_bytes();
    let digits = |from: usize, len: usize| -> Option<i64> {
        let part = text.get(from..from + len)?;
        if !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let (year, month, day) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    // `Date.UTC(year, month - 1, day)` must land on that day; it reads years 0 to 99 as 19xx.
    let (_, landed_month, landed_day) =
        civil_from_days(date_utc(year, month - 1, day, 0, 0, 0, 0).div_euclid(MS_PER_DAY));
    if landed_month != month || landed_day != day {
        return None;
    }
    let midnight = days_from_civil(year, month, day) * MS_PER_DAY;
    if bytes.len() == 10 {
        return Some(midnight);
    }
    if bytes.len() < 20 || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let (hour, minute, second) = (digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    let mut rest = &text[19..];
    let mut fraction = 0;
    if let Some(after) = rest.strip_prefix('.') {
        let count = after.bytes().take_while(u8::is_ascii_digit).count();
        if count == 0 {
            return None;
        }
        fraction = format!("{:0<3}", &after[..count.min(3)])
            .parse::<i64>()
            .ok()?;
        rest = &after[count..];
    }
    let offset_minutes = match rest {
        "Z" => 0,
        zone => {
            let sign = match zone.as_bytes().first() {
                Some(b'+') => 1,
                Some(b'-') => -1,
                _ => return None,
            };
            if zone.len() != 6 || zone.as_bytes()[3] != b':' {
                return None;
            }
            let at = |from: usize| {
                let part = &zone[from..from + 2];
                part.bytes()
                    .all(|byte| byte.is_ascii_digit())
                    .then(|| part.parse::<i64>().ok())?
            };
            let (hours, minutes) = (at(1)?, at(4)?);
            if hours > 23 || minutes > 59 {
                return None;
            }
            sign * (hours * 60 + minutes)
        }
    };
    // `new Date(text)`: 24:00 only as the end of the day, no 60th minute or second.
    let end_of_day = hour == 24 && minute == 0 && second == 0 && fraction == 0;
    if (hour > 23 && !end_of_day) || minute > 59 || second > 59 {
        return None;
    }
    Some(midnight + ((hour * 60 + minute - offset_minutes) * 60 + second) * 1000 + fraction)
}

/// `spellYamlDate`: `2026-10-07` for a date at UTC midnight, else the ISO timestamp.
fn spell_yaml_date(ms: i64) -> String {
    let iso = iso_string(ms);
    iso.strip_suffix(MIDNIGHT)
        .map_or_else(|| iso.clone(), str::to_owned)
}

/// `valueToWrite`: a string that spells a date stays a date where the file held one.
fn value_to_write(previous: &YamlValue, value: &YamlValue) -> YamlValue {
    match (previous, value) {
        (YamlValue::Date(_), YamlValue::String(text)) => {
            parse_yaml_date(text).map_or_else(|| value.clone(), YamlValue::Date)
        }
        _ => value.clone(),
    }
}

/// `entryLines`: the lines one key is stringified to, a date spelled as the file spells one.
fn entry_lines(key: &str, value: &YamlValue, cr: &str) -> Result<Vec<String>, YamlError> {
    let mut one = YamlMap::new();
    one.insert(key.to_owned(), value.clone());
    let block = stringify_frontmatter_block(&one, Eol::Lf)?;
    let parts: Vec<&str> = block.split('\n').collect();
    let mut lines: Vec<String> = parts
        .get(1..parts.len().saturating_sub(2))
        .unwrap_or_default()
        .iter()
        .map(|line| (*line).to_owned())
        .collect();
    if let YamlValue::Date(ms) = value
        && let [line] = lines.as_mut_slice()
        && let Some(head) = line.strip_suffix(&format!(" {}", iso_string(*ms)))
    {
        *line = format!("{head} {}", spell_yaml_date(*ms));
    }
    Ok(lines.into_iter().map(|line| line + cr).collect())
}

/// `editFrontmatterBlock`: the block with `next` as its keys, `Ok(None)` when its lines cannot
/// be matched one to one with the keys it parses to (anchors, duplicate keys, a flow mapping),
/// so the caller re-stringifies instead. `reading` is the caller's reading of the block (a lone
/// `tags` value read as a list); a value equal to it or to the block's own reading is
/// unchanged. No keys is no block. An error is a value that does not stringify.
pub fn edit_frontmatter_block(
    block: &str,
    reading: &YamlMap,
    next: &YamlMap,
) -> Result<Option<String>, YamlError> {
    if next.is_empty() {
        return Ok(Some(String::new()));
    }
    let trailing_newline = block.ends_with('\n');
    let lines: Vec<&str> = block
        .strip_suffix('\n')
        .unwrap_or(block)
        .split('\n')
        .collect();
    let [open, inner @ .., close] = lines.as_slice() else {
        return Ok(None);
    };
    let (Some(previous), Some(segments)) = (read_yaml(inner), segment(inner)) else {
        return Ok(None);
    };
    let mut keys = HashSet::new();
    let mut entries = 0;
    for segment in &segments {
        if let Segment::Entry { key, value, .. } = segment {
            entries += 1;
            keys.insert(key.as_str());
            if !previous
                .get(key)
                .is_some_and(|old| deep_strict_equal(value, old))
            {
                return Ok(None);
            }
        }
    }
    if keys.len() != entries || keys.len() != previous.len() {
        return Ok(None);
    }

    let cr = if open.ends_with('\r') { "\r" } else { "" };
    let mut out: Vec<String> = vec![(*open).to_owned()];
    for segment in &segments {
        match segment {
            Segment::Loose(line) => out.push((*line).to_owned()),
            Segment::Entry { key, lines, .. } => {
                let Some(value) = next.get(key) else { continue };
                let old = previous.get(key).expect("matched above");
                let to_write = value_to_write(old, value);
                let same = deep_strict_equal(old, &to_write)
                    || reading
                        .get(key)
                        .is_some_and(|read| deep_strict_equal(read, value));
                if same {
                    out.extend(lines.iter().map(|line| (*line).to_owned()));
                } else {
                    out.extend(entry_lines(key, &to_write, cr)?);
                }
            }
        }
    }
    for (key, value) in next.iter() {
        if !keys.contains(key) {
            out.extend(entry_lines(key, value, cr)?);
        }
    }
    out.push((*close).to_owned());
    let mut edited = out.join("\n");
    if trailing_newline {
        edited.push('\n');
    }
    Ok(Some(edited))
}

/// `serializeUpdatedNote`: the file for `parsed` with `next` as its frontmatter and `content`
/// as its body. An edited block is changed in place ([`edit_frontmatter_block`]), so the keys
/// the update left alone keep their lines; a block the in-place edit cannot read is
/// re-stringified. An unedited block is kept byte for byte.
pub fn serialize_updated_note(
    parsed: ParsedMarkdownNote,
    reading: &YamlMap,
    next: YamlMap,
    content: &str,
    frontmatter_edited: bool,
) -> Result<String, YamlError> {
    let block = match (&parsed.raw_frontmatter_block, frontmatter_edited) {
        (Some(block), true) => edit_frontmatter_block(block, reading, &next)?,
        _ => None,
    };
    let (parsed, edited) = match block {
        Some(block) => (
            ParsedMarkdownNote {
                raw_frontmatter_block: Some(block),
                ..parsed
            },
            false,
        ),
        None => (
            ParsedMarkdownNote {
                frontmatter: YamlValue::map(next),
                ..parsed
            },
            frontmatter_edited,
        ),
    };
    serialize_parsed_markdown_note(&parsed, content, edited)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_date_reads_as_new_date_reads_it() {
        let at = |text: &str| parse_yaml_date(text).map(iso_string);
        assert_eq!(
            at("2026-10-07").as_deref(),
            Some("2026-10-07T00:00:00.000Z")
        );
        assert_eq!(
            at("2026-10-07T10:30:00.1234Z").as_deref(),
            Some("2026-10-07T10:30:00.123Z")
        );
        assert_eq!(
            at("2026-10-07T10:30:00+23:59").as_deref(),
            Some("2026-10-06T10:31:00.000Z")
        );
        assert_eq!(
            at("2026-10-07T24:00:00Z").as_deref(),
            Some("2026-10-08T00:00:00.000Z")
        );
        assert_eq!(
            at("\"2026-10-07T10:30:00.000Z\"").as_deref(),
            Some("2026-10-07T10:30:00.000Z")
        );
        assert_eq!(
            at("0004-02-29").as_deref(),
            Some("0004-02-29T00:00:00.000Z")
        );
        for refused in [
            "2026-02-30",
            "0050-02-29",
            "2026-10-07T24:00:01Z",
            "2026-10-07T23:60:00Z",
            "2026-10-07T10:30:00+24:00",
            "2026-10-07T10:30:00.Z",
            "2026-10-07T10:30:00",
            "\"2026-10-07\"",
            "2026-10-07 ",
        ] {
            assert_eq!(at(refused), None, "{refused}");
        }
    }

    #[test]
    fn deep_equality_is_object_is_for_numbers_and_ignores_key_order() {
        let map = |pairs: &[(&str, YamlValue)]| {
            let mut map = YamlMap::new();
            for (key, value) in pairs {
                map.insert((*key).to_owned(), value.clone());
            }
            YamlValue::map(map)
        };
        let (one, two) = (YamlValue::Number(1.0), YamlValue::Number(2.0));
        assert!(deep_strict_equal(
            &map(&[("a", one.clone()), ("b", two.clone())]),
            &map(&[("b", two.clone()), ("a", one.clone())])
        ));
        assert!(!deep_strict_equal(
            &map(&[("a", one.clone())]),
            &map(&[("a", two)])
        ));
        assert!(deep_strict_equal(
            &YamlValue::Number(f64::NAN),
            &YamlValue::Number(f64::NAN)
        ));
        assert!(!deep_strict_equal(
            &YamlValue::Number(0.0),
            &YamlValue::Number(-0.0)
        ));
        assert!(!deep_strict_equal(
            &YamlValue::Date(0),
            &YamlValue::Number(0.0)
        ));
    }
}
