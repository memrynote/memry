//! Filing a text capture into a note, and converting it (spec 006 IB025,
//! IB026): desktop's `apps/desktop/src/main/inbox/filing.ts`.
//!
//! **One difference, and why.** Desktop builds the filed note as markdown
//! (`generateNoteContent`) and writes the file; its editor turns the markdown
//! into the note's document. This core parses no markdown (chapter 12 §12.1),
//! and a phone note's body is its CRDT document, so the same structure is
//! written as blocks: the link mention, the quoted description, the meta
//! lines, the divider and the "Filed from Inbox on …" line are each the block
//! desktop's markdown becomes. The note's `content` stays `""`, the phone's
//! convention for every note it creates (`NotesWriter::create`).
//!
//! Binary captures (image, voice, PDF, video) are filed by the shell, which
//! holds the file: it uploads it into the note created here
//! ([`create_filed_note`]) and then marks the capture filed.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::crdt::body_edit::BlockEdit;
use crate::domain::body_write;
use crate::domain::folders;
use crate::domain::notes::{self, NewNote, failed};
use crate::storage::repositories::schema::Object;

use super::write::{mark_filed, require_live};
use super::{InboxItem, urls};

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// The shell's local calendar day and minute, `YYYY-MM-DDTHH:MM`: desktop
/// formats its filing dates in local time.
#[derive(Debug, Clone)]
pub struct LocalStamp {
    pub date: String,
    pub time: String,
}

impl LocalStamp {
    /// Parses `YYYY-MM-DDTHH:MM[:SS]`.
    pub fn parse(text: &str) -> Option<Self> {
        let (date, time) = text.split_once('T')?;
        (date.len() == 10 && time.len() >= 5).then(|| Self {
            date: date.to_owned(),
            time: time[..5].to_owned(),
        })
    }

    /// `toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})`.
    fn display(&self) -> String {
        let mut parts = self.date.split('-');
        let year = parts.next().unwrap_or_default();
        let month: usize = parts.next().and_then(|m| m.parse().ok()).unwrap_or(1);
        let day: u32 = parts.next().and_then(|d| d.parse().ok()).unwrap_or(1);
        format!("{} {day}, {year}", MONTHS[month.clamp(1, 12) - 1])
    }
}

/// `generateNoteTitle`.
pub fn note_title(item: &InboxItem, now: &LocalStamp) -> String {
    let title = item.title.trim();
    let is_bare_link =
        item.item_type == "link" && item.source_url.as_deref() == Some(item.title.as_str());
    if !title.is_empty() && !is_bare_link {
        return title.to_owned();
    }
    let fallback = format!("Inbox Note - {} {}", now.date, now.time);
    if item.item_type == "link" {
        return item
            .source_url
            .as_deref()
            .and_then(|url| url.split_once("://").map(|(_, rest)| rest))
            .and_then(|rest| rest.split(['/', '?', '#']).next())
            .filter(|host| !host.is_empty())
            .map_or(fallback, |host| format!("Link from {host}"));
    }
    if let Some(content) = &item.content {
        let first = content.split('\n').next().unwrap_or_default().trim();
        if !first.is_empty() && first.encode_utf16().count() <= 100 {
            return first.trim_start_matches('#').trim_start().to_owned();
        }
    }
    fallback
}

