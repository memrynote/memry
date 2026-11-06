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
//! `errors:attachment.*`. Lock refusals are Step 14e-3's, the sync of the new file Step 18's.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use memry_core::api::errors::StorageError;
use serde::Serialize;

use crate::session::OpenVault;
use crate::shell::file_open::{Resolution, is_reserved_device_name, resolve_under_root};
use crate::vault::embeds::memry_file_url;
use crate::vault::fs_atomic::{RETRY_DELAYS_MS, WriteError, atomic_create_checked};
use crate::vault::layout::ATTACHMENTS_DIR;
use crate::vault::paths::{is_js_space, sanitize_filename};

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

/// The largest file one raw request body carries. Larger files wait for the chunked upload of
/// 14f-2 (#3531), which sends 8 MiB parts; until then they are refused with this limit.
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
}

/// `image` or `file`; a video stays `file`, which older clients read as a file block (#2190).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

/// `generateUniqueFilename` with a given prefix: `<prefix>-<name><.ext>`. The name is
/// `sanitizeFilename`'s, with white space, parentheses and braces turned into `-` (they end a
/// markdown link or a file block marker), bidi and zero-width characters, control characters too (Windows refuses them, and NUL
/// ends a path everywhere; Electron kept them and failed the write), runs of `-` collapsed, one `-` trimmed from each end,
/// `file` when nothing is left. The extension keeps its case. The name is cut at a character
/// boundary so the whole stays within [`MAX_STORED_NAME_BYTES`].
pub fn stored_name(prefix: &str, file_name: &str) -> String {
    let base = base_name(file_name);
    let ext = extension(base);
    let stem = &base[..base.len() - ext.len() - usize::from(!ext.is_empty())];
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
    let mut name = trimmed.strip_suffix('-').unwrap_or(trimmed);
    if name.is_empty() {
        name = "file";
    }
    let dot_ext = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let budget = MAX_STORED_NAME_BYTES.saturating_sub(prefix.len() + 1 + dot_ext.len());
    let mut end = name.len().min(budget);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    format!("{prefix}-{}{dot_ext}", &name[..end])
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
    save_with(vault, note_id, note_path, file_name, bytes, &mut || {})
}

/// Test hook: [`save`] with `before_recheck` run right before the last check of the note's
/// folder, the one in the same step as the file taking its name, so a test can swap a link in
/// there.
#[cfg(feature = "test-hooks")]
#[doc(hidden)]
pub fn save_checked(
    vault: &Path,
    note_id: &str,
    note_path: Option<&str>,
    file_name: &str,
    bytes: &[u8],
    before_recheck: &mut dyn FnMut(),
) -> Result<SavedAttachment, AttachmentError> {
    save_with(vault, note_id, note_path, file_name, bytes, before_recheck)
}

fn save_with(
    vault: &Path,
    note_id: &str,
    note_path: Option<&str>,
    file_name: &str,
    bytes: &[u8],
    before_recheck: &mut dyn FnMut(),
) -> Result<SavedAttachment, AttachmentError> {
    if !is_note_id(note_id) {
        return Err(AttachmentError::InvalidNote);
    }
    let ext = extension(file_name);
    if !is_allowed_extension(ext) {
        return Err(AttachmentError::UnsupportedType(ext.to_ascii_lowercase()));
    }
    if bytes.len() > MAX_FILE_SIZE {
        return Err(AttachmentError::TooLarge {
            size: bytes.len(),
            limit: MAX_FILE_SIZE,
        });
    }
    // One level at a time, each checked before the next is made through it.
    create_dir(&vault.join(ATTACHMENTS_DIR))?;
    inside_vault(vault, ATTACHMENTS_DIR)?;
    let folder_rel = format!("{ATTACHMENTS_DIR}/{note_id}");
    let folder = vault.join(ATTACHMENTS_DIR).join(note_id);
    create_dir(&folder)?;
    inside_vault(vault, &folder_rel)?;
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    let mut attempt = 0;
    let stored = loop {
        let stored = stored_name(&random_prefix(), file_name);
        let mut recheck = || {
            before_recheck();
            inside_vault(vault, &folder_rel).map_err(|error| match error {
                AttachmentError::Io(error) => error,
                other => io::Error::other(other.to_string()),
            })
        };
        match atomic_create_checked(&folder.join(&stored), bytes, &delays, &mut recheck) {
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
        size: bytes.len(),
        mime_type: mime_type(file_name),
        kind: kind_of(file_name),
        disk_path,
    })
}

/// `notes:upload-attachment`: [`save`] for a note of the open vault, referenced from its file.
/// A note the vault has no row for gets the absolute URL, as in Electron.
pub fn upload(
    open: &OpenVault,
    note_id: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<SavedAttachment, AttachmentError> {
    let row = open.vault.note_files().by_id(note_id)?;
    save(
        &open.path,
        note_id,
        row.as_ref().map(|row| row.path.as_str()),
        file_name,
        bytes,
    )
}
