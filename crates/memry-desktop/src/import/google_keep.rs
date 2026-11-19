//! The Google Keep importer: `apps/desktop/src/main/import/google-keep/google-keep-importer.ts`
//! and `packages/importers/src/google-keep/{parse-note,map-note}.ts`.
//!
//! The person picks Takeout zips or single note `.json` files. A scan reads every note and
//! indexes every other zip entry by file name; then each note is created under `Google Keep/`
//! with its checklist as `- [ ]` lines, its color, labels, pin, archive and trash state as
//! `Keep/...` tags, its attachments appended to the body, and its Keep timestamps. Nothing is
//! written until the scan has finished, so an export that cannot be read writes nothing.

use std::cell::Cell;
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use memry_core::markdown::frontmatter::{YamlMap, js_trim};
use serde_json::{Map, Value};

use super::assets::attachment_markdown;
use super::messages::{ImportText, importing_item, status};
use super::zip::{EntryAt, Zips, too_large};
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportSink, ImportedNote,
    Importer, ImporterMeta, MAX_NOTE_JSON_BYTES, MAX_SOURCE_BYTES, read_source_text,
};
use crate::attachments::MAX_FILE_SIZE;

const ROOT: &str = "Google Keep";
const INVALID_JSON: &str = "Invalid JSON";
const NOT_FOUND: &str = "Attachment file not found";
/// The largest instant a JavaScript `Date` holds, in milliseconds either side of the epoch.
const MAX_DATE_MS: f64 = 8.64e15;

thread_local! {
    static BODY_BYTES: Cell<usize> = const { Cell::new(0) };
}

/// Bytes this thread has copied into note bodies while appending attachments.
#[doc(hidden)]
pub fn body_bytes_copied() -> usize {
    BODY_BYTES.with(Cell::get)
}

fn count_copied(bytes: usize) {
    BODY_BYTES.with(|copied| copied.set(copied.get() + bytes));
}

/// `KeepNote`: the fields of a Keep note's JSON the importer reads.
#[derive(Debug, Clone, PartialEq)]
pub struct KeepNote {
    pub title: String,
    pub text_content: String,
    /// `(text, isChecked)`.
    pub list_content: Vec<(String, bool)>,
    pub color: String,
    pub labels: Vec<String>,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub is_trashed: bool,
    /// Each attachment's `filePath`.
    pub attachments: Vec<String>,
    pub created_usec: f64,
    pub edited_usec: f64,
}

/// `MappedNote`.
#[derive(Debug, Clone, PartialEq)]
pub struct MappedNote {
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub created: String,
    pub modified: String,
    pub attachment_paths: Vec<String>,
}

fn text<'a>(raw: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    raw.get(key).and_then(Value::as_str)
}

fn items<'a>(
    raw: &'a Map<String, Value>,
    key: &str,
) -> impl Iterator<Item = &'a Map<String, Value>> + use<'a> {
    raw.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
}

/// `parseKeepNote`: `None` unless `raw` is an object with numeric `createdTimestampUsec` and
/// `userEditedTimestampUsec`, the strongest sign of a Keep note.
pub fn parse_keep_note(raw: &Value) -> Option<KeepNote> {
    let raw = raw.as_object()?;
    let created_usec = raw.get("createdTimestampUsec")?.as_f64()?;
    let edited_usec = raw.get("userEditedTimestampUsec")?.as_f64()?;
    let flag = |key: &str| raw.get(key) == Some(&Value::Bool(true));
    let labels = raw
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|label| match label {
            Value::String(name) => Some(name.clone()),
            Value::Object(label) => text(label, "name").map(str::to_owned),
            _ => None,
        })
        .collect();
    Some(KeepNote {
        title: text(raw, "title").unwrap_or("").to_owned(),
        text_content: text(raw, "textContent").unwrap_or("").to_owned(),
        list_content: items(raw, "listContent")
            .filter_map(|item| {
                let checked = item.get("isChecked") == Some(&Value::Bool(true));
                Some((text(item, "text")?.to_owned(), checked))
            })
            .collect(),
        color: text(raw, "color").unwrap_or("DEFAULT").to_owned(),
        labels,
        is_pinned: flag("isPinned"),
        is_archived: flag("isArchived"),
        is_trashed: flag("isTrashed"),
        attachments: items(raw, "attachments")
            .filter_map(|item| {
                text(item, "mimetype")?;
                text(item, "filePath").map(str::to_owned)
            })
            .collect(),
        created_usec,
        edited_usec,
    })
}

