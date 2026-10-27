//! Reading and writing note files without changing a byte nobody edited.
//!
//! A read refuses a file that is not valid UTF-8, because turning bad bytes into U+FFFD and
//! writing the text back would destroy them. Callers that only need a hash (rename pairing)
//! use [`hash_file`], which decodes the way Electron did.
//!
//! A write goes through the Step 05 serializer, which re-emits an unchanged frontmatter
//! block verbatim (protocol 12.4), and writes nothing when the bytes are already on disk:
//! no mtime change, no watcher event, no sync item for a no-op save.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use memry_core::markdown::frontmatter::{
    FrontmatterSplit, ParsedMarkdownNote, YamlError, YamlMap, parse_markdown_note,
    serialize_parsed_markdown_note, split_frontmatter_block, write_markdown_note,
};

use super::fs_atomic::{self, WriteError};
use super::hash::{content_hash, hash_reader};
use super::paths::{open_vault_file, resolve_vault_file};
use crate::shell::file_open::{OpenError, Resolution};

/// Largest note file read into memory. Bigger files are handled by the large-file class and
/// stream; a read that has to hold one as a string refuses instead of exhausting memory.
pub const MAX_NOTE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum NoteFileError {
    #[error(transparent)]
    Open(#[from] OpenError),
    /// The file has a second hard link. A save replaces the file with a new one and so would
    /// cut the link, leaving the other name on the old text; the app refuses instead. The user
    /// can copy the note to a new file.
    #[error("this note is a hard link to another file, so it cannot be saved safely")]
    HardLinked,
    #[error("note file is not valid UTF-8")]
    NotUtf8,
    #[error("note file is larger than {MAX_NOTE_BYTES} bytes")]
    TooLarge,
    #[error("frontmatter could not be serialized: {0}")]
    Yaml(#[from] YamlError),
    #[error("a file already exists at that path")]
    AlreadyExists,
    #[error(transparent)]
    Write(#[from] WriteError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// A note file as it is on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteFile {
    pub raw: String,
    /// `generateContentHash(raw)`.
    pub hash: String,
}

impl NoteFile {
    /// Where the body starts; `block + body == raw`.
    pub fn split(&self) -> FrontmatterSplit<'_> {
        split_frontmatter_block(&self.raw)
    }

    pub fn parse(&self) -> Result<ParsedMarkdownNote, YamlError> {
        parse_markdown_note(&self.raw)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOutcome {
    Written,
    /// The bytes on disk already equal the output; nothing was touched.
    Unchanged,
}

fn open_note_file(vault: &Path, rel: &str) -> Result<Option<File>, NoteFileError> {
    open_vault_file(vault, rel).map_err(|error| match error {
        OpenError::HardLinked => NoteFileError::HardLinked,
        other => other.into(),
    })
}

fn read_bytes(vault: &Path, rel: &str) -> Result<Option<Vec<u8>>, NoteFileError> {
    let Some(file) = open_note_file(vault, rel)? else {
        return Ok(None);
    };
    // One byte past the cap tells a file that grew after the open from one at the cap.
    let mut bytes = Vec::new();
    file.take(MAX_NOTE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_NOTE_BYTES {
        return Err(NoteFileError::TooLarge);
    }
    Ok(Some(bytes))
}

/// The note at `rel`, or `None` when the file does not exist.
pub fn read_note(vault: &Path, rel: &str) -> Result<Option<NoteFile>, NoteFileError> {
    let Some(bytes) = read_bytes(vault, rel)? else {
        return Ok(None);
    };
    let raw = String::from_utf8(bytes).map_err(|_| NoteFileError::NotUtf8)?;
    let hash = content_hash(&raw);
    Ok(Some(NoteFile { raw, hash }))
}

/// The hash of the file at `rel` as Electron computes it, streamed; `None` when missing.
pub fn hash_file(vault: &Path, rel: &str) -> Result<Option<String>, NoteFileError> {
    let Some(file) = open_note_file(vault, rel)? else {
        return Ok(None);
    };
    Ok(Some(hash_reader(file)?.0))
}

pub(super) fn target(vault: &Path, rel: &str) -> Result<(PathBuf, Resolution), NoteFileError> {
    match resolve_vault_file(vault, rel)? {
        Resolution::Inside(path) => Ok((path.clone(), Resolution::Inside(path))),
        // A path linked outside the vault is never written over.
        Resolution::Outside => Err(OpenError::Outside.into()),
        Resolution::Missing => Ok((vault.join(rel), Resolution::Missing)),
    }
}

/// The check that runs once more right before the rename: the path must still resolve inside
/// the vault, and to the file the write was aimed at. A folder or file swapped for a link in
/// the meantime stops the write instead of landing outside.
pub(super) fn still_contained<'a>(
    vault: &'a Path,
    rel: &'a str,
    path: &'a Path,
    aimed_at: Resolution,
    between: &'a mut dyn FnMut(),
) -> impl FnMut() -> std::io::Result<()> + 'a {
    move || {
        between();
        let outside = || std::io::Error::other("the target resolves outside the vault");
        match (resolve_vault_file(vault, rel)?, &aimed_at) {
            (Resolution::Outside, _) => Err(outside()),
            (Resolution::Inside(now), Resolution::Inside(_)) if now != path => Err(outside()),
            _ => Ok(()),
        }
    }
}

fn write_if_changed(
    vault: &Path,
    rel: &str,
    output: String,
    between: &mut dyn FnMut(),
) -> Result<WriteOutcome, NoteFileError> {
    let (path, aimed_at) = target(vault, rel)?;
    if read_bytes(vault, rel)?.is_some_and(|existing| existing == output.as_bytes()) {
        return Ok(WriteOutcome::Unchanged);
    }
    let mut check = still_contained(vault, rel, &path, aimed_at, between);
    fs_atomic::atomic_write_checked(&path, output.as_bytes(), &default_delays(), &mut check)?;
    Ok(WriteOutcome::Written)
}

/// Writes an existing note back: `parsed` is what [`NoteFile::parse`] returned, `content`
/// the new body. The frontmatter block is kept byte for byte unless `frontmatter_edited`.
pub fn write_note(
    vault: &Path,
    rel: &str,
    parsed: &ParsedMarkdownNote,
    content: &str,
    frontmatter_edited: bool,
) -> Result<WriteOutcome, NoteFileError> {
    write_note_checked(vault, rel, parsed, content, frontmatter_edited, &mut || {})
}

/// [`write_note`] with a hook that runs after the temp file is written and before the
/// containment re-check, so a test can swap a folder for a link in that window.
#[doc(hidden)]
pub fn write_note_checked(
    vault: &Path,
    rel: &str,
    parsed: &ParsedMarkdownNote,
    content: &str,
    frontmatter_edited: bool,
    between: &mut dyn FnMut(),
) -> Result<WriteOutcome, NoteFileError> {
    let output = serialize_parsed_markdown_note(parsed, content, frontmatter_edited)?;
    write_if_changed(vault, rel, output, between)
}

/// Creates a new note file; a file at the path, even one that appears while this runs, is
/// never replaced.
pub fn write_new_note(
    vault: &Path,
    rel: &str,
    frontmatter: &YamlMap,
    content: &str,
) -> Result<(), NoteFileError> {
    write_new_note_checked(vault, rel, frontmatter, content, &mut || {})
}

/// [`write_new_note`] with a hook that runs after the temp file is written, so a test can
/// create the target in the window a check-then-write would lose.
#[doc(hidden)]
pub fn write_new_note_checked(
    vault: &Path,
    rel: &str,
    frontmatter: &YamlMap,
    content: &str,
    between: &mut dyn FnMut(),
) -> Result<(), NoteFileError> {
    let output = write_markdown_note(frontmatter, content)?;
    let (path, aimed_at) = target(vault, rel)?;
    let mut check = still_contained(vault, rel, &path, aimed_at, between);
    fs_atomic::atomic_create_checked(&path, output.as_bytes(), &default_delays(), &mut check)
        .map_err(|err| {
            if err.already_exists() {
                NoteFileError::AlreadyExists
            } else {
                err.into()
            }
        })
}

fn default_delays() -> [Duration; 3] {
    fs_atomic::RETRY_DELAYS_MS.map(Duration::from_millis)
}
