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
//! decodes to the file's. Four differences from Electron, each toward keeping the file. The
//! scan is complete only once the walk gave every file it found a row ([`RowOwner::walked`]):
//! before, a note on disk may have none and would go unread. A body that
//! cannot be read for any reason but its absence makes the scan incomplete (Electron skipped an
//! unreadable one as "no reference"). The comparison is of folded names ([`fold`]: one Unicode
//! form, lowercase) and also reads percent-escaped names, since macOS resolves `ABC123-Plan.PDF`,
//! or `café.pdf` in either Unicode form, to the same file; a volume that tells them apart keeps a
//! file that only looks named. And the bodies of the stored templates are read too: a note made
//! from one copies its refs.
//!
//! A file an exclude pattern hides is not read, as in Electron. It has no row, the app neither
//! reads nor writes it as a note, and walking what a pattern hides (often a large tree the user
//! keeps out of the app) is the cost the pattern exists to avoid. A file only such a note names
//! goes to the OS trash, from which the user can bring it back.

use std::cell::Cell;
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::ops::Range;
use std::path::Path;

use unicode_normalization::UnicodeNormalization;

use crate::session::OpenVault;
use crate::shell::local_scheme::find_heal_candidate;
use crate::uri::decode_uri_component;
use crate::vault::consumer::rows::RowOwner;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::layout::ATTACHMENTS_DIR;
use crate::vault::note_file::{NoteFileError, read_note_lossy};
use crate::vault::paths::is_js_space;

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
    each_name(note_id, markdown, &mut |at| {
        let raw = &markdown[at];
        // A stray `%` is not an escape: the literal name stays.
        out.insert(decode_uri_component(raw).unwrap_or_else(|| raw.to_owned()));
    });
    out
}

/// Hands `found` where each name of [`filenames`] sits in the body, in one pass.
fn each_name(note_id: &str, markdown: &str, found: &mut dyn FnMut(Range<usize>)) {
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
        found(name_at..name_at + len);
        from = name_at + len;
    }
}

/// A name as a volume that ignores case and Unicode form sees it, to compare two names: NFC, each
/// character lowercased on its own (`ς` as `σ`, which `str::to_lowercase` picks by context), NFC
/// again since a lowercase may decompose (`İ` is `i` and a combining dot). Linear in `s`.
fn fold(s: &str) -> String {
    s.nfc()
        .flat_map(char::to_lowercase)
        .map(|c| if c == 'ς' { 'σ' } else { c })
        .nfc()
        .collect()
}

/// Whether `body` names `attachments/<owner>/<file>`, all three [folded](fold): the run appears
/// in it (Electron's `body.includes`) with `/` or `\` for either separator and the file's name as
/// it is or percent-decoded, or a name [`filenames`] reads, as written or decoded, is the file's.
/// Each search is linear (`str::contains` is a two-way search), and the extractor is one pass.
pub fn names_file(owner: &str, file: &str, body: &str) -> bool {
    let (owner, file, body) = (fold(owner), fold(file), fold(body));
    // Folded before the decode and after it: `%41` is an `A`, `%CC%81` an accent.
    let decoded = |name: &str| decode_uri_component(name).map(|name| fold(&name));
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
    each_name(&owner, &body, &mut |at| {
        let raw = &body[at];
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
    /// The walk has not given every file it found a row yet (one waits for its retry, or an
    /// exclude pattern's restart walks again), or it hit its caps or an unreadable folder.
    NotWalked,
    /// The rows, the attachment's folder or the templates could not be listed.
    Unlisted,
    /// A body could not be read.
    Unreadable,
}

/// What a scan found, and whether it read every body. An incomplete scan means "unknown", which
/// never licenses a deletion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceScan {
    /// The ids of the notes, and of the templates, whose body names the file, the excluded note
    /// aside, in id order.
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

/// Whether `body` names a file of `attachments/<owner>/` that is not in the folder (`present`,
/// the names on disk as they are) and that self-heal (`shell::file_service::heal`) could serve from `file`: the
/// same stored prefix, or the same name past it (#4122). After a rename, a note that still names
/// the old name shows the renamed file this way. Each name as written and decoded. A name is
/// present only in its exact case, as on a volume that tells case apart (Linux): there a link
/// to `report.pdf` beside `Report.pdf` heals, and so does one in another Unicode form. The heal
/// itself is compared [folded](fold), and without self-heal's rule that the match be the folder's
/// only one: each difference counts more refs, which keeps the file.
fn heals_to(owner: &str, file: &str, present: &BTreeSet<String>, body: &str) -> bool {
    let (owner, file) = (owner.to_ascii_lowercase(), fold(file));
    // ASCII lowercase keeps every byte where it was, so a range of `lower` is one of `body`.
    let lower = body.to_ascii_lowercase();
    let mut heals = false;
    each_name(&owner, &lower, &mut |at| {
        let raw = &body[at];
        let decoded = decode_uri_component(raw);
        for name in [Some(raw), decoded.as_deref()].into_iter().flatten() {
            heals = heals
                || (!present.contains(name)
                    && find_heal_candidate([file.as_str()], &fold(name)) == Some(file.as_str()));
        }
    });
    heals
}

/// The names of `attachments/<owner>/` as they are; none when the folder is gone.
fn folder_names(vault: &Path, owner: &str) -> io::Result<BTreeSet<String>> {
    let entries = match fs::read_dir(vault.join(ATTACHMENTS_DIR).join(owner)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        other => other?,
    };
    let mut names = BTreeSet::new();
    for entry in entries {
        names.insert(entry?.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

/// `findNotesReferencingAttachment`: the notes of the open vault whose body names
/// `attachments/<owner>/<file>` ([`names_file`]), or a missing name of that folder self-heal
/// serves from it ([`heals_to`]; Electron did not count those), `exclude` aside, and the stored
/// templates whose body does (Electron read none). Every row is read but those of
/// a pdf, an image, an audio or a video file. A row whose file is gone holds no reference. The
/// scan is incomplete until the walk of the vault gave every file it found a row (`rows`), and when a body
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
            "reference scan before the vault's walk gave every file a row; the file counts as shared"
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
    let present = match folder_names(&open.path, owner) {
        Ok(present) => present,
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                "reference scan could not list the attachment's folder; the file counts as shared: {error}"
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
        if names_file(owner, file, &body) || heals_to(owner, file, &present, &body) {
            referenced_by.push(note_id);
        }
    }
    let templates = match open.vault.template_contents() {
        Ok(templates) => templates,
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                "reference scan could not read the templates; the file counts as shared: {error}"
            );
            return ReferenceScan::incomplete(referenced_by, Incomplete::Unlisted);
        }
    };
    for (template_id, body) in templates {
        if names_file(owner, file, &body) || heals_to(owner, file, &present, &body) {
            referenced_by.push(template_id);
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
