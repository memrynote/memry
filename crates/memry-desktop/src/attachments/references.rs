//! Who still names an attachment (#2077): port of `vault/attachment-reference-scan.ts`, and
//! `extractAttachmentFilenames` of `vault/attachment-rename-reconcile.ts`, which reads the names
//! out of a note body.
//!
//! A note names a stored file as `../attachments/<owner>/<file>` (note-relative),
//! `attachments/<owner>/<file>` (root-relative, mobile), the escaped JSON of a
//! `<!-- file:{"url":…} -->` marker, or a legacy `memry-file://local/…/attachments/<owner>/<file>`
//! URL. Each holds the `attachments/<owner>/<file>` run, so a scan of the bodies is a complete
//! answer, not a heuristic.
//!
//! The bodies are vault files any app or device may have written, so the scan is untrusted
//! input: one pass over the text that never goes back (a capture resumes the search after its
//! end, as `matchAll` does), no recursion, and names that are slices of the body.
//!
//! Two differences from Electron, both toward keeping the file. A body that cannot be read for
//! any reason but its absence makes the scan incomplete (Electron skipped an unreadable one as
//! "no reference"). And [`find_references`] compares in ASCII lowercase and also reads
//! percent-escaped names, since a volume that ignores case resolves `ABC123-Plan.PDF` to the
//! same file.

use std::cell::Cell;
use std::collections::BTreeSet;
use std::path::Path;

use memry_core::api::vault::Vault;

use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::layout::ATTACHMENTS_DIR;
use crate::vault::note_file::{NoteFileError, read_note_lossy};
use crate::vault::paths::is_js_space;
use crate::web::extract::utils::js::decode_uri_component;

const SCOPE: &str = "attachments";

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Bytes [`filenames`] looked at on this thread, for the complexity tests.
#[doc(hidden)]
pub fn scan_steps() -> usize {
    STEPS.with(Cell::get)
}

fn step(by: usize) {
    STEPS.with(|steps| steps.set(steps.get() + by));
}

/// `extractAttachmentFilenames`: every name `markdown` gives a file of `attachments/<note_id>/`,
/// percent-decoded where it decodes. The regex
/// `attachments[/\\]<id>[/\\]([^)\s"'<>\\]+)` with the `g` flag: a name runs to the first `)`,
/// white space, quote, angle bracket or backslash, so it may hold `/`; a caller that moves files
/// takes only plain names.
pub fn filenames(note_id: &str, markdown: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    if note_id.is_empty() {
        return out;
    }
    let mut from = 0;
    while let Some(at) = markdown[from..].find(ATTACHMENTS_DIR) {
        let start = from + at;
        step(at + ATTACHMENTS_DIR.len());
        // `attachments` has no proper prefix that is also a suffix, so no match starts inside
        // this one.
        from = start + ATTACHMENTS_DIR.len();
        let Some(name_at) = name_start(markdown, from, note_id) else {
            continue;
        };
        step(note_id.len() + 2);
        let len: usize = markdown[name_at..]
            .chars()
            .take_while(|c| !is_name_end(*c))
            .map(char::len_utf8)
            .sum();
        step(len);
        if len == 0 {
            continue;
        }
        let raw = &markdown[name_at..name_at + len];
        // A stray `%` is not an escape: the literal name stays.
        out.insert(decode_uri_component(raw).unwrap_or_else(|| raw.to_owned()));
        from = name_at + len;
    }
    out
}

/// Where the name starts when `<sep><note_id><sep>` follows `at`.
fn name_start(markdown: &str, at: usize, note_id: &str) -> Option<usize> {
    let rest = markdown[at..].strip_prefix(['/', '\\'])?;
    let rest = rest.strip_prefix(note_id)?.strip_prefix(['/', '\\'])?;
    Some(markdown.len() - rest.len())
}

fn is_name_end(c: char) -> bool {
    matches!(c, ')' | '"' | '\'' | '<' | '>' | '\\') || is_js_space(c)
}

/// What a scan found, and whether it read every body. `complete: false` means "unknown", which
/// never licenses a deletion.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReferenceScan {
    /// The ids of the notes whose body names the file, the excluded one aside, in id order.
    pub referenced_by: Vec<String>,
    pub complete: bool,
}

impl ReferenceScan {
    /// True when the scan read every body and none names the file.
    pub fn unreferenced(&self) -> bool {
        self.complete && self.referenced_by.is_empty()
    }
}

/// `findNotesReferencingAttachment`: the notes of the vault at `root` whose body names
/// `attachments/<owner>/<file>`, `exclude` aside. Every row is read but those of a pdf, an
/// image, an audio or a video file. A row whose file is gone holds no reference. Any other read
/// failure (a link out of the vault, a second hard link, a file over the size cap, a disk
/// error) and a failure to list the rows make the scan incomplete.
pub fn find_references(
    root: &Path,
    vault: &Vault,
    owner: &str,
    file: &str,
    exclude: Option<&str>,
) -> ReferenceScan {
    let rows = match vault.note_files().list_paths() {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                "reference scan could not list the notes; the file counts as shared: {error}"
            );
            return ReferenceScan::default();
        }
    };
    let (owner, file) = (owner.to_ascii_lowercase(), file.to_ascii_lowercase());
    let mut referenced_by = Vec::new();
    for (note_id, path) in rows {
        if Some(note_id.as_str()) == exclude || is_media(&path) {
            continue;
        }
        let body = match read_note_lossy(root, &path) {
            Ok(Some(body)) => body.raw,
            Ok(None) => continue,
            Err(error) => {
                log_unreadable(&note_id, &error);
                return ReferenceScan {
                    referenced_by,
                    complete: false,
                };
            }
        };
        // Lowercased before the decode and after it: `%41` is an `A`.
        let names = filenames(&owner, &body.to_ascii_lowercase());
        if names.iter().any(|name| name.to_ascii_lowercase() == file) {
            referenced_by.push(note_id);
        }
    }
    referenced_by.sort();
    ReferenceScan {
        referenced_by,
        complete: true,
    }
}

/// A row of a file type that holds no note body.
fn is_media(path: &str) -> bool {
    file_type_of_extension(&extension(path)).is_some_and(|kind| kind != FileType::Markdown)
}

fn log_unreadable(note_id: &str, error: &NoteFileError) {
    tracing::warn!(
        scope = SCOPE,
        note_id,
        "reference scan could not read a note; the file counts as shared: {error}"
    );
}
