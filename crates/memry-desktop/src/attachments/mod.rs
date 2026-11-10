//! A note's attachments (Step 14f, #3531): port of `apps/desktop/src/main/vault/attachments.ts`.
//!
//! The bytes of a file attached to a note live at `attachments/<noteId>/<prefix>-<name>.<ext>`
//! of the vault root, where the prefix is 6 random characters of `0-9a-z` and the name is the
//! original one sanitized ([`stored_name`]). Every device and the Electron app read this layout,
//! so it is a vault format. The note references the file relative to its own folder
//! (`../attachments/<noteId>/<file>` for `notes/Plan.md`), the only form that resolves on another
//! device; a note without a known path gets the absolute `memry-file:` URL, as Electron does.
//!
//! The note id and the file name come from the renderer and are untrusted. The id is a folder
//! name, so it must be one that every platform creates as written ([`is_note_id`]): a
//! hand-written frontmatter id with a space is fine, a separator, a control character, a
//! character Windows refuses or a device name is not. The stored name is always `<prefix>-...`, so it is never a
//! device name, and it keeps only an allowed extension. The attachments folder and the note's
//! folder must resolve inside the vault, so a link or a junction to elsewhere is refused before
//! anything is created through it, and again right before the file takes its name.
//!
//! Three differences from Electron: the stored name keeps at most [`MAX_STORED_NAME_BYTES`]
//! bytes (a long CJK name failed the write there) and no control, bidi or zero-width character,
//! the note id is checked, and the errors are the localized ones of
//! `errors:attachment.*`. A locked note refuses every write through [`writable_note`]; the sync
//! of the new file is Step 18's.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use memry_core::api::errors::StorageError;
use serde::Serialize;

use crate::session::OpenVault;
use crate::shell::file_open::{Resolution, is_reserved_device_name, resolve_under_root};
use crate::shell::local_scheme::{STORED_PREFIX_LEN, has_stored_prefix};
use crate::vault::embeds::memry_file_url;
use crate::vault::fs_atomic::{BeforeCommit, RETRY_DELAYS_MS, WriteError, atomic_create_checked};
use crate::vault::layout::ATTACHMENTS_DIR;
use crate::vault::paths::{is_js_space, sanitize_filename};

mod delete;
mod references;
mod remote;
mod rename;
mod resolve;
mod shared;
mod upload;

#[cfg(feature = "test-hooks")]
pub use delete::delete_checked;
pub use delete::{DeletedAttachment, delete};
pub use references::{
    Incomplete, ReferenceScan, filenames, find_references, names_file, scan_steps,
};
pub use remote::{
    FetchedImage, MAX_REMOTE_BYTES, RemoteFailure, RemoteImages, image_file_name, save_fetched,
};
#[cfg(feature = "test-hooks")]
pub use rename::rename_checked;
pub use rename::{RenamedAttachment, rename};
pub use resolve::{ResolvedAttachment, resolve};
pub use shared::{InsertedAttachment, VaultAttachmentEntry, insert_existing, list_vault};
pub use upload::{CHUNK_BYTES, Ended, MAX_UPLOADS, Uploads};

const SCOPE: &str = "attachments";

/// `MAX_FILE_SIZE`: 100 MiB, above every sync plan's file limit on purpose, so a large PDF can
/// stay on this device as a local-only attachment.
pub const MAX_FILE_SIZE: usize = 100 * 1024 * 1024;

pub const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const FILE_EXTENSIONS: [&str; 7] = ["pdf", "doc", "docx", "xls", "xlsx", "txt", "md"];
/// The containers the webview plays without a transcode (#2190).
const VIDEO_EXTENSIONS: [&str; 3] = ["mp4", "webm", "mov"];
/// Shown only through the sandboxed `memry-html` scheme (#1872).
const HTML_EXTENSIONS: [&str; 2] = ["html", "htm"];

/// The longest stored name, in bytes; every common file system takes 255.
pub const MAX_STORED_NAME_BYTES: usize = 200;

