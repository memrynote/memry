//! Reading one line of `.memry/activity.jsonl` (see `entry.rs` for what is kept and listed).
//!
//! The line is anyone's input, up to the whole 64 MiB file in one line, so it is never built
//! into a `serde_json::Value`. A probe takes the keys of the v1 schema, borrowing their text
//! from the line where it can, and skips every other value without allocating. A value of a
//! known key that is not what the schema takes is skipped the same way and fails the schema.
//! `counts` and `items` stop collecting at [`MAX_COUNTS`] and [`MAX_ITEMS`] names: what is held
//! for a line is a small multiple of the line, whatever it holds.
//!
//! JavaScript's `JSON.parse` and serde_json read the same lines, but for:
//! - a lone UTF-16 surrogate escape (`"\ud83d"`), which `JSON.parse` takes and serde_json
//!   refuses. Electron writes one when it cuts a message inside an emoji. Such a line is read
//!   with U+FFFD in place of the surrogate; its bytes on disk stay as they are;
//! - nesting deeper than serde_json's 128 levels, or a number past `f64`, which `JSON.parse`
//!   takes. No writer puts either in a line; such a line is dropped.

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::BTreeMap;
use std::fmt;

use memry_core::storage::repositories::instants::to_epoch_ms;
use serde::de::{Deserialize, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};

use super::entry::{ActivityEntry, ActivityKind, ActivitySource, Line, MAX_ITEMS};

/// Names a summary's `counts` lists before its entry is no longer listed. Every writer counts
/// at most seven; the schema has no bound, and a line holding a million would take a large
/// multiple of its size to list. The line itself is kept.
pub const MAX_COUNTS: usize = 64;

/// What a JSON object line says; the caller keeps its text, which this does not copy.
pub struct Parsed {
    /// Epoch milliseconds of `at`; `None` when there is none this build can read.
    pub at_ms: Option<i64>,
    pub entry: Option<ActivityEntry>,
}

impl Parsed {
    pub fn into_line(self, raw: String) -> Line {
        Line {
            raw,
            at_ms: self.at_ms,
            entry: self.entry,
        }
    }
}

pub enum Read {
    /// Boxed: the other variants carry nothing (clippy::large_enum_variant).
    Line(Box<Parsed>),
    /// Whitespace only (`String.prototype.trim` would leave nothing): skipped, as Electron skips it.
    Blank,
    /// Not a JSON object: dropped by the next rewrite.
    Garbage,
}

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Bytes the line reader has examined on this thread, for the complexity tests.
#[doc(hidden)]
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

fn step(bytes: usize) {
    STEPS.with(|steps| steps.set(steps.get() + bytes));
}

/// `String.prototype.trim(line) === ''`: JavaScript's white space and line terminators, which
/// count U+FEFF and not U+0085, unlike `char::is_whitespace`.
pub(super) fn is_blank(line: &str) -> bool {
    line.chars()
        .all(|c| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

/// Text borrowed from the line when it holds no escape.
struct Text<'a>(Cow<'a, str>);

impl<'de> Deserialize<'de> for Text<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TextVisitor;
        impl<'de> Visitor<'de> for TextVisitor {
            type Value = Text<'de>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a string")
            }
            fn visit_borrowed_str<E>(self, text: &'de str) -> Result<Self::Value, E> {
                Ok(Text(Cow::Borrowed(text)))
            }
            fn visit_str<E>(self, text: &str) -> Result<Self::Value, E> {
                Ok(Text(Cow::Owned(text.to_owned())))
            }
        }
        deserializer.deserialize_str(TextVisitor)
    }
}

/// The value of a key the schema names: what it is, or `Other`, skipped unread.
enum Scalar<'a> {
    Text(Cow<'a, str>),
    Number(f64),
    Other,
}

impl Scalar<'_> {
    fn text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }
}

struct ScalarVisitor;

