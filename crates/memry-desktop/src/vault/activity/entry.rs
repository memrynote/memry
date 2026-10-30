//! One line of `.memry/activity.jsonl`: what a reader takes from it, and the bytes a new entry
//! is written as (`VaultActivityEntrySchema`, `packages/contracts/src/vault-activity-api.ts`).
//!
//! A line that is a JSON object is kept as it is on disk, byte for byte, for as long as the
//! retention window and the entry cap keep it: a field or a kind this build does not know (a
//! newer build's) survives every rewrite. It is listed only when it passes the v1 schema
//! Electron's reader applies. A line that is not a JSON object is a torn write or a hand edit
//! gone wrong, and the next rewrite drops it, as Electron's does.
//!
//! JavaScript's `JSON.parse` and serde_json read the same lines, but for:
//! - a lone UTF-16 surrogate escape (`"\ud83d"`), which `JSON.parse` takes and serde_json
//!   refuses. Electron writes one when it cuts a message inside an emoji. Such a line is read
//!   with U+FFFD in place of the surrogate; its bytes on disk stay as they are;
//! - nesting deeper than serde_json's 128 levels, or a number past `f64`, which `JSON.parse`
//!   takes. No writer puts either in a line; such a line is dropped.

use std::cell::Cell;
use std::collections::BTreeMap;

use memry_core::storage::repositories::instants::to_epoch_ms;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `VAULT_ACTIVITY_MAX_ITEMS`: sample items kept with a summary entry.
pub const MAX_ITEMS: usize = 50;
/// A longer message is cut to this many UTF-16 units, then `…`.
pub const MAX_MESSAGE_UNITS: usize = 500;

/// `VAULT_ACTIVITY_KINDS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename = "VaultActivityKind", rename_all = "lowercase")]
pub enum ActivityKind {
    Added,
    Removed,
    Renamed,
    Skipped,
    Failed,
    Scan,
    Import,
}

/// `VAULT_ACTIVITY_SOURCES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename = "VaultActivitySource", rename_all = "lowercase")]
pub enum ActivitySource {
    Watcher,
    Scan,
    Import,
    Drop,
    Sync,
}

impl ActivityKind {
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "added" => Self::Added,
            "removed" => Self::Removed,
            "renamed" => Self::Renamed,
            "skipped" => Self::Skipped,
            "failed" => Self::Failed,
            "scan" => Self::Scan,
            "import" => Self::Import,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Removed => "removed",
            Self::Renamed => "renamed",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
            Self::Scan => "scan",
            Self::Import => "import",
        }
    }
}

impl ActivitySource {
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "watcher" => Self::Watcher,
            "scan" => Self::Scan,
            "import" => Self::Import,
            "drop" => Self::Drop,
            "sync" => Self::Sync,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Watcher => "watcher",
            Self::Scan => "scan",
            Self::Import => "import",
            Self::Drop => "drop",
            Self::Sync => "sync",
        }
    }
}

/// An entry as the renderer lists it: the fields of the v1 schema, nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename = "VaultActivityEntry", rename_all = "camelCase")]
pub struct ActivityEntry {
    /// Always 1.
    pub v: u8,
    pub id: String,
    /// ISO timestamp.
    pub at: String,
    pub kind: ActivityKind,
    pub source: ActivitySource,
    /// Vault-relative path, when the entry is about one file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub old_path: Option<String>,
    /// A coded reason; a code from a newer build still parses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub importer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Numbers as JSON reads them; integers in every writer.
    #[specta(optional, type = BTreeMap<String, i32>)]
    pub counts: Option<BTreeMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = Vec<String>)]
    pub items: Option<Vec<String>>,
}

impl ActivityEntry {
    /// `isProblem`: skipped and failed entries, and summaries that count either.
    pub fn is_problem(&self) -> bool {
        if matches!(self.kind, ActivityKind::Skipped | ActivityKind::Failed) {
            return true;
        }
        let count = |key: &str| {
            self.counts
                .as_ref()
                .and_then(|counts| counts.get(key))
                .copied()
                .unwrap_or(0.0)
        };
        count("failed") > 0.0 || count("skipped") > 0.0 || count("unsupported") > 0.0
    }

    /// The path of an unsupported file this entry reported, so it is not reported again.
    pub fn reported_skip(&self) -> Option<&str> {
        let path = self.path.as_deref().filter(|path| !path.is_empty())?;
        (self.kind == ActivityKind::Skipped && self.reason.as_deref() == Some("unsupported-type"))
            .then_some(path)
    }
}

/// A line the log keeps.
#[derive(Debug, Clone)]
pub struct Line {
    /// Exactly as on disk, without its `\n`.
    pub raw: String,
    /// Epoch milliseconds of `at`; `None` when there is none this build can read, which no
    /// retention window drops.
    pub at_ms: Option<i64>,
    /// `None` for a line the v1 schema refuses: kept, never listed.
    pub entry: Option<ActivityEntry>,
}