/// The largest file one raw request body carries. A larger file, up to [`MAX_FILE_SIZE`], comes
/// in [`CHUNK_BYTES`] parts through [`Uploads`].
pub const MAX_UPLOAD_BODY: usize = 16 * 1024 * 1024;

/// Attempts at a free name before the write gives up; one random prefix in 36^6 collides.
const NAME_ATTEMPTS: usize = 5;

#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
    /// The note id is not of the minted shape, or names a device on Windows.
    #[error("invalid note id for an attachment")]
    InvalidNote,
    #[error("attachment type .{0} is not allowed")]
    UnsupportedType(String),
    #[error("attachment of {size} bytes is over the {limit} byte limit")]
    TooLarge { size: usize, limit: usize },
    /// The attachments folder or the note's folder resolves outside the vault, or is a file.
    #[error("the attachments folder is a link out of the vault or not a folder")]
    NotAFolder,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Write(#[from] WriteError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    /// No chunked upload of that id: never begun, finished, cancelled, or its page or vault went.
    #[error("no such upload")]
    UploadGone,
    /// A chunk that does not continue the upload, runs past its size or is over [`CHUNK_BYTES`].
    #[error("the chunk does not continue the upload")]
    BadChunk,
    #[error("too many uploads at once")]
    TooManyUploads,
    /// The note is locked, by its own lock or a locked folder above its file. Electron's
    /// `VAULT_LOCKED_NOTE_MESSAGE`.
    #[error("The owner made this note read-only.")]
    Locked,
    /// The note's file is excluded (`ExcludedPaths`), which Electron's index does not hold.
    #[error("This note is in an excluded folder.")]
    Excluded,
    /// The vault has no row for the note the action names.
    #[error("Note not found: {0}")]
    NoteNotFound(String),
    /// An `http:`, `data:` or absolute path: not a file of the vault.
    #[error("Attachment url is not a vault-relative path")]
    NotVaultRelative,
    /// The url climbs out of the vault, or resolves out of it through a link.
    #[error("Attachment path is outside the vault")]
    OutsideVault,
    #[error("Attachment file not found on disk")]
    FileNotFound,
    /// Only a file of the note's own `attachments/<noteId>/` folder is renamed.
    #[error("Attachment is not stored in this note\u{2019}s attachments folder")]
    NotOwned,
    /// A rename to an empty name, or to one over [`rename::MAX_NAME_CHARS`].
    #[error("New attachment name is empty or too long")]
    BadName,
    #[error("Could not find a free attachment filename")]
    NoFreeName,
    /// An owner id or a stored name that is not one plain name.
    #[error("Invalid attachment reference")]
    BadReference,
}

/// `image` or `file`; a video stays `file`, which older clients read as a file block (#2190).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    Image,
    File,
}

/// A saved attachment: `AttachmentResult` of `@memry/rpc/notes` without its envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAttachment {
    /// The ref the note carries: note-relative, or a `memry-file:` URL.
    pub path: String,
    /// The name the file was uploaded under.
    pub name: String,
    pub size: usize,
    pub mime_type: &'static str,
    #[serde(rename = "type")]
    pub kind: AttachmentKind,
    /// Where the bytes are on this device, for the sync upload (Step 18); not sent.
    #[serde(skip)]
    pub disk_path: PathBuf,
}

/// `path.extname` without the dot: the text after the last `.` of the last segment, unless that
/// `.` starts the name (`.png` has none) or the name is `..`.
pub fn extension(file_name: &str) -> &str {
    let base = base_name(file_name);
    match base.rfind('.') {
        Some(dot) if dot > 0 && base != ".." => &base[dot + 1..],
        _ => "",
    }
}

/// The longest note id taken as a folder name, in bytes; every common file system takes 255.
pub const MAX_NOTE_ID_BYTES: usize = 200;

