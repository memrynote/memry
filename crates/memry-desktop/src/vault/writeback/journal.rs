//! The frontmatter a pass gives a journal day's file (Step 13m, #3530).
//!
//! Electron's `writebackJournal` (`sync/crdt-writeback.ts`) merges `{ ...existing, date }`, the
//! writing tools data and the document's tags into the block, and stringifies the whole block
//! again when any of them changed. Here:
//!
//! - **Tags are never written.** The core keeps a day's tags on its record, and the file's
//!   `tags:` are the author's bytes (decision on #3530: journal tags are never written back to
//!   the file).
//! - **`date` is the one key a pass sets**, to the day's date, when it writes the file for its
//!   body (a body the file already holds writes nothing, date or not), in place, and every
//!   other byte of the block stays:
//!   - an entry that already says the day (a YAML date of that day, or the `YYYY-MM-DD`
//!     string, as `normalizeDateValue` reads them) is left as it is;
//!   - a missing one is one line added before the closing fence, spelled as Electron spells a
//!     new key (`date: 'YYYY-MM-DD'`);
//!   - an entry that says another day is replaced by one line, bare when it held a YAML date
//!     (the entry's own lines go, a comment on them included; a comment line after them stays);
//!   - a file with no block gets `---\ndate: 'YYYY-MM-DD'\n---\n`, as Electron writes it.
//!
//!   A splice is kept only when the block it makes parses to the old keys with the new date,
//!   in their order. Otherwise the block is left as it is, the date is not written, and the
//!   pass logs why ([`Dated::NotInPlace`]): a flow mapping, a quoted key, a top level that is a
//!   list or a scalar, a file with no block that opens with a byte order mark.
//! - **The writing tools data is body data** the document holds (`vault::consumer`): a change
//!   to it stringifies the whole block again, as for a note and as Electron does, with the date
//!   set in it ([`set_date`]). That is the one exception to the date-only rule (Kaan, #3801
//!   review): the bytes of the other keys may be reformatted, a version of the file is kept
//!   before it is replaced, and no tag value ever comes from the record.

use memry_core::markdown::frontmatter::{
    ParsedMarkdownNote, YamlMap, YamlValue, gray_matter_data, stringify_frontmatter_block,
};
use memry_core::storage::repositories::instants::to_iso8601;

const BOM: char = '\u{feff}';
const KEY: &str = "date";

/// Sets `date` in a map whose block is stringified again anyway, unless it already says the day.
pub(super) fn set_date(map: &mut YamlMap, date: &str) {
    if !says_day(map.get(KEY), date) {
        map.insert(KEY.to_owned(), YamlValue::String(date.to_owned()));
    }
}

/// What a body write does to the block of a day's file.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Dated {
    /// The block stays: it already says the day.
    Says,
    /// The block with its `date` set in place.
    Set(String),
    /// The block stays without the day's date, for this reason: it cannot be set in place.
    NotInPlace(&'static str),
}