/// One block of a filed note.
#[derive(Debug, Clone, PartialEq)]
pub struct BlockSpec {
    pub kind: &'static str,
    pub text: String,
    /// An inline node over the block's first `text.len()` bytes: `(kind,
    /// text, attrs)`. The block's text starts with that same text, so the
    /// range sits in one run (an empty block has no run to insert into).
    pub lead: Option<(&'static str, String, HashMap<String, String>)>,
    /// `(mark, value)` over the first `len` bytes of `text` (ASCII only).
    pub marks: Vec<(&'static str, Option<String>, usize)>,
    pub props: Vec<(&'static str, String)>,
}

impl BlockSpec {
    fn new(kind: &'static str, text: impl Into<String>) -> Self {
        Self {
            kind,
            text: text.into(),
            lead: None,
            marks: Vec::new(),
            props: Vec::new(),
        }
    }

    fn marked(mut self, mark: &'static str, value: Option<String>, len: usize) -> Self {
        if self.text.is_ascii() || self.text[..len.min(self.text.len())].is_ascii() {
            self.marks.push((mark, value, len));
        }
        self
    }
}

/// Paragraph-level blocks for plain text: `#` headings, `>` quotes, `-`
/// bullets, blank-line paragraphs.
fn text_blocks(text: &str) -> Vec<BlockSpec> {
    let mut out = Vec::new();
    for chunk in text.split("\n\n").map(str::trim).filter(|c| !c.is_empty()) {
        for line in chunk
            .lines()
            .map(str::trim_end)
            .filter(|l| !l.trim().is_empty())
        {
            let hashes = line.chars().take_while(|c| *c == '#').count();
            if (1..=3).contains(&hashes) && line[hashes..].starts_with(' ') {
                let mut block = BlockSpec::new("heading", line[hashes + 1..].trim());
                block.props.push(("level", hashes.to_string()));
                out.push(block);
            } else if let Some(rest) = line.strip_prefix("> ") {
                out.push(BlockSpec::new("quote", rest));
            } else if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
                out.push(BlockSpec::new("bulletListItem", rest));
            } else {
                out.push(BlockSpec::new("paragraph", line));
            }
        }
    }
    out
}

fn filed_line(now: &LocalStamp) -> Vec<BlockSpec> {
    let text = format!("Filed from Inbox on {}", now.display());
    let len = text.len();
    vec![
        BlockSpec::new("divider", ""),
        BlockSpec::new("paragraph", text).marked("italic", None, len),
    ]
}

/// `generateNoteContent`, as blocks.
pub fn note_blocks(item: &InboxItem, now: &LocalStamp) -> Vec<BlockSpec> {
    let mut out = Vec::new();
    let meta = item.metadata.as_ref();
    let meta_text = |key: &str| {
        meta.and_then(|m| m.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    match item.item_type.as_str() {
        "link" => {
            let url = item.source_url.clone().unwrap_or_default();
            let domain = urls::domain(&url).unwrap_or_else(|| url.clone());
            let title = item.title.clone();
            let mention = if !title.is_empty() && title != url {
                format!("{domain} \u{00B7} {title}")
            } else {
                domain.clone()
            };
            if !url.is_empty() {
                let attrs = HashMap::from([
                    ("url".to_owned(), url.clone()),
                    ("domain".to_owned(), domain),
                    ("title".to_owned(), title),
                    (
                        "favicon".to_owned(),
                        meta_text("favicon").unwrap_or_default(),
                    ),
                    (
                        "siteName".to_owned(),
                        meta_text("siteName").unwrap_or_default(),
                    ),
                ]);
                let mut block = BlockSpec::new("paragraph", mention.clone());
                block.lead = Some(("linkMention", mention, attrs));
                out.push(block);
            }
            let description = item.content.clone().unwrap_or_default();
            let article = matches!(
                meta_text("extractionStatus").as_deref(),
                Some("full" | "partial")
            );
            if article && !description.is_empty() {
                out.extend(text_blocks(&description));
            } else {
                if !description.is_empty() {
                    out.push(BlockSpec::new("quote", description));
                }
                for (label, key) in [
                    ("Author:", "author"),
                    ("Site:", "siteName"),
                    ("Published:", "publishedDate"),
                ] {
                    if let Some(value) = meta_text(key) {
                        let text = format!("{label} {value}");
                        out.push(BlockSpec::new("paragraph", text).marked(
                            "bold",
                            None,
                            label.len(),
                        ));
                    }
                }
            }
        }
        "social" => {
            let url = item.source_url.clone().unwrap_or_default();
            out.push(BlockSpec::new("paragraph", "Open Original").marked("link", Some(url), 13));
            if let Some(handle) = meta_text("authorHandle").filter(|h| !h.is_empty()) {
                let name = meta_text("authorName").filter(|n| !n.is_empty());
                let text = name.map_or(handle.clone(), |n| format!("{handle} ({n})"));
                out.push(BlockSpec::new("paragraph", text).marked("bold", None, handle.len()));
            }
            let post = meta_text("postContent")
                .filter(|p| !p.is_empty())
                .or_else(|| item.content.clone())
                .unwrap_or_default();
            for line in post.lines().filter(|l| !l.trim().is_empty()) {
                out.push(BlockSpec::new("quote", line));
            }
        }
        _ => {
            out.extend(text_blocks(item.content.as_deref().unwrap_or_default()));
            if item.item_type == "clip"
                && let Some(url) = &item.source_url
            {
                {
                    let label = item.source_title.clone().unwrap_or_else(|| url.clone());
                    let text = format!("Source: {label}");
                    let block = BlockSpec::new("paragraph", text).marked("bold", None, 7);
                    let len = block.text.len();
                    out.push(block.marked("link", Some(url.clone()), len));
                }
            }
        }
    }
    out.extend(filed_line(now));
    out
}

/// Writes `blocks` into an empty note's body, in order.
pub fn write_blocks(
    conn: &Connection,
    note_id: &str,
    blocks: &[BlockSpec],
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let mut after: Option<String> = None;
    for block in blocks {
        let id = super::write::mint_id();
        let mut edits = vec![BlockEdit::InsertBlock {
            kind: block.kind.to_owned(),
            after_block_id: after.clone(),
            text: block.text.clone(),
            new_block_id: id.clone(),
        }];
        for (name, value) in &block.props {
            edits.push(BlockEdit::SetProp {
                block_id: id.clone(),
                name: (*name).to_owned(),
                value: value.clone(),
            });
        }
        for (mark, value, len) in &block.marks {
            if *len > 0 {
                edits.push(BlockEdit::SetMark {
                    block_id: id.clone(),
                    start: 0,
                    end: *len as u32,
                    mark: (*mark).to_owned(),
                    value: value.clone(),
                });
            }
        }
        if let Some((kind, text, attrs)) = &block.lead {
            edits.push(BlockEdit::InsertInline {
                block_id: id.clone(),
                start: 0,
                end: text.len() as u32,
                kind: (*kind).to_owned(),
                text: text.clone(),
                attrs: attrs.clone(),
            });
        }
        for edit in &edits {
            body_write::edit_block(conn, note_id, edit, device_id, now_ms).map_err(|error| {
                StorageError::Failed {
                    what: format!("the filed note's body: {error}"),
                }
            })?;
        }
        after = Some(id);
    }
    Ok(())
}

/// The vault-relative path desktop's file takes: `folder/Title.md`.
pub fn note_path(folder: Option<&str>, title: &str) -> String {
    let base: String = title
        .chars()
        .filter(|c| !"<>:\"/\\|?*".contains(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_start_matches('.')
        .to_owned();
    let base = if base.is_empty() {
        "Untitled".to_owned()
    } else {
        base
    };
    match folder.filter(|f| !f.is_empty()) {
        Some(folder) => format!("{folder}/{base}.md"),
        None => format!("{base}.md"),
    }
}

/// `ensureFolderExists`: a folder the vault does not hold yet is created,
/// parents first.
pub fn ensure_folder(
    conn: &Connection,
    folder: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let mut path = String::new();
    for segment in folder.split('/').filter(|s| !s.is_empty()) {
        if !path.is_empty() {
            path.push('/');
        }
        path.push_str(segment);
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM folders WHERE path = ?1 AND deleted_at IS NULL",
                [&path],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?;
        if exists.is_none() {
            folders::create(conn, &path, None, device_id, now_ms)?.acknowledge();
        }
    }
    Ok(())
}

/// Item tags + `inbox`, deduplicated (`mergedTags`).
pub fn merged_tags(item: &InboxItem, extra: &[String]) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for tag in item
        .tags
        .iter()
        .chain(extra)
        .map(|t| t.trim().to_owned())
        .chain(["inbox".to_owned()])
    {
        if !tag.is_empty() && !tags.iter().any(|t| t.eq_ignore_ascii_case(&tag)) {
            tags.push(tag);
        }
    }
    tags
}

/// A note for a capture: created, tagged, bodied. Returns `(id, path)`.
#[allow(clippy::too_many_arguments)]
pub fn create_filed_note(
    conn: &Connection,
    item: &InboxItem,
    folder: Option<&str>,
    tags: &[String],
    with_body: bool,
    now: &LocalStamp,
    device_id: &str,
    now_ms: i64,
) -> Result<(String, String), StorageError> {
    if let Some(folder) = folder.filter(|f| !f.is_empty()) {
        ensure_folder(conn, folder, device_id, now_ms)?;
    }
    let title = note_title(item, now);
    let id = super::write::mint_id();
    let properties: Option<Object> = item
        .metadata
        .as_ref()
        .and_then(|m| m.get("properties"))
        .and_then(Value::as_object)
        .cloned();
    let merged = merged_tags(item, tags);
    notes::create(
        conn,
        &NewNote {
            id: &id,
            title: &title,
            folder_path: folder.filter(|f| !f.is_empty()),
            content: "",
            tags: &merged,
            properties: properties.as_ref(),
        },
        device_id,
        now_ms,
    )?
    .acknowledge();
    if with_body {
        write_blocks(conn, &id, &note_blocks(item, now), device_id, now_ms)?;
    }
    Ok((id, note_path(folder, &title)))
}

/// `fileToFolder` (text types) and `convertToNote` (`folder = None`,
/// action `note`).
#[allow(clippy::too_many_arguments)]
pub fn file_text(
    conn: &Connection,
    item_id: &str,
    folder: Option<&str>,
    tags: &[String],
    action: &str,
    now: &LocalStamp,
    device_id: &str,
    now_ms: i64,
) -> Result<(String, String), StorageError> {
    let item = require_live(conn, item_id)?;
    if item.filed_at.is_some() {
        return Err(StorageError::Invalid {
            what: "Item has already been filed".to_owned(),
        });
    }
    if super::BINARY_TYPES.contains(&item.item_type.as_str()) {
        return Err(StorageError::Invalid {
            what: "a file capture is filed with its file".to_owned(),
        });
    }
    let (id, path) = create_filed_note(conn, &item, folder, tags, true, now, device_id, now_ms)?;
    mark_filed(conn, item_id, &path, action, device_id, now_ms)?.acknowledge();
    Ok((id, path))
}