/// Whether `note_id` names one folder that every platform creates as written. Minted ids (a
/// nanoid, 12 of `0-9a-z`, `j<YYYY-MM-DD>`) always do; a frontmatter id a person wrote may hold
/// spaces or any letter. Refused: empty or over [`MAX_NOTE_ID_BYTES`], a control character, a
/// separator, a character Windows refuses (`<>:"|?*`), a trailing `.` or space (Windows drops
/// them, and they make `.` and `..`), and a device name.
pub fn is_note_id(note_id: &str) -> bool {
    !note_id.is_empty()
        && note_id.len() <= MAX_NOTE_ID_BYTES
        && !note_id
            .chars()
            .any(|c| c.is_control() || "/\\<>:\"|?*".contains(c))
        && !note_id.ends_with(['.', ' '])
        && !is_reserved_device_name(note_id)
}

/// `isPlainSegment`: one name, not `.` or `..`, and no trailing dot or space, which Windows
/// drops.
pub(crate) fn is_plain_segment(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\'])
        && !matches!(name, "." | "..")
        && !name.ends_with(['.', ' '])
}

/// `displayNameForStoredFilename`: the stored name without its `<6>-` prefix.
pub fn display_name_for_stored(filename: &str) -> &str {
    if has_stored_prefix(filename) {
        &filename[STORED_PREFIX_LEN..]
    } else {
        filename
    }
}

/// Characters that reorder or hide text where a name is shown (`evil\u{202E}fdp.png` shows as
/// `evilgnp.pdf`): the bidi marks, embeddings, overrides and isolates, and the zero-width ones.
fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
    )
}

/// The refusal of an upload whose declared or received size is over [`MAX_UPLOAD_BODY`], before
/// its body is read. The renderer sends an empty body for a file it declares over the limit.
pub fn check_upload_size(declared: usize, received: usize) -> Result<(), AttachmentError> {
    let size = declared.max(received);
    if size > MAX_UPLOAD_BODY {
        return Err(AttachmentError::TooLarge {
            size,
            limit: MAX_UPLOAD_BODY,
        });
    }
    Ok(())
}

/// The last segment of `file_name`, split at either separator.
fn base_name(file_name: &str) -> &str {
    file_name.rsplit(['/', '\\']).next().unwrap_or(file_name)
}

pub fn is_allowed_extension(ext: &str) -> bool {
    let ext = ext.to_ascii_lowercase();
    [
        &IMAGE_EXTENSIONS[..],
        &FILE_EXTENSIONS[..],
        &VIDEO_EXTENSIONS[..],
        &HTML_EXTENSIONS[..],
    ]
    .iter()
    .any(|set| set.contains(&ext.as_str()))
}

pub fn kind_of(file_name: &str) -> AttachmentKind {
    if IMAGE_EXTENSIONS.contains(&extension(file_name).to_ascii_lowercase().as_str()) {
        AttachmentKind::Image
    } else {
        AttachmentKind::File
    }
}

/// `getMimeType`.
pub fn mime_type(file_name: &str) -> &'static str {
    match extension(file_name).to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

/// `formatFileSize`.
pub fn format_size(bytes: usize) -> String {
    const KB: f64 = 1024.0;
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let bytes = bytes as f64;
    if bytes < KB * KB {
        format!("{:.1} KB", bytes / KB)
    } else {
        format!("{:.1} MB", bytes / (KB * KB))
    }
}

/// Six characters of `0-9a-z`, the `customAlphabet` prefix of Electron.
fn random_prefix() -> String {
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    uuid::Uuid::new_v4().as_bytes()[..6]
        .iter()
        .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
        .collect()
}

/// `generateUniqueFilename` with a given prefix: `<prefix>-<name><.ext>`, the name
/// [`stored_stem`]'s. The extension keeps its case.
pub fn stored_name(prefix: &str, file_name: &str) -> String {
    let base = base_name(file_name);
    let ext = extension(base);
    let stem = &base[..base.len() - ext.len() - usize::from(!ext.is_empty())];
    fit_name(&format!("{prefix}-"), stem, ext)
}

/// `<lead><stem><.ext>` with the stem [`stored_stem`]'s, cut at a character boundary so the
/// whole stays within [`MAX_STORED_NAME_BYTES`].
fn fit_name(lead: &str, stem: &str, ext: &str) -> String {
    let name = stored_stem(stem);
    let dot_ext = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let budget = MAX_STORED_NAME_BYTES.saturating_sub(lead.len() + dot_ext.len());
    let mut end = name.len().min(budget);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    format!("{lead}{}{dot_ext}", &name[..end])
}

