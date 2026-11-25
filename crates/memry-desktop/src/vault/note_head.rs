//! A note file's frontmatter block replaced without its body in memory: a large-file class
//! note's file owes its record's `aliases` (#5825), and the write-back writes that key alone. The
//! block is read from the file's head; the new file is the new block followed by the old file's
//! bytes from the old block's end, copied as they are, written aside and renamed over the file
//! once it is still the file read ([`replace_head_checked`]).

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use memry_core::markdown::frontmatter::split_frontmatter_block;

use super::fs_atomic::{self, carry_over_attributes, open_temp, remove_temp, replace_file};
use super::hash::hash_reader;
use super::note_file::{NoteFileError, open_note_file, still_contained, target};

const BOM: char = '\u{feff}';

/// The most of a file's head read to find its frontmatter block's end. A block that does not end
/// in it is not rewritten.
const HEAD_CAP: u64 = 1024 * 1024;

/// A note file's head: its frontmatter block, byte order mark included, or the byte order mark
/// alone of a file with no block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub text: String,
    /// Whether `text` is a frontmatter block.
    pub block: bool,
}

/// The head of the note file at `rel`; `None` when the file is not there. An error when the
/// file starts a block that does not end in its first [`HEAD_CAP`] bytes, or whose head is not
/// UTF-8: either could be a block, and it is not guessed at.
pub fn read_head(vault: &Path, rel: &str) -> Result<Option<Head>, NoteFileError> {
    let Some(file) = open_note_file(vault, rel)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take(HEAD_CAP).read_to_end(&mut bytes)?;
    // A character cut at the cap ends the text before it.
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).unwrap_or_default()
        }
        Err(_) => return Err(NoteFileError::NotUtf8),
    };
    if let Some(block) = split_frontmatter_block(text).block {
        return Ok(Some(Head {
            text: block.to_owned(),
            block: true,
        }));
    }
    let bare = text.strip_prefix(BOM).unwrap_or(text);
    if bare.starts_with("---") {
        return Err(NoteFileError::Io(io::Error::other(
            "the frontmatter block does not end in the file's first MiB",
        )));
    }
    Ok(Some(Head {
        text: text[..text.len() - bare.len()].to_owned(),
        block: false,
    }))
}

/// Replaces the head `old` of the note file at `rel`, read with hash `read_hash`, with `new`, and
/// answers the new file's hash and size. The rest of the file is copied from the file itself.
/// Right before the rename the file is hashed again: one that changed, moved or went since that
/// read is not written over ([`NoteFileError::ChangedUnderWrite`]). Its folder is never created.
/// `between` is given the new file's hash after it is written aside and before those checks.
pub fn replace_head_checked(
    vault: &Path,
    rel: &str,
    (old, new): (&Head, &str),
    read_hash: &str,
    between: &mut dyn FnMut(&str),
) -> Result<(String, u64), NoteFileError> {
    let (path, aimed_at) = target(vault, rel)?;
    let Some(mut source) = open_note_file(vault, rel)? else {
        return Err(NoteFileError::ChangedUnderWrite);
    };
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temp = dir.join(fs_atomic::temp_name());
    let written = (|| -> io::Result<(String, u64)> {
        let mut file = open_temp(&temp)?;
        file.write_all(new.as_bytes())?;
        source.seek(SeekFrom::Start(old.text.len() as u64))?;
        io::copy(&mut source, &mut file)?;
        file.sync_all()?;
        drop(file);
        carry_over_attributes(&path, &temp);
        hash_reader(File::open(&temp)?)
    })();
    let (hash, size) = match written {
        Ok(written) => written,
        Err(error) => {
            remove_temp(&temp, false);
            return Err(error.into());
        }
    };
    between(&hash);
    let mut nothing = || {};
    let mut contained = still_contained(vault, rel, &path, aimed_at, &mut nothing);
    let unchanged = match contained() {
        Ok(()) => match open_note_file(vault, rel)? {
            Some(file) => hash_reader(&file)?.0 == read_hash,
            None => false,
        },
        Err(error) => {
            remove_temp(&temp, false);
            return Err(error.into());
        }
    };
    if !unchanged {
        remove_temp(&temp, false);
        return Err(NoteFileError::ChangedUnderWrite);
    }
    if let Err(error) = replace_file(&temp, &path) {
        remove_temp(&temp, false);
        return Err(error.into());
    }
    fs_atomic::sync_dir(dir);
    Ok((hash, size))
}
