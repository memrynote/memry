//! A note file's frontmatter block replaced without its body in memory: a large-file class
//! note's file owes its record's `aliases` (#5825), and the write-back writes that key alone. The
//! block is read from the file's head; the new file is the new block followed by the old file's
//! bytes from the old block's end, copied as they are, written aside and renamed over the file
//! once it is still the file read ([`replace_head_checked`]).

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::Duration;

use memry_core::markdown::frontmatter::split_frontmatter_block;

use super::fs_atomic::{
    self, carry_over_attributes, open_temp, remove_temp, replace_file, with_transient_retry,
};
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
        // A closing line cut at the cap could go on past it: it is not guessed at.
        if !block.ends_with('\n') && bytes.len() as u64 == HEAD_CAP {
            return Err(NoteFileError::Io(io::Error::other(
                "the frontmatter block does not end in the file's first MiB",
            )));
        }
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
/// answers the new file's hash and size. The rest of the file is copied from the file itself,
/// through the handle that reads `old` and hashes the file: one whose head or hash is not the
/// one read is not written ([`NoteFileError::ChangedUnderWrite`]).
/// Right before the rename the file is hashed again: one that changed, moved or went since that
/// read is not written over ([`NoteFileError::ChangedUnderWrite`]). Its folder is never created.
/// The check runs again before each attempt of a retried rename. `between` is given the new
/// file's hash after it is written aside and before each check.
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
    // One handle gives the head, the hash and the body: the bytes copied are the file read.
    let written = (|| -> io::Result<Option<(String, u64)>> {
        let mut file = open_temp(&temp)?;
        file.write_all(new.as_bytes())?;
        let mut held = vec![0; old.text.len()];
        match source.read_exact(&mut held) {
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            read => read?,
        }
        let copied = Copy {
            from: &mut source,
            to: &mut file,
        };
        let (source_hash, _) = hash_reader(held.as_slice().chain(copied))?;
        if held != old.text.as_bytes() || source_hash != read_hash {
            return Ok(None);
        }
        file.sync_all()?;
        drop(file);
        carry_over_attributes(&path, &temp);
        hash_reader(File::open(&temp)?).map(Some)
    })();
    let (hash, size) = match written {
        Ok(Some(written)) => written,
        Ok(None) => {
            remove_temp(&temp, false);
            return Err(NoteFileError::ChangedUnderWrite);
        }
        Err(error) => {
            remove_temp(&temp, false);
            return Err(error.into());
        }
    };
    let mut nothing = || {};
    let mut contained = still_contained(vault, rel, &path, aimed_at, &mut nothing);
    let mut refused = None;
    let delays = fs_atomic::RETRY_DELAYS_MS.map(Duration::from_millis);
    // Every attempt checks the file again, as `fs_atomic::write_once` does: a retry after a
    // transient failure must not rename over an edit made while it waited.
    let replaced = with_transient_retry(&delays, || {
        between(&hash);
        contained()?;
        let unchanged = match open_note_file(vault, rel) {
            Ok(Some(file)) => hash_reader(&file)?.0 == read_hash,
            Ok(None) => false,
            Err(error) => {
                refused = Some(error);
                return Err(io::Error::other("the file could not be read again"));
            }
        };
        if !unchanged {
            refused = Some(NoteFileError::ChangedUnderWrite);
            return Err(io::Error::other("the file changed under the write"));
        }
        replace_file(&temp, &path)
    });
    if let Err(error) = replaced {
        remove_temp(&temp, false);
        return Err(refused.unwrap_or_else(|| error.into()));
    }
    fs_atomic::sync_dir(dir);
    Ok((hash, size))
}

/// A reader that writes what it reads from `from` to `to`.
struct Copy<'a> {
    from: &'a mut File,
    to: &'a mut File,
}

impl Read for Copy<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.from.read(buf)?;
        self.to.write_all(&buf[..read])?;
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// REVIEW-5836: a block whose closing line ends exactly at [`HEAD_CAP`] could go on past it,
    /// so it is not read as the block.
    #[test]
    fn a_block_cut_at_the_cap_is_not_guessed_at() {
        let dir = tempfile::tempdir().unwrap();
        let open = "---\nnote: ";
        let close = "\n---";
        let fill = "x".repeat(HEAD_CAP as usize - open.len() - close.len());
        let text = format!("{open}{fill}{close}-not-a-close\n---\nBody\n");
        std::fs::write(dir.path().join("Dump.md"), text).unwrap();
        assert!(read_head(dir.path(), "Dump.md").is_err());
    }
    const STALE: &str = "---\naliases: [Old]\n---\nBody\n";
    const EDIT: &str = "---\naliases: [Mine]\n---\nUser edit\n";

    fn file_hash(path: &Path) -> String {
        hash_reader(File::open(path).unwrap()).unwrap().0
    }

    /// VERIFY-5836R2: the head read is not the file's head now, though the hash given is the
    /// file's. The one handle's head check refuses it.
    #[test]
    fn a_head_changed_since_it_was_read_is_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Plan.md");
        std::fs::write(&file, STALE).unwrap();
        let head = read_head(dir.path(), "Plan.md").unwrap().unwrap();
        std::fs::write(&file, EDIT).unwrap();
        let result = replace_head_checked(
            dir.path(),
            "Plan.md",
            (&head, "---\naliases: [New]\n---\n"),
            &file_hash(&file),
            &mut |_| {},
        );
        assert!(matches!(result, Err(NoteFileError::ChangedUnderWrite)));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), EDIT);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    /// VERIFY-5836R2: the first rename fails on a read-only folder, the user edits the file
    /// before the retry, and the retry refuses instead of renaming over the edit. Root writes to
    /// any folder, so the first rename cannot fail for it.
    #[cfg(unix)]
    #[test]
    fn a_retried_rename_never_writes_over_an_edit_made_while_it_waited() {
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("Sub");
        std::fs::create_dir(&sub).unwrap();
        let file = sub.join("Plan.md");
        std::fs::write(&file, STALE).unwrap();
        let head = read_head(dir.path(), "Sub/Plan.md").unwrap().unwrap();
        let mode = |mode| std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(mode));
        let mut attempt = 0;
        let mut between = |_: &str| {
            attempt += 1;
            if attempt == 1 {
                mode(0o555).unwrap();
            } else if attempt == 2 {
                std::fs::write(&file, EDIT).unwrap();
                mode(0o755).unwrap();
            }
        };
        let result = replace_head_checked(
            dir.path(),
            "Sub/Plan.md",
            (&head, "---\naliases: [New]\n---\n"),
            &file_hash(&file),
            &mut between,
        );
        mode(0o755).unwrap();
        assert!(matches!(result, Err(NoteFileError::ChangedUnderWrite)));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), EDIT);
        assert_eq!(std::fs::read_dir(&sub).unwrap().count(), 1);
    }
}