impl<'de> Visitor<'de> for ScalarVisitor {
    type Value = Scalar<'de>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_borrowed_str<E>(self, text: &'de str) -> Result<Self::Value, E> {
        Ok(Scalar::Text(Cow::Borrowed(text)))
    }
    fn visit_str<E>(self, text: &str) -> Result<Self::Value, E> {
        Ok(Scalar::Text(Cow::Owned(text.to_owned())))
    }
    fn visit_f64<E>(self, n: f64) -> Result<Self::Value, E> {
        Ok(Scalar::Number(n))
    }
    #[expect(
        clippy::cast_precision_loss,
        reason = "JSON.parse reads every number as a double"
    )]
    fn visit_i64<E>(self, n: i64) -> Result<Self::Value, E> {
        Ok(Scalar::Number(n as f64))
    }
    #[expect(
        clippy::cast_precision_loss,
        reason = "JSON.parse reads every number as a double"
    )]
    fn visit_u64<E>(self, n: u64) -> Result<Self::Value, E> {
        Ok(Scalar::Number(n as f64))
    }
    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
        Ok(Scalar::Other)
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Scalar::Other)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Scalar::Other)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(Scalar::Other)
    }
}

impl<'de> Deserialize<'de> for Scalar<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ScalarVisitor)
    }
}

/// The visitor methods of a value that is not the one a key takes: it is read to its end and
/// refused, so the rest of the line still reads.
macro_rules! refuse_other_values {
    ($refused:expr) => {
        fn visit_borrowed_str<E>(self, _: &'de str) -> Result<Self::Value, E> {
            Ok($refused)
        }
        fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
            Ok($refused)
        }
        fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
            Ok($refused)
        }
        fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
            Ok($refused)
        }
        fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
            Ok($refused)
        }
        fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
            Ok($refused)
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok($refused)
        }
    };
}

/// `counts` as the schema takes it (`Some`, an object of numbers, at most [`MAX_COUNTS`]), or
/// `None`, skipped unread past the first value it refuses.
struct Counts(Option<BTreeMap<String, f64>>);

impl<'de> Deserialize<'de> for Counts {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct CountsVisitor;
        impl<'de> Visitor<'de> for CountsVisitor {
            type Value = Counts;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of numbers")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Counts, A::Error> {
                let mut counts = Some(BTreeMap::new());
                while let Some(name) = map.next_key::<Text<'de>>()? {
                    let Some(held) = counts.as_mut().filter(|held| held.len() < MAX_COUNTS) else {
                        counts = None;
                        map.next_value::<IgnoredAny>()?;
                        continue;
                    };
                    match map.next_value::<Scalar<'de>>()? {
                        Scalar::Number(n) => {
                            held.insert(name.0.into_owned(), n);
                        }
                        _ => counts = None,
                    }
                }
                Ok(Counts(counts))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Counts, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Counts(None))
            }
            refuse_other_values!(Counts(None));
        }
        deserializer.deserialize_any(CountsVisitor)
    }
}

/// `items` as the schema takes it (`Some`, at most [`MAX_ITEMS`] strings), or `None`.
struct Items(Option<Vec<String>>);

impl<'de> Deserialize<'de> for Items {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ItemsVisitor;
        impl<'de> Visitor<'de> for ItemsVisitor {
            type Value = Items;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an array of strings")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Items, A::Error> {
                let mut items = Some(Vec::new());
                while let Some(item) = seq.next_element::<Scalar<'de>>()? {
                    match (item, items.as_mut()) {
                        (Scalar::Text(text), Some(held)) if held.len() < MAX_ITEMS => {
                            held.push(text.into_owned());
                        }
                        _ => items = None,
                    }
                }
                Ok(Items(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Items, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Items(None))
            }
            refuse_other_values!(Items(None));
        }
        deserializer.deserialize_any(ItemsVisitor)
    }
}

/// The keys of the v1 schema in one JSON object; a repeated key keeps its last value, as
/// `JSON.parse` does.
#[derive(Default)]
struct Probe<'a> {
    v: Option<Scalar<'a>>,
    id: Option<Scalar<'a>>,
    at: Option<Scalar<'a>>,
    kind: Option<Scalar<'a>>,
    source: Option<Scalar<'a>>,
    path: Option<Scalar<'a>>,
    old_path: Option<Scalar<'a>>,
    reason: Option<Scalar<'a>>,
    message: Option<Scalar<'a>>,
    importer: Option<Scalar<'a>>,
    counts: Option<Counts>,
    items: Option<Items>,
}

