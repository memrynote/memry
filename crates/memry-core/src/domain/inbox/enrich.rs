//! Enrichment writes (spec 006 IB022, D3, D4): link previews and voice
//! transcripts written back onto a capture, never replacing a richer value a
//! peer already wrote.

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::storage::repositories::Change;
use crate::sync::outbox::Durable;

use super::write::{edit, require_live};
use super::{InboxItem, urls};

/// Merges keys into `metadata` without dropping ones a peer wrote.
///
/// D3: a richer value is never replaced by a poorer one — a key already
/// holding a non-empty value keeps it unless `overwrite` is set, and
/// `fetchStatus` only moves forward (`pending` → `failed` → `complete`).
pub fn merge_metadata(
    conn: &Connection,
    item_id: &str,
    patch: &Map<String, Value>,
    processing_status: Option<&str>,
    overwrite: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let item = require_live(conn, item_id)?;
    let mut merged = match item.metadata {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    for (key, value) in patch {
        let empty = |v: &Value| v.is_null() || v.as_str().is_some_and(str::is_empty);
        let keep = !overwrite
            && merged.get(key).is_some_and(|existing| !empty(existing))
            && (key != "fetchStatus"
                || merged.get(key).and_then(Value::as_str) == Some("complete"));
        if !keep && !(empty(value) && merged.contains_key(key)) {
            merged.insert(key.clone(), value.clone());
        }
    }
    let mut changes = vec![("metadata", Change::Set(Value::Object(merged)))];
    if let Some(status) = processing_status {
        changes.push(("processingStatus", Change::set(status)));
    }
    edit(conn, item_id, changes, device_id, now_ms)
}

/// Writes the enrichment result for a link: title (only when the stored one is
/// still the URL-derived default), description as content, metadata merged.
pub fn complete_link(
    conn: &Connection,
    item_id: &str,
    title: Option<&str>,
    description: Option<&str>,
    patch: &Map<String, Value>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let item = require_live(conn, item_id)?;
    let default_title = item.source_url.as_deref().map(urls::title_from_url);
    let mut changes: Vec<(&'static str, Change)> = Vec::new();
    if let Some(title) = title.filter(|t| !t.trim().is_empty())
        && default_title.as_deref() == Some(item.title.as_str())
    {
        changes.push(("title", Change::set(title)));
    }
    if let Some(description) = description.filter(|d| !d.is_empty())
        && item.content.as_deref().is_none_or(str::is_empty)
    {
        changes.push(("content", Change::set(description)));
    }
    let mut metadata = match item.metadata {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    for (key, value) in patch {
        let richer = metadata
            .get(key)
            .is_none_or(|v| v.is_null() || v.as_str() == Some(""));
        if richer || key == "fetchStatus" {
            metadata.insert(key.clone(), value.clone());
        }
    }
    let status = patch.get("fetchStatus").and_then(Value::as_str) == Some("failed");
    changes.push(("metadata", Change::Set(Value::Object(metadata))));
    changes.push((
        "processingStatus",
        Change::set(if status { "failed" } else { "complete" }),
    ));
    edit(conn, item_id, changes, device_id, now_ms)
}

/// The readable article for a link (`ingestArticleCapture`, enrich path): the
/// markdown replaces `content`, and `patch` (`url`, `excerpt`,
/// `extractionStatus`, `properties`) overwrites those keys, as desktop's job
/// does. Other metadata keys a peer wrote stay.
pub fn complete_article(
    conn: &Connection,
    item_id: &str,
    content_markdown: &str,
    patch: &Map<String, Value>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let item = require_live(conn, item_id)?;
    let mut metadata = match item.metadata {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    for (key, value) in patch {
        metadata.insert(key.clone(), value.clone());
    }
    edit(
        conn,
        item_id,
        vec![
            ("content", Change::set(content_markdown)),
            ("metadata", Change::Set(Value::Object(metadata))),
        ],
        device_id,
        now_ms,
    )
}

/// A voice memo's transcript and status (`pending`, `complete`, `failed`).
/// The first sentence becomes the title while it is still the default one.
pub fn set_transcription(
    conn: &Connection,
    item_id: &str,
    transcription: Option<&str>,
    status: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let item = require_live(conn, item_id)?;
    let mut changes = vec![
        ("transcriptionStatus", Change::set(status)),
        (
            "transcription",
            Change::Set(transcription.map_or(Value::Null, Value::from)),
        ),
    ];
    if let Some(title) = transcription.and_then(title_from_transcription)
        && is_default_voice_title(&item.title)
    {
        changes.push(("title", Change::set(title)));
    }
    edit(conn, item_id, changes, device_id, now_ms)
}

/// How a finished transcript renames a voice memo that still has its default title: desktop's
/// `memoNameMode` (`transcript`, `timestamp`, `none`), the timestamp formatted by the shell in
/// its local time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceMemoName {
    Transcript,
    Title(String),
    Keep,
}

/// Desktop's `transcribeAudio` start (`processing`) or `retryTranscription` reset (`pending`):
/// the status, and the last failure cleared.
pub fn start_transcription(
    conn: &Connection,
    item_id: &str,
    status: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    require_live(conn, item_id)?;
    let changes = vec![
        ("transcriptionStatus", Change::set(status)),
        ("processingError", Change::Set(Value::Null)),
    ];
    edit(conn, item_id, changes, device_id, now_ms)
}

/// Desktop's `createFailureResult`: `failed`, with the reason the item shows. A transcript a
/// peer already wrote stays.
pub fn fail_transcription(
    conn: &Connection,
    item_id: &str,
    error: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    require_live(conn, item_id)?;
    let changes = vec![
        ("transcriptionStatus", Change::set("failed")),
        ("processingError", Change::set(error)),
    ];
    edit(conn, item_id, changes, device_id, now_ms)
}

/// Desktop's `transcribeAudio` success: the transcript, `complete`, no failure, and the title
/// `name` gives while the current one is still the default.
pub fn complete_transcription(
    conn: &Connection,
    item_id: &str,
    transcription: &str,
    name: &VoiceMemoName,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let item = require_live(conn, item_id)?;
    let mut changes = vec![
        ("transcription", Change::set(transcription)),
        ("transcriptionStatus", Change::set("complete")),
        ("processingError", Change::Set(Value::Null)),
    ];
    let title = match name {
        VoiceMemoName::Transcript => title_from_transcription(transcription),
        VoiceMemoName::Title(title) => Some(title.clone()),
        VoiceMemoName::Keep => None,
    };
    if let Some(title) = title
        && is_default_voice_title(&item.title)
    {
        changes.push(("title", Change::set(title)));
    }
    edit(conn, item_id, changes, device_id, now_ms)
}

/// `isAutoGeneratedVoiceMemoTitle`.
fn is_default_voice_title(title: &str) -> bool {
    title == "Voice memo"
        || title
            .strip_prefix("Voice memo (")
            .and_then(|rest| rest.strip_suffix(')'))
            .and_then(|mmss| mmss.split_once(':'))
            .is_some_and(|(m, s)| {
                !m.is_empty()
                    && m.chars().all(|c| c.is_ascii_digit())
                    && s.len() == 2
                    && s.chars().all(|c| c.is_ascii_digit())
            })
}

/// `titleFromTranscription`: the first sentence (`^[^.!?]+[.!?]?`, so text that starts with
/// `.`, `!` or `?` is taken whole), cut to 57 and `...` past 60 UTF-16 units, as JavaScript
/// counts. A cut never splits a character, so it can keep 56 units.
fn title_from_transcription(text: &str) -> Option<String> {
    const STOPS: [char; 3] = ['.', '!', '?'];
    let trimmed = text.trim();
    let sentence = if trimmed.starts_with(STOPS) {
        trimmed
    } else {
        let end = trimmed.find(STOPS).map_or(trimmed.len(), |i| i + 1);
        trimmed[..end].trim()
    };
    if sentence.is_empty() {
        return None;
    }
    if sentence.encode_utf16().count() <= 60 {
        return Some(sentence.to_owned());
    }
    let mut units = 0;
    let head: String = sentence
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 57
        })
        .collect();
    Some(format!("{}...", head.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_voice_titles_give_way_to_the_first_sentence() {
        assert!(is_default_voice_title("Voice memo (0:42)"));
        assert!(!is_default_voice_title("Dentist"));
        assert_eq!(
            title_from_transcription("Pick up the cable. Then the dentist.").as_deref(),
            Some("Pick up the cable.")
        );
    }

    /// `^[^.!?]+[.!?]?` does not match text that starts with `.`, `!` or `?`, so Electron titles
    /// the memo with the whole text.
    #[test]
    fn a_transcript_that_starts_with_punctuation_titles_with_the_whole_text() {
        assert_eq!(
            title_from_transcription("...okay so").as_deref(),
            Some("...okay so")
        );
        assert_eq!(
            title_from_transcription(" ? Who. Then").as_deref(),
            Some("? Who. Then")
        );
    }

    /// `title.length > 60` and `slice(0, 57)` count UTF-16 units: 31 emoji are 62 units.
    #[test]
    fn the_60_limit_counts_utf16_units() {
        let emoji = "\u{1F600}".repeat(31);
        let title = title_from_transcription(&emoji).unwrap();
        assert_eq!(title, format!("{}...", "\u{1F600}".repeat(28)));
        let short = "\u{1F600}".repeat(30);
        assert_eq!(
            title_from_transcription(&short).as_deref(),
            Some(short.as_str())
        );
    }
}