pub enum Read {
    /// Boxed: the other variants carry nothing (clippy::large_enum_variant).
    Line(Box<Line>),
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
fn is_blank(line: &str) -> bool {
    line.chars()
        .all(|c| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

pub fn read_line(raw: &str) -> Read {
    if is_blank(raw) {
        return Read::Blank;
    }
    step(raw.len());
    let value = match serde_json::from_str::<Value>(raw) {
        Ok(value) => value,
        Err(_) if raw.contains("\\u") => {
            step(raw.len());
            match serde_json::from_str::<Value>(&replace_lone_surrogates(raw)) {
                Ok(value) => value,
                Err(_) => return Read::Garbage,
            }
        }
        Err(_) => return Read::Garbage,
    };
    let Value::Object(object) = value else {
        return Read::Garbage;
    };
    Read::Line(Box::new(Line {
        raw: raw.to_owned(),
        at_ms: object
            .get("at")
            .and_then(Value::as_str)
            .and_then(to_epoch_ms),
        entry: entry_of(&object),
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

/// What zod's `VaultActivityEntrySchema.safeParse` accepts, with the unknown keys dropped.
fn entry_of(object: &Map<String, Value>) -> Option<ActivityEntry> {
    if object.get("v")?.as_f64()? != 1.0 {
        return None;
    }
    let required = |key: &str| {
        object
            .get(key)?
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    // `None` when the key holds something other than a string; `Some(None)` when it is absent.
    let optional = |key: &str| match object.get(key) {
        None => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(_) => None,
    };
    let counts = match object.get("counts") {
        None => None,
        Some(Value::Object(counts)) => Some(
            counts
                .iter()
                .map(|(name, count)| Some((name.clone(), count.as_f64()?)))
                .collect::<Option<BTreeMap<_, _>>>()?,
        ),
        Some(_) => return None,
    };
    let items = match object.get("items") {
        None => None,
        Some(Value::Array(items)) if items.len() <= MAX_ITEMS => Some(
            items
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
        ),
        Some(_) => return None,
    };
    Some(ActivityEntry {
        v: 1,
        id: required("id")?,
        at: required("at")?,
        kind: ActivityKind::parse(object.get("kind")?.as_str()?)?,
        source: ActivitySource::parse(object.get("source")?.as_str()?)?,
        path: optional("path")?,
        old_path: optional("oldPath")?,
        reason: optional("reason")?,
        message: optional("message")?,
        importer: optional("importer")?,
        counts,
        items,
    })
}

/// What a writer records (`VaultActivityInput`). `id` and `at` are the log's.
#[derive(Debug, Clone, PartialEq)]
pub struct ActivityInput {
    pub kind: ActivityKind,
    pub source: ActivitySource,
    pub path: Option<String>,
    pub old_path: Option<String>,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub importer: Option<String>,
    /// Named counts, in the order they are written.
    pub counts: Option<Vec<(String, u64)>>,
    pub items: Option<Vec<String>>,
    /// A repeat with the same key inside the window is not recorded.
    pub dedupe: Option<(String, i64)>,
}

impl ActivityInput {
    pub fn new(kind: ActivityKind, source: ActivitySource) -> Self {
        Self {
            kind,
            source,
            path: None,
            old_path: None,
            reason: None,
            message: None,
            importer: None,
            counts: None,
            items: None,
            dedupe: None,
        }
    }

    pub fn path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }

    pub fn message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    pub fn old_path(mut self, old_path: impl Into<String>) -> Self {
        self.old_path = Some(old_path.into());
        self
    }

    /// Not recorded again under `key` until `window_ms` has passed.
    pub fn dedupe(mut self, key: impl Into<String>, window_ms: i64) -> Self {
        self.dedupe = Some((key.into(), window_ms));
        self
    }

    /// The line Electron's `JSON.stringify({ v: 1, id, at, ...fields })` writes for these
    /// fields in schema order, which is the order every Electron writer of the watcher, the
    /// scan and the drop uses: a message cut to [`MAX_MESSAGE_UNITS`] UTF-16 units plus `…`,
    /// at most [`MAX_ITEMS`] items, absent fields left out.
    ///
    /// Where the cut falls inside a surrogate pair, Electron writes the lone high surrogate;
    /// this cuts before the pair, one unit shorter.
    pub fn to_line(&self, id: &str, at: &str) -> String {
        let mut line = Map::new();
        line.insert("v".into(), 1.into());
        line.insert("id".into(), id.into());
        line.insert("at".into(), at.into());
        line.insert("kind".into(), self.kind.name().into());
        line.insert("source".into(), self.source.name().into());
        let message = self.message.as_deref().map(cut_message);
        for (key, value) in [
            ("path", self.path.as_deref()),
            ("oldPath", self.old_path.as_deref()),
            ("reason", self.reason.as_deref()),
            ("message", message.as_deref()),
            ("importer", self.importer.as_deref()),
        ] {
            if let Some(value) = value {
                line.insert(key.into(), value.into());
            }
        }
        if let Some(counts) = &self.counts {
            let counts: Map<String, Value> = counts
                .iter()
                .map(|(name, count)| (name.clone(), (*count).into()))
                .collect();
            line.insert("counts".into(), counts.into());
        }
        if let Some(items) = &self.items {
            let items: Vec<Value> = items
                .iter()
                .take(MAX_ITEMS)
                .map(|i| i.as_str().into())
                .collect();
            line.insert("items".into(), items.into());
        }
        Value::Object(line).to_string()
    }
}

fn cut_message(message: &str) -> String {
    if message.encode_utf16().count() <= MAX_MESSAGE_UNITS {
        return message.to_owned();
    }
    let mut units = 0;
    let end = message
        .char_indices()
        .find(|(_, c)| {
            units += c.len_utf16();
            units > MAX_MESSAGE_UNITS
        })
        .map_or(message.len(), |(at, _)| at);
    format!("{}…", &message[..end])
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
    fn a_message_is_cut_by_utf16_units_and_never_inside_a_pair() {
        let long = "a".repeat(600);
        assert_eq!(cut_message(&long), format!("{}…", "a".repeat(500)));
        let emoji = format!("{}😀b", "a".repeat(499));
        assert_eq!(cut_message(&emoji), format!("{}…", "a".repeat(499)));
        assert_eq!(cut_message("short"), "short");
    }

    #[test]
    fn blank_follows_javascript_trim() {
        assert!(is_blank(" \t\r\u{feff}\u{a0}\u{2028}"));
        assert!(!is_blank("\u{85}"));
    }
}