/// The middle of a stored name: `sanitizeFilename`'s, with white space, parentheses and braces
/// turned into `-` (they end a markdown link or a file block marker), bidi and zero-width
/// characters, control characters too (Windows refuses them, and NUL ends a path everywhere;
/// Electron kept them and failed the write), runs of `-` collapsed, one `-` trimmed from each
/// end, `file` when nothing is left.
fn stored_stem(stem: &str) -> String {
    let mut dashed = String::new();
    for c in sanitize_filename(stem).chars() {
        let c = if is_js_space(c) || c.is_control() || is_invisible_format(c) || "(){}".contains(c)
        {
            '-'
        } else {
            c
        };
        if !(c == '-' && dashed.ends_with('-')) {
            dashed.push(c);
        }
    }
    let trimmed = dashed.strip_prefix('-').unwrap_or(&dashed);
    let name = trimmed.strip_suffix('-').unwrap_or(trimmed);
    if name.is_empty() { "file" } else { name }.to_owned()
}

/// `path.posix.relative(dirname(note_path), target)`: how a note at `note_path` names `target`,
/// both relative to the vault root with `/` separators.
pub fn relative_ref(note_path: &str, target: &str) -> String {
    let mut from: Vec<&str> = note_path.split('/').filter(|s| !s.is_empty()).collect();
    from.pop();
    let to: Vec<&str> = target.split('/').filter(|s| !s.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/")
}

/// `Ok` when `rel` resolves to a folder inside the vault.
fn inside_vault(vault: &Path, rel: &str) -> Result<(), AttachmentError> {
    match resolve_under_root(vault, rel)? {
        Resolution::Inside(path) if fs::metadata(&path)?.is_dir() => Ok(()),
        _ => Err(AttachmentError::NotAFolder),
    }
}

fn create_dir(dir: &Path) -> io::Result<()> {
    match fs::create_dir(dir) {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => Err(error),
        _ => Ok(()),
    }
}

/// `saveAttachment`: writes `bytes` as a new file of the note's attachments folder and returns
/// the ref for a note at `note_path`. Nothing is written for a refused id, type or size.
pub fn save(
    vault: &Path,
    note_id: &str,
    note_path: Option<&str>,
    file_name: &str,
    bytes: &[u8],
) -> Result<SavedAttachment, AttachmentError> {
    save_with(vault, note_id, note_path, file_name, bytes, &mut |_| {})
}

/// Test hook: [`save`] with `before_recheck` run with the target right before the last check of
/// the note's folder, the one in the same step as the file taking its name, so a test can swap a
/// link in there or put a file at the target.
#[cfg(feature = "test-hooks")]
#[doc(hidden)]
pub fn save_checked(
    vault: &Path,
    note_id: &str,
    note_path: Option<&str>,
    file_name: &str,
    bytes: &[u8],
    before_recheck: &mut dyn FnMut(&Path),
) -> Result<SavedAttachment, AttachmentError> {
    save_with(vault, note_id, note_path, file_name, bytes, before_recheck)
}

fn save_with(
    vault: &Path,
    note_id: &str,
    note_path: Option<&str>,
    file_name: &str,
    bytes: &[u8],
    before_recheck: &mut dyn FnMut(&Path),
) -> Result<SavedAttachment, AttachmentError> {
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    let mut write = |target: &Path, recheck: BeforeCommit<'_>| {
        atomic_create_checked(target, bytes, &delays, recheck)
    };
    store(
        vault,
        note_id,
        note_path,
        file_name,
        bytes.len(),
        before_recheck,
        &mut write,
    )
}