/// `mapKeepNote`. `Err` is `toISOString`'s `RangeError` message for a timestamp outside the
/// range of a JavaScript `Date`.
pub fn map_keep_note(note: &KeepNote) -> Result<MappedNote, String> {
    Ok(MappedNote {
        title: resolve_title(note),
        body: build_body(note),
        tags: build_tags(note),
        created: usec_to_iso(note.created_usec)?,
        modified: usec_to_iso(note.edited_usec)?,
        attachment_paths: note.attachments.clone(),
    })
}

fn build_body(note: &KeepNote) -> String {
    if note.list_content.is_empty() {
        return note.text_content.clone();
    }
    note.list_content
        .iter()
        .filter(|(text, _)| !js_trim(text).is_empty())
        .map(|(text, checked)| format!("- [{}] {text}", if *checked { 'x' } else { ' ' }))
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_tags(note: &KeepNote) -> Vec<String> {
    let mut tags = Vec::new();
    if !note.color.is_empty() && note.color != "DEFAULT" {
        tags.push(format!("Keep/Color/{}", note.color));
    }
    tags.extend(note.labels.iter().map(|name| format!("Keep/Label/{name}")));
    for (set, tag) in [
        (note.is_pinned, "Keep/Pinned"),
        (note.is_archived, "Keep/Archived"),
        (note.is_trashed, "Keep/Deleted"),
        (!note.attachments.is_empty(), "Keep/Attachment"),
    ] {
        if set {
            tags.push(tag.to_owned());
        }
    }
    tags
}

fn resolve_title(note: &KeepNote) -> String {
    let title = js_trim(&note.title);
    if !title.is_empty() {
        return title.to_owned();
    }
    let first_line = js_trim(note.text_content.split('\n').next().unwrap_or(""));
    if !first_line.is_empty() {
        return first_line.to_owned();
    }
    note.list_content
        .iter()
        .map(|(text, _)| js_trim(text))
        .find(|text| !text.is_empty())
        .unwrap_or("Untitled")
        .to_owned()
}

/// `new Date(Math.floor(usec / 1000)).toISOString()`, extended years included.
fn usec_to_iso(usec: f64) -> Result<String, String> {
    let ms = (usec / 1000.0).floor();
    // JSON numbers are finite, so `ms` is never NaN.
    if ms.abs() > MAX_DATE_MS {
        return Err("Invalid time value".to_owned());
    }
    let ms = ms as i64;
    let (days, in_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (year, month, day) = civil_from_days(days);
    let year = match year {
        0..=9999 => format!("{year:04}"),
        ..0 => format!("-{:06}", -year),
        _ => format!("+{year:06}"),
    };
    Ok(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    ))
}

/// Howard Hinnant's `civil_from_days`: the proleptic Gregorian date of a day count.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// An attachment the scan found: a file beside a picked `.json`, or a zip entry.
enum Asset {
    File(PathBuf),
    Entry(EntryAt),
}

/// What the scan collected: the notes in order, with their labels, and the assets by file name.
#[derive(Default)]
struct Scan {
    notes: Vec<(Value, String)>,
    assets: HashMap<String, Asset>,
    zips: Zips,
}

pub struct GoogleKeepImporter;

impl Importer for GoogleKeepImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "google-keep".to_owned(),
            name: "Google Keep".to_owned(),
            description_key: "import.sources.google-keep".to_owned(),
            file_spec: FileSpec {
                label: "Google Keep export".to_owned(),
                extensions: vec!["json".to_owned(), "zip".to_owned()],
                allow_multiple: true,
                ..FileSpec::default()
            },
            supports_preview: false,
            account_based: false,
        }
    }

    fn run(
        &self,
        input: &ImportInput,
        ctx: &mut ImportContext,
        sink: &dyn ImportSink,
    ) -> Result<(), ImportError> {
        ctx.set_phase(ImportPhase::Scanning);
        ctx.status(status("scanningExport"));

        let mut scan = Scan::default();
        for source in &input.source_paths {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let path = Path::new(source);
            let extension = path
                .extension()
                .map(|ext| ext.to_string_lossy().to_lowercase());
            match extension.as_deref() {
                Some("zip") => scan_zip(path, &mut scan, ctx)?,
                Some("json") => scan_json(path, source, &mut scan, ctx),
                _ => {}
            }
        }
        if ctx.is_cancelled() {
            return Ok(());
        }

        ctx.set_phase(ImportPhase::Importing);
        let total = scan.notes.len();
        let notes = std::mem::take(&mut scan.notes);
        for (done, (raw, label)) in notes.iter().enumerate() {
            if ctx.is_cancelled() {
                return Ok(());
            }
            import_note(raw, label, &mut scan, ctx, sink);
            ctx.report_progress(done + 1, total);
        }
        ctx.set_phase(ImportPhase::Done);
        Ok(())
    }
}