impl<'de> Deserialize<'de> for Probe<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ProbeVisitor;
        impl<'de> Visitor<'de> for ProbeVisitor {
            type Value = Probe<'de>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Probe<'de>, A::Error> {
                let mut probe = Probe::default();
                while let Some(key) = map.next_key::<Text<'de>>()? {
                    let slot = match key.0.as_ref() {
                        "v" => &mut probe.v,
                        "id" => &mut probe.id,
                        "at" => &mut probe.at,
                        "kind" => &mut probe.kind,
                        "source" => &mut probe.source,
                        "path" => &mut probe.path,
                        "oldPath" => &mut probe.old_path,
                        "reason" => &mut probe.reason,
                        "message" => &mut probe.message,
                        "importer" => &mut probe.importer,
                        "counts" => {
                            probe.counts = Some(map.next_value()?);
                            continue;
                        }
                        "items" => {
                            probe.items = Some(map.next_value()?);
                            continue;
                        }
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                            continue;
                        }
                    };
                    *slot = Some(map.next_value()?);
                }
                Ok(probe)
            }
        }
        // A map only: an array, a string or a number is not a line any build writes.
        deserializer.deserialize_map(ProbeVisitor)
    }
}

impl Probe<'_> {
    /// What zod's `VaultActivityEntrySchema.safeParse` accepts, with the unknown keys dropped.
    fn entry(&self) -> Option<ActivityEntry> {
        let Some(Scalar::Number(v)) = self.v else {
            return None;
        };
        if v != 1.0 {
            return None;
        }
        let required = |value: &Option<Scalar<'_>>| {
            value
                .as_ref()?
                .text()
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        // `None` when the key holds something other than a string; `Some(None)` when it is absent.
        let optional = |value: &Option<Scalar<'_>>| match value {
            None => Some(None),
            Some(value) => value.text().map(|text| Some(text.to_owned())),
        };
        let counts = match &self.counts {
            None => None,
            Some(Counts(counts)) => Some(counts.clone()?),
        };
        let items = match &self.items {
            None => None,
            Some(Items(items)) => Some(items.clone()?),
        };
        Some(ActivityEntry {
            v: 1,
            id: required(&self.id)?,
            at: required(&self.at)?,
            kind: ActivityKind::parse(self.kind.as_ref()?.text()?)?,
            source: ActivitySource::parse(self.source.as_ref()?.text()?)?,
            path: optional(&self.path)?,
            old_path: optional(&self.old_path)?,
            reason: optional(&self.reason)?,
            message: optional(&self.message)?,
            importer: optional(&self.importer)?,
            counts,
            items,
        })
    }

    fn at_ms(&self) -> Option<i64> {
        self.at.as_ref()?.text().and_then(to_epoch_ms)
    }
}

/// One line, read as Electron's reader reads it.
pub fn read_line(raw: &str) -> Read {
    if is_blank(raw) {
        return Read::Blank;
    }
    step(raw.len());
    let replaced;
    let probe = match serde_json::from_str::<Probe<'_>>(raw) {
        Ok(probe) => probe,
        Err(_) if raw.contains("\\u") => {
            step(raw.len());
            replaced = replace_lone_surrogates(raw);
            match serde_json::from_str::<Probe<'_>>(&replaced) {
                Ok(probe) => probe,
                Err(_) => return Read::Garbage,
            }
        }
        Err(_) => return Read::Garbage,
    };
    Read::Line(Box::new(Parsed {
        at_ms: probe.at_ms(),
        entry: probe.entry(),
    }))
}