/// The refusals of a note id, a type or a size, before anything is written.
fn check(note_id: &str, file_name: &str, size: usize) -> Result<(), AttachmentError> {
    if !is_note_id(note_id) {
        return Err(AttachmentError::InvalidNote);
    }
    let ext = extension(file_name);
    if !is_allowed_extension(ext) {
        return Err(AttachmentError::UnsupportedType(ext.to_ascii_lowercase()));
    }
    if size > MAX_FILE_SIZE {
        return Err(AttachmentError::TooLarge {
            size,
            limit: MAX_FILE_SIZE,
        });
    }
    Ok(())
}

/// Places a file of `size` bytes in the note's attachments folder under a fresh stored name:
/// `place` creates it at the target it is given, never replacing a file, and calls the recheck
/// right before the file takes its name. The bytes come from memory ([`save`]) or from a
/// finished chunked upload ([`Uploads`]).
fn store(
    vault: &Path,
    note_id: &str,
    note_path: Option<&str>,
    file_name: &str,
    size: usize,
    before_recheck: &mut dyn FnMut(&Path),
    place: &mut dyn FnMut(&Path, BeforeCommit<'_>) -> Result<(), WriteError>,
) -> Result<SavedAttachment, AttachmentError> {
    check(note_id, file_name, size)?;
    // One level at a time, each checked before the next is made through it.
    create_dir(&vault.join(ATTACHMENTS_DIR))?;
    inside_vault(vault, ATTACHMENTS_DIR)?;
    let folder_rel = format!("{ATTACHMENTS_DIR}/{note_id}");
    let folder = vault.join(ATTACHMENTS_DIR).join(note_id);
    create_dir(&folder)?;
    inside_vault(vault, &folder_rel)?;
    let mut attempt = 0;
    let stored = loop {
        let stored = stored_name(&random_prefix(), file_name);
        let target = folder.join(&stored);
        let mut recheck = || {
            before_recheck(&target);
            inside_vault(vault, &folder_rel).map_err(|error| match error {
                AttachmentError::Io(error) => error,
                other => io::Error::other(other.to_string()),
            })
        };
        match place(&target, &mut recheck) {
            Ok(()) => break stored,
            Err(error) if error.already_exists() && attempt + 1 < NAME_ATTEMPTS => attempt += 1,
            Err(error) => return Err(error.into()),
        }
    };
    let disk_path = folder.join(&stored);
    let target = format!("{folder_rel}/{stored}");
    let path = match note_path {
        Some(note_path) => relative_ref(note_path, &target),
        None => {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "attachment written with an absolute URL: note path unknown"
            );
            memry_file_url(&disk_path, cfg!(windows))
        }
    };
    Ok(SavedAttachment {
        path,
        name: file_name.to_owned(),
        size,
        mime_type: mime_type(file_name),
        kind: kind_of(file_name),
        disk_path,
    })
}

/// The note's path in the open vault once a lock and an exclude pattern are ruled out: Electron's
/// `isNoteLocked(noteId, notePath)` at the top of `saveAttachment` (`attachments.ts:427`), and
/// `assertNoteWritable` in `deleteAttachment` and `renameAttachment`. `attachments/<noteId>/`
/// sits outside the note's folder, so a folder lock reaches it only through the note's path.
/// `None` when the vault has no row for the note. Every write to a note's attachments asks here
/// first.
pub fn writable_note(open: &OpenVault, note_id: &str) -> Result<Option<String>, AttachmentError> {
    let path = open.vault.note_files().by_id(note_id)?.map(|row| row.path);
    if open
        .vault
        .locks()
        .is_note_locked(note_id, path.as_deref())?
    {
        return Err(AttachmentError::Locked);
    }
    if path
        .as_deref()
        .is_some_and(|path| open.vault.excluded().covers(path))
    {
        return Err(AttachmentError::Excluded);
    }
    Ok(path)
}

/// `notes:upload-attachment`: [`save`] for a note of the open vault, referenced from its file.
/// A note the vault has no row for gets the absolute URL, as in Electron.
pub fn upload(
    open: &OpenVault,
    note_id: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<SavedAttachment, AttachmentError> {
    let note_path = writable_note(open, note_id)?;
    save(&open.path, note_id, note_path.as_deref(), file_name, bytes)
}