/// Every `.json` entry is a note; `.html` and `.txt` copies of a note are passed over; any other
/// entry is an asset, by file name, the last of a name winning. Note files past
/// [`MAX_NOTE_JSON_BYTES`] in all refuse the import.
fn scan_zip(path: &Path, scan: &mut Scan, ctx: &mut ImportContext) -> io::Result<()> {
    let cancel = ctx.cancel_token();
    let (notes, assets) = (&mut scan.notes, &mut scan.assets);
    let mut held = 0;
    scan.zips.walk(path, &cancel, &mut |zips, entry| {
        match entry.extension.as_str() {
            "html" | "txt" => {}
            "json" => match zips.read(entry.at, MAX_SOURCE_BYTES.min(MAX_NOTE_JSON_BYTES - held)) {
                Ok(bytes) => {
                    held += bytes.len() as u64;
                    match parse_json(&bytes) {
                        Some(raw) => notes.push((raw, entry.filepath)),
                        None => ctx.report_skipped(&entry.filepath, Some(INVALID_JSON.into())),
                    }
                }
                Err(error)
                    if error.kind() == io::ErrorKind::FileTooLarge
                        && MAX_NOTE_JSON_BYTES - held < MAX_SOURCE_BYTES =>
                {
                    return Err(io::Error::other(format!(
                        "Export holds more than {} MB of notes",
                        MAX_NOTE_JSON_BYTES / (1024 * 1024)
                    )));
                }
                Err(error) if error.kind() == io::ErrorKind::FileTooLarge => {
                    ctx.report_skipped(&entry.filepath, Some(ImportText::Text(error.to_string())));
                }
                Err(error) => return Err(error),
            },
            _ => {
                assets.insert(entry.name, Asset::Entry(entry.at));
            }
        }
        Ok(())
    })
}

/// A single note file: a read or parse failure fails the item. Its attachments are looked for
/// beside it, inside its folder only.
fn scan_json(path: &Path, label: &str, scan: &mut Scan, ctx: &mut ImportContext) {
    let raw = match read_source_text(path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(raw) => raw,
            Err(_) => return ctx.report_failed(label, INVALID_JSON),
        },
        Err(error) => return ctx.report_failed(label, &error.to_string()),
    };
    if let Some(note) = parse_keep_note(&raw) {
        let dir = path.parent().unwrap_or(Path::new(""));
        for file_path in &note.attachments {
            if ctx.is_cancelled() {
                break;
            }
            let name = posix_basename(file_path);
            if scan.assets.contains_key(&name) {
                continue;
            }
            if let Some(found) = sibling(dir, file_path) {
                scan.assets.insert(name, Asset::File(found));
            }
        }
    }
    scan.notes.push((raw, label.to_owned()));
}

