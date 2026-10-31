//! The app's note reads (`getNoteById`, `getNoteByPath`, `noteExists`, `getFileById`,
//! `listNotes`). The record and its row come from one query; a note's text comes from its
//! file, opened under the vault and refusing links, its size classified before a byte is read
//! (`classifyMarkdownStat`), then by its blocks (`classifyMarkdownContent`).

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use memry_core::domain::inbox::queries::FiledVoice;
use memry_core::domain::note_list::{ListedNote, NoteListQuery};
use memry_core::domain::note_stats::word_count;
use memry_core::domain::tags::fold;
use memry_core::markdown::frontmatter::{gray_matter_data, split_frontmatter_block};
use memry_core::markdown::shared::markdown_class::{
    LargeFileReason, MarkdownClassThresholds, MarkdownClassification, classify_markdown_content,
    classify_markdown_stat,
};

use super::error::{NotesError, SCOPE};
use super::frontmatter::{FileFields, file_fields};
use super::view::{
    AttachedFileType, FileView, LargeFileInfo, LargeFileReasonView, NoteListFields,
    NoteListItemView, NoteListOptions, NoteListPageView, NoteView, SizeClass, SortOrder,
    TranscriptionStatus, dates,
};
use crate::session::OpenVault;
use crate::shell::file_open::Resolution;
use crate::telemetry::main_warning::Level;
use crate::telemetry::service::Service;
use crate::vault::file_types::FileType;
use crate::vault::paths::{open_vault_file, resolve_vault_file};

/// `NoteListSchema`'s `limit` bounds and default.
const MAX_LIMIT: u32 = 10_000;
const DEFAULT_LIMIT: u32 = 100;

/// The note, `None` when no live note has that id and a row, or its file is gone. A gone file
/// is counted on `telemetry`: the records and the disk disagree until the watcher catches up.
pub fn get(
    open: &OpenVault,
    note_id: &str,
    telemetry: Option<&Service>,
) -> Result<Option<NoteView>, NotesError> {
    match open.vault.note_files().listed_by_id(note_id)? {
        Some(listed) => note_of(&open.path, listed, telemetry),
        None => Ok(None),
    }
}

/// The note whose file is at the vault-relative `path`.
pub fn get_by_path(
    open: &OpenVault,
    path: &str,
    telemetry: Option<&Service>,
) -> Result<Option<NoteView>, NotesError> {
    match open.vault.note_files().listed_by_path(path)? {
        Some(listed) => note_of(&open.path, listed, telemetry),
        None => Ok(None),
    }
}

/// `noteExists`: a `.md` path names a live note's file, anything else is a link target
/// that resolves to a note (`resolveLinkTarget`).
pub fn exists(open: &OpenVault, title_or_path: &str) -> Result<bool, NotesError> {
    if title_or_path.ends_with(".md") {
        return Ok(open
            .vault
            .note_files()
            .listed_by_path(title_or_path)?
            .is_some());
    }
    let target = open
        .vault
        .notes()
        .resolve_wiki_target(title_or_path.to_owned())?;
    Ok(target.is_some())
}

/// A note whose file is not markdown; `None` for a markdown note, no note, or a file that is
/// gone (`getFileById`).
pub fn get_file(open: &OpenVault, note_id: &str) -> Result<Option<FileView>, NotesError> {
    let files = open.vault.note_files();
    let Some(listed) = files.listed_by_id(note_id)? else {
        return Ok(None);
    };
    let attached = FileType::of_stored(&listed.file_type).and_then(AttachedFileType::of);
    let Some(file_type) = attached else {
        return Ok(None);
    };
    match resolve_vault_file(&open.path, &listed.path)? {
        Resolution::Inside(_) => {}
        Resolution::Missing => return Ok(None),
        Resolution::Outside => return Err(NotesError::Outside),
    }
    let voice = match file_type {
        AttachedFileType::Audio => files.filed_voice(&listed.path)?.unwrap_or_default(),
        _ => FiledVoice::default(),
    };
    let (created, modified) = dates(&listed);
    // Joined a segment at a time, so the separators are the platform's (`path.join`).
    let absolute_path = listed
        .path
        .split('/')
        .fold(open.path.clone(), |path, segment| path.join(segment));
    Ok(Some(FileView {
        absolute_path: absolute_path.to_string_lossy().into_owned(),
        id: listed.id,
        path: listed.path,
        title: listed.title,
        file_type,
        mime_type: listed.mime_type,
        file_size: listed.file_size,
        created,
        modified,
        transcription: voice.transcription,
        transcription_status: voice.status.as_deref().and_then(TranscriptionStatus::parse),
    }))
}

pub fn list(open: &OpenVault, options: &NoteListOptions) -> Result<NoteListPageView, NotesError> {
    let query = NoteListQuery {
        folder: options.folder.clone().filter(|folder| !folder.is_empty()),
        tags: options.tags.clone().unwrap_or_default(),
        sort: options.sort(),
        ascending: options.sort_order == Some(SortOrder::Asc),
        limit: options.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
        offset: options.offset.unwrap_or(0),
    };
    let page = open.vault.note_files().list_notes(query)?;
    let tree = options.fields == Some(NoteListFields::Tree);
    Ok(NoteListPageView {
        notes: page
            .notes
            .into_iter()
            .map(|note| NoteListItemView::of(note, tree))
            .collect(),
        total: page.total,
        has_more: page.has_more,
    })
}

