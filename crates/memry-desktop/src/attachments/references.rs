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
//! [`names_file`] answers as Electron's `body.includes("attachments/<owner>/<file>")` does, so a
//! wiki embed (`![[…]]`), a frontmatter value, a query or fragment after the name, or a name
//! with an apostrophe or a space keeps the file, and also when a name the extractor reads
//! decodes to the file's. Three differences from Electron, each toward keeping the file. The
//! scan is complete only once the open walk gave every file of the vault a row
//! ([`RowOwner::walked`]): before, a note on disk may have none and would go unread. A body that
//! cannot be read for any reason but its absence makes the scan incomplete (Electron skipped an
//! unreadable one as "no reference"). And the comparison is in ASCII lowercase and also reads
//! percent-escaped names, since a volume that ignores case resolves `ABC123-Plan.PDF` to the
//! same file.

use std::cell::Cell;
use std::collections::BTreeSet;

use crate::session::OpenVault;
use crate::vault::consumer::rows::RowOwner;
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
    each_name(note_id, markdown, &mut |raw| {
        // A stray `%` is not an escape: the literal name stays.
        out.insert(decode_uri_component(raw).unwrap_or_else(|| raw.to_owned()));
    });
    out
}

/// Hands `found` each name of [`filenames`] as the body spells it, in one pass.
fn each_name(note_id: &str, markdown: &str, found: &mut dyn FnMut(&str)) {
    if note_id.is_empty() {
        return;
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
        found(&markdown[name_at..name_at + len]);
        from = name_at + len;
    }
}

/// Whether `body` names `attachments/<owner>/<file>`, in ASCII lowercase: the run appears in it
/// (Electron's `body.includes`) with `/` or `\` for either separator and the file's name as it is
/// or percent-decoded, or a name [`filenames`] reads, as written or decoded, is the file's. Each
/// search is linear (`str::contains` is a two-way search), and the extractor is one pass.
pub fn names_file(owner: &str, file: &str, body: &str) -> bool {
    let (owner, file) = (owner.to_ascii_lowercase(), file.to_ascii_lowercase());
    let body = body.to_ascii_lowercase();
    // Lowercased before the decode and after it: `%41` is an `A`.
    let decoded = |name: &str| decode_uri_component(name).map(|name| name.to_ascii_lowercase());
    let file_decoded = decoded(&file);
    for name in [Some(file.as_str()), file_decoded.as_deref()]
        .into_iter()
        .flatten()
    {
        for (a, b) in [('/', '/'), ('/', '\\'), ('\\', '/'), ('\\', '\\')] {
            if body.contains(&format!("{ATTACHMENTS_DIR}{a}{owner}{b}{name}")) {
                return true;
            }
        }
    }
    let mut named = false;
    each_name(&owner, &body, &mut |raw| {
        named = named || raw == file || decoded(raw).is_some_and(|name| name == file);
    });
    named
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

/// Why a scan could not tell that no note names the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Incomplete {
    /// The open walk has not given every file of the vault a row yet, or it hit its caps.
    NotWalked,
    /// The rows could not be listed.
    Unlisted,
    /// A body could not be read.
    Unreadable,
}

/// What a scan found, and whether it read every body. An incomplete scan means "unknown", which
/// never licenses a deletion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceScan {
    /// The ids of the notes whose body names the file, the excluded one aside, in id order.
    pub referenced_by: Vec<String>,
    pub incomplete: Option<Incomplete>,
}

impl ReferenceScan {
    /// True when the scan read every body and none names the file.
    pub fn unreferenced(&self) -> bool {
        self.incomplete.is_none() && self.referenced_by.is_empty()
    }

    fn incomplete(referenced_by: Vec<String>, why: Incomplete) -> Self {
        Self {
            referenced_by,
            incomplete: Some(why),
        }
    }
}

/// `findNotesReferencingAttachment`: the notes of the open vault whose body names
/// `attachments/<owner>/<file>` ([`names_file`]), `exclude` aside. Every row is read but those of
/// a pdf, an image, an audio or a video file. A row whose file is gone holds no reference. The
/// scan is incomplete until the open walk of the vault ended complete (`rows`), and when a body
/// cannot be read for any other reason (a link out of the vault, a second hard link, a file over
/// the size cap, a disk error) or the rows cannot be listed.
pub fn find_references(
    open: &OpenVault,
    rows: &RowOwner,
    owner: &str,
    file: &str,
    exclude: Option<&str>,
) -> ReferenceScan {
    if !rows.walked(&open.vault) {
        tracing::info!(
            scope = SCOPE,
            "reference scan before the vault's open walk ended complete; the file counts as shared"
        );
        return ReferenceScan::incomplete(Vec::new(), Incomplete::NotWalked);
    }
    let rows = match open.vault.note_files().list_paths() {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                "reference scan could not list the notes; the file counts as shared: {error}"
            );
            return ReferenceScan::incomplete(Vec::new(), Incomplete::Unlisted);
        }
    };
    let mut referenced_by = Vec::new();
    for (note_id, path) in rows {
        if Some(note_id.as_str()) == exclude || is_media(&path) {
            continue;
        }
        let body = match read_note_lossy(&open.path, &path) {
            Ok(Some(body)) => body.raw,
            Ok(None) => continue,
            Err(error) => {
                log_unreadable(&note_id, &error);
                return ReferenceScan::incomplete(referenced_by, Incomplete::Unreadable);
            }
        };
        if names_file(owner, file, &body) {
            referenced_by.push(note_id);
        }
    }
    referenced_by.sort();
    ReferenceScan {
        referenced_by,
        incomplete: None,
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