/// `path.join(dir, filePath)` when it is a file inside `dir`. Electron read any path the note
/// named, `../` and absolute ones included.
fn sibling(dir: &Path, file_path: &str) -> Option<PathBuf> {
    let mut joined = dir.to_path_buf();
    for component in Path::new(file_path.trim_start_matches(['/', '\\'])).components() {
        match component {
            Component::Normal(part) => joined.push(part),
            Component::ParentDir => {
                joined.pop();
            }
            _ => {}
        }
    }
    let real = fs::canonicalize(&joined).ok()?;
    (real.starts_with(fs::canonicalize(dir).ok()?) && real.is_file()).then_some(real)
}

fn import_note(
    raw: &Value,
    label: &str,
    scan: &mut Scan,
    ctx: &mut ImportContext,
    sink: &dyn ImportSink,
) {
    let Some(note) = parse_keep_note(raw) else {
        ctx.report_skipped(label, Some("Not a Google Keep note".into()));
        return;
    };
    let mapped = match map_keep_note(&note) {
        Ok(mapped) => mapped,
        Err(error) => {
            tracing::warn!(scope = "import", "Google Keep note import failed");
            return ctx.report_failed(label, &error);
        }
    };
    ctx.status(importing_item(&mapped.title));
    // Attachments are saved under the id first; the note is then written once, whole.
    let note_id = sink.new_note_id();
    let mut body = mapped.body;
    count_copied(body.len());
    for file_path in &mapped.attachment_paths {
        if ctx.is_cancelled() {
            return;
        }
        let name = posix_basename(file_path);
        let bytes = match scan.assets.get(&name) {
            None => Err(io::Error::new(io::ErrorKind::NotFound, NOT_FOUND)),
            Some(Asset::File(path)) => read_file(path),
            Some(Asset::Entry(at)) => scan.zips.read(*at, MAX_FILE_SIZE as u64),
        };
        let bytes = match bytes {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                ctx.report_skipped(&name, Some(NOT_FOUND.into()));
                continue;
            }
            Err(error) => {
                ctx.report_skipped(&name, Some(ImportText::Text(error.to_string())));
                continue;
            }
        };
        match sink.save_attachment(&note_id, &name, &bytes) {
            Ok(saved) => {
                let markdown = attachment_markdown(&saved);
                count_copied(markdown.len() + 2);
                body.push_str("\n\n");
                body.push_str(&markdown);
                ctx.report_attachment();
            }
            Err(error) => ctx.report_skipped(&name, Some(ImportText::Text(error.0))),
        }
    }
    let created = sink.create_note(ImportedNote {
        id: Some(note_id),
        title: mapped.title,
        content: body,
        folder: Some(ROOT.to_owned()),
        tags: mapped.tags,
        properties: YamlMap::new(),
        created: Some(mapped.created),
        modified: Some(mapped.modified),
    });
    match created {
        Ok(()) => ctx.report_imported(),
        Err(error) => {
            tracing::warn!(scope = "import", "Google Keep note import failed");
            ctx.report_failed(label, &error.0);
        }
    }
}

/// A file beside a picked note, refused over the attachment size limit before it is read.
fn read_file(path: &Path) -> io::Result<Vec<u8>> {
    let limit = MAX_FILE_SIZE as u64;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| io::Error::new(io::ErrorKind::NotFound, NOT_FOUND))?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(too_large(limit));
    }
    Ok(bytes)
}

/// `JSON.parse` of an entry read as `toString('utf8')`; `None` where it throws. serde_json also
/// refuses nesting deeper than 128, which `JSON.parse` takes.
fn parse_json(bytes: &[u8]) -> Option<Value> {
    serde_json::from_str(&String::from_utf8_lossy(bytes)).ok()
}

/// `path.posix.basename`.
fn posix_basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_owned()
}