/// The block of the day `date`'s file with its `date` set in place, if it can be.
pub(super) fn dated_block(parsed: &ParsedMarkdownNote, raw: &str, date: &str) -> Dated {
    // A top level that is a list or a scalar is the author's; no key is added to it.
    let YamlValue::Map(map) = &parsed.frontmatter else {
        return Dated::NotInPlace("the frontmatter's top level is not a map");
    };
    let old = map.get(KEY);
    if says_day(old, date) {
        return Dated::Says;
    }
    let Some(block) = &parsed.raw_frontmatter_block else {
        if raw.starts_with(BOM) {
            return Dated::NotInPlace("a file with a byte order mark and no frontmatter");
        }
        let mut fresh = YamlMap::new();
        fresh.insert(KEY.to_owned(), YamlValue::String(date.to_owned()));
        return match stringify_frontmatter_block(&fresh, parsed.eol) {
            Ok(block) => Dated::Set(block),
            Err(_) => Dated::NotInPlace("the new frontmatter could not be written"),
        };
    };
    let lines: Vec<&str> = block.split_inclusive('\n').collect();
    // The split ends a block on its closing fence line, after at least the opening one.
    let Some((fence, inner)) = lines.split_last().filter(|(_, inner)| !inner.is_empty()) else {
        return Dated::NotInPlace("the frontmatter has no lines");
    };
    let eol = if inner[0].ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let (from, to, value) = match old {
        None => (inner.len(), inner.len(), quoted(date)),
        Some(old) => {
            let Some((from, to)) = entry_lines(inner) else {
                return Dated::NotInPlace("the date is not a plain top-level key");
            };
            let value = match old {
                YamlValue::Date(_) => date.to_owned(),
                _ => quoted(date),
            };
            (from, to, value)
        }
    };
    let line = format!("{KEY}: {value}{eol}");
    let edited = [
        &inner[..from].concat(),
        line.as_str(),
        &inner[to..].concat(),
        fence,
    ]
    .concat();
    if holds_map_with_date(&edited, map, &line) {
        Dated::Set(edited)
    } else {
        Dated::NotInPlace("a date line there would change what the frontmatter says")
    }
}

/// Whether a frontmatter value says the day `date` (`normalizeDateValue`): a YAML date on that
/// day in UTC, or the very string.
fn says_day(value: Option<&YamlValue>, date: &str) -> bool {
    match value {
        Some(YamlValue::Date(ms)) => to_iso8601(*ms).is_some_and(|iso| iso.get(..10) == Some(date)),
        Some(YamlValue::String(text)) => text == date,
        _ => false,
    }
}

/// `'YYYY-MM-DD'`: js-yaml quotes a string that would load as a date.
fn quoted(date: &str) -> String {
    format!("'{date}'")
}

/// The lines `[from, to)` of the top-level `date:` entry among a block's lines (the opening
/// fence first), with its continuation lines (`segment`, `vault/frontmatter-edit.ts`).
fn entry_lines(inner: &[&str]) -> Option<(usize, usize)> {
    let text = |line: &str| line.trim_end_matches(['\n', '\r']).to_owned();
    let from = 1 + inner.get(1..)?.iter().position(|line| {
        line.strip_prefix(KEY)
            .is_some_and(|rest| rest.trim_start_matches([' ', '\t']).starts_with(':'))
    })?;
    let mut to = from + 1;
    for (at, line) in inner.iter().enumerate().skip(from + 1) {
        let line = text(line);
        if starts_entry(&line) {
            break;
        }
        if continues_entry(&line) {
            to = at + 1;
        }
    }
    Some((from, to))
}

/// `/^(?:[^\s#-]|-\S)/`: a line that starts a top-level entry.
fn starts_entry(line: &str) -> bool {
    let mut chars = line.chars();
    match chars.next() {
        Some('-') => chars.next().is_some_and(|c| !c.is_whitespace()),
        Some(c) => !c.is_whitespace() && c != '#',
        None => false,
    }
}

/// `/^(?:[ \t]|-(?:\s|$))/`: a line that continues the entry above it. A comment line does
/// not, unless a line after it does.
fn continues_entry(line: &str) -> bool {
    let mut chars = line.chars();
    match chars.next() {
        Some(' ' | '\t') => !line.trim_start().starts_with('#'),
        Some('-') => chars.next().is_none_or(char::is_whitespace),
        _ => false,
    }
}

/// Whether `block` parses to `map` with its `date` set to what `line` says, every key where
/// it was and a new one last.
fn holds_map_with_date(block: &str, map: &YamlMap, line: &str) -> bool {
    let Ok(YamlValue::Map(written)) = gray_matter_data(&format!("---\n{line}---\n")) else {
        return false;
    };
    let Some(value) = written.get(KEY) else {
        return false;
    };
    let mut expected = map.clone();
    expected.insert(KEY.to_owned(), value.clone());
    matches!(gray_matter_data(block), Ok(YamlValue::Map(edited)) if *edited == expected)
}