/// The note's file on disk, for the OS to open or show; refused when it resolves outside
/// the vault.
pub fn file_path(open: &OpenVault, note_id: &str) -> Result<PathBuf, NotesError> {
    let Some(row) = open.vault.note_files().by_id(note_id)? else {
        return Err(NotesError::NotFound(note_id.to_owned()));
    };
    match resolve_vault_file(&open.path, &row.path)? {
        Resolution::Inside(real) => Ok(real),
        Resolution::Missing => Err(NotesError::NotFound(note_id.to_owned())),
        Resolution::Outside => Err(NotesError::Outside),
    }
}

fn note_of(
    root: &Path,
    listed: ListedNote,
    telemetry: Option<&Service>,
) -> Result<Option<NoteView>, NotesError> {
    let thresholds = MarkdownClassThresholds::default();
    let file = match open_vault_file(root, &listed.path) {
        Ok(Some(file)) => file,
        Ok(None) => {
            tracing::warn!(
                scope = SCOPE,
                note_id = listed.id,
                "a note's file is missing; the watcher reconciles it"
            );
            // Index and file disagreeing ("my note is empty") is counted (`getNoteById`).
            if let Some(telemetry) = telemetry {
                telemetry.track_main_log(
                    Level::Warn,
                    "Notes",
                    "note_file_missing",
                    Some("NOTE_FILE_MISSING"),
                    None,
                    None,
                );
            }
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let size = usize::try_from(file.metadata()?.len()).unwrap_or(usize::MAX);
    if let Some(class) = classify_markdown_stat(size, thresholds) {
        return Ok(Some(large_note(listed, class, false)));
    }
    let mut bytes = Vec::with_capacity(size);
    // Bounded: a file that grew since its size was read is cut at the class ceiling, and one
    // past it is a large file.
    file.take(thresholds.max_file_bytes as u64 + 1)
        .read_to_end(&mut bytes)?;
    let raw = String::from_utf8_lossy(&bytes);
    let class = classify_markdown_content(&raw, thresholds);
    if class.large_file.is_some() {
        return Ok(Some(large_note(listed, class, true)));
    }
    // A block that does not parse costs the note no body: its fields read as none (`parseNote`).
    let split = split_frontmatter_block(&raw);
    let fields = match split.block.map(gray_matter_data).transpose() {
        Ok(Some(data)) => file_fields(&data),
        Ok(None) => FileFields::default(),
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                note_id = listed.id,
                "a note's frontmatter does not parse: {error}"
            );
            FileFields::default()
        }
    };
    let content = split.body.to_owned();
    let (created, modified) = dates(&listed);
    Ok(Some(NoteView {
        id: listed.id,
        path: listed.path,
        title: listed.title,
        word_count: word_count(&content),
        content,
        frontmatter: fields.frontmatter,
        created,
        modified,
        tags: with_header_tags(listed.tags, &fields.header_tags),
        header_tags: fields.header_tags,
        aliases: fields.aliases,
        properties: fields.properties,
        emoji: listed.emoji,
        size_class: SizeClass::Note,
        large_file: None,
        content_omitted: false,
    }))
}

/// `getNoteTags`: the record's and the body's tags, then the file's header tags they lack. A
/// file the identity adopted has its header tags only in the file until the note index (Step
/// 13e) records them.
fn with_header_tags(mut tags: Vec<String>, header: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = tags.iter().map(|tag| fold(tag)).collect();
    for tag in header {
        if seen.insert(fold(tag)) {
            tags.push(tag.clone());
        }
    }
    tags
}

/// `largeFileNote`: the note without its text, which the editor never mounts.
fn large_note(listed: ListedNote, class: MarkdownClassification, read: bool) -> NoteView {
    let (created, modified) = dates(&listed);
    let to_u32 = |bytes: usize| u32::try_from(bytes).unwrap_or(u32::MAX);
    let reason = match class.large_file {
        Some(LargeFileReason::BlockBytes) => LargeFileReasonView::BlockBytes,
        _ => LargeFileReasonView::FileBytes,
    };
    NoteView {
        id: listed.id,
        path: listed.path,
        title: listed.title,
        content: String::new(),
        frontmatter: serde_json::Map::new(),
        created,
        modified,
        tags: listed.tags,
        header_tags: Vec::new(),
        aliases: Vec::new(),
        word_count: 0,
        // The record's, as Electron reads the index's: the file is never parsed.
        properties: listed.properties,
        emoji: listed.emoji,
        size_class: SizeClass::LargeFile,
        large_file: Some(LargeFileInfo {
            reason,
            file_bytes: to_u32(class.file_bytes),
            largest_block_bytes: read.then(|| to_u32(class.largest_block_bytes)),
        }),
        content_omitted: true,
    }
}