/// `raw` with every `\uXXXX` escape of an unpaired UTF-16 surrogate replaced by `\ufffd`, which
/// is what `JSON.parse` followed by a UTF-8 encode makes of it. One pass; an escaped backslash
/// is skipped whole, so `\\ud800` (a backslash, then text) is left alone.
fn replace_lone_surrogates(raw: &str) -> String {
    fn surrogate_at(bytes: &[u8], at: usize) -> Option<u16> {
        let hex = bytes.get(at..at + 6)?;
        if hex[0] != b'\\' || hex[1] != b'u' {
            return None;
        }
        let unit = u16::from_str_radix(std::str::from_utf8(&hex[2..]).ok()?, 16).ok()?;
        (0xD800..=0xDFFF).contains(&unit).then_some(unit)
    }
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let (mut i, mut copied) = (0, 0);
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        match surrogate_at(bytes, i) {
            Some(0xD800..=0xDBFF)
                if surrogate_at(bytes, i + 6).is_some_and(|low| low >= 0xDC00) =>
            {
                i += 12;
            }
            Some(_) => {
                out.push_str(&raw[copied..i]);
                out.push_str("\\ufffd");
                i += 6;
                copied = i;
            }
            None => i += 2,
        }
    }
    out.push_str(&raw[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lone_surrogate_escape_reads_as_a_replacement_and_a_pair_or_escaped_backslash_does_not() {
        assert_eq!(
            replace_lone_surrogates(r#"{"m":"a\ud83d"}"#),
            r#"{"m":"a\ufffd"}"#
        );
        assert_eq!(
            replace_lone_surrogates(r#"{"m":"\udc00x"}"#),
            r#"{"m":"\ufffdx"}"#
        );
        let pair = r#"{"m":"\ud83d\ude00"}"#;
        assert_eq!(replace_lone_surrogates(pair), pair);
        let escaped = r#"{"m":"\\ud800"}"#;
        assert_eq!(replace_lone_surrogates(escaped), escaped);
        assert_eq!(
            replace_lone_surrogates(r#"{"m":"\ud83d\ud83d\ude00"}"#),
            r#"{"m":"\ufffd\ud83d\ude00"}"#
        );
    }

    #[test]
    fn blank_follows_javascript_trim() {
        assert!(is_blank(" \t\r\u{feff}\u{a0}\u{2028}"));
        assert!(!is_blank("\u{85}"));
    }

    fn entry(line: &str) -> Option<ActivityEntry> {
        match read_line(line) {
            Read::Line(line) => line.entry,
            _ => panic!("not an object: {line}"),
        }
    }

    const HEAD: &str =
        r#""v":1,"id":"i","at":"2026-10-30T12:00:00.000Z","kind":"added","source":"scan""#;

    #[test]
    fn only_an_object_is_a_line_and_the_schema_decides_what_is_listed() {
        for garbage in ["[1]", "\"s\"", "1", "null", "{", "{\"v\":1"] {
            assert!(matches!(read_line(garbage), Read::Garbage), "{garbage}");
        }
        assert!(entry("{}").is_none());
        assert!(entry(&format!("{{{HEAD}}}")).is_some());
        assert!(
            entry(&format!("{{{HEAD},\"path\":null}}")).is_none(),
            "null is not absent"
        );
        assert!(
            entry(&format!("{{{HEAD},\"v\":2}}")).is_none(),
            "the last key wins"
        );
        assert!(entry(&format!("{{{HEAD},\"extra\":{{\"deep\":[1,{{}}]}}}}")).is_some());
        let items = |n: usize| format!("{{{HEAD},\"items\":[{}]}}", vec!["\"a\""; n].join(","));
        assert_eq!(
            entry(&items(MAX_ITEMS)).unwrap().items.unwrap().len(),
            MAX_ITEMS
        );
        assert!(entry(&items(MAX_ITEMS + 1)).is_none());
        assert!(entry(&format!("{{{HEAD},\"items\":[\"a\",1]}}")).is_none());
        let counts = |n: usize| {
            let names: Vec<String> = (0..n).map(|i| format!("\"c{i}\":1")).collect();
            format!("{{{HEAD},\"counts\":{{{}}}}}", names.join(","))
        };
        assert_eq!(
            entry(&counts(MAX_COUNTS)).unwrap().counts.unwrap().len(),
            MAX_COUNTS
        );
        assert!(entry(&counts(MAX_COUNTS + 1)).is_none());
        assert!(entry(&format!("{{{HEAD},\"counts\":{{\"a\":\"1\"}}}}")).is_none());
        assert!(entry(&format!("{{{HEAD},\"counts\":[1]}}")).is_none());
        assert!(entry(&format!("{{{HEAD},\"items\":{{\"a\":[1]}},\"counts\":7}}")).is_none());
        assert!(entry(&format!("{{\"counts\":[1,[2]],{HEAD}}}")).is_none());
    }
}
