//! Vault path rules: the lexical join, the file name sanitizer and the two path builders of
//! `vault/file-ops.ts`, and the vault-relative resolve and open that delegate to
//! [`crate::shell::file_open`] (the one owner of the open-under-root rule).

use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::shell::file_open::{self, OpenError, Resolution};

/// `path.join(...)` followed by `path.resolve` against a base, without touching the file
/// system. Returns `None` when the result is not `base` or inside it (`safeJoin`). `..` is
/// resolved lexically; a link inside the vault is the business of [`resolve_vault_file`].
pub fn safe_join(base: &Path, segments: &[&str]) -> Option<PathBuf> {
    let mut joined = base.to_path_buf();
    for segment in segments {
        joined.push(segment);
    }
    let resolved = normalize(&joined);
    let base = normalize(base);
    resolved.starts_with(&base).then_some(resolved)
}

/// Collapses `.` and `..` segments. A `..` at the root stays at the root, as in `path.resolve`.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(component);
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// `resolveVaultFile`.
pub fn resolve_vault_file(vault: &Path, rel: &str) -> io::Result<Resolution> {
    file_open::resolve_under_root(vault, rel)
}

/// Waits before each retry of a file that reads as hard-linked (about 150 ms in all).
const HARD_LINK_RETRY_MS: [u64; 4] = [10, 30, 50, 60];

/// `openVaultFile`: the file, or `None` when missing.
///
/// A create puts the new file in place with a hard link and then drops the temp name, so for a
/// moment a file this app is creating has two links. A reader that lands in that window would
/// take it for a hard-linked file, so it looks again a few times before it says so.
pub fn open_vault_file(vault: &Path, rel: &str) -> Result<Option<File>, OpenError> {
    let mut delays = HARD_LINK_RETRY_MS.into_iter();
    loop {
        match file_open::open_under_root(vault, rel) {
            Err(OpenError::HardLinked) => match delays.next() {
                Some(ms) => std::thread::sleep(std::time::Duration::from_millis(ms)),
                None => return Err(OpenError::HardLinked),
            },
            other => return other,
        }
    }
}

/// `\s` of a JavaScript regular expression and `String.prototype.trim`: the Unicode white
/// space set plus the byte order mark, and not U+0085, which Rust counts as white space.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

const MAX_FILENAME_UTF16: usize = 200;

/// `sanitizeFilename`: removes the characters Windows and Obsidian forbid, collapses white
/// space, strips leading dots, falls back to `untitled`, and keeps at most 200 UTF-16 units.
///
/// One difference from JavaScript: `slice(0, 200)` can leave half of a surrogate pair at the
/// end, which no file name can hold, so the half is dropped here.
pub fn sanitize_filename(filename: &str) -> String {
    let forbidden = |c: char| {
        matches!(
            c,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '[' | ']' | '#' | '^'
        )
    };
    let mut collapsed = String::with_capacity(filename.len());
    let mut in_space = false;
    for c in filename.chars().filter(|c| !forbidden(*c)) {
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let mut sanitized = collapsed.trim_matches(is_js_space);
    while let Some(rest) = sanitized.strip_prefix('.') {
        sanitized = rest.trim_matches(is_js_space);
    }
    if sanitized.is_empty() {
        return "untitled".to_owned();
    }
    truncate_utf16(sanitized, MAX_FILENAME_UTF16).to_owned()
}

/// The longest prefix of `text` of at most `max` UTF-16 units, cut between characters.
fn truncate_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    let mut end = 0;
    for (index, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        end = index + c.len_utf8();
    }
    &text[..end]
}

/// Bytes a new name may take before its ` N` counter and extension: APFS and ext4 hold at most
/// 255 UTF-8 bytes in one name, and 200 UTF-16 units of CJK text are 600.
const MAX_NEW_NAME_BYTES: usize = 240;

/// The name of a **new** file for `title`: [`sanitize_filename`] (Electron's rule, pinned by
/// vectors) plus what Windows needs of a name that did not exist before:
/// - control characters are dropped (the rule already turns white space into spaces);
/// - dots and spaces at the end go, because Windows strips them and two names become one;
/// - a reserved device name (`CON`, `NUL`, `COM1` ... with or without an extension) gets a
///   `_` after its base, because `nul.md` opens the device on Windows;
/// - at most [`MAX_NEW_NAME_BYTES`], cut between characters, so `<name> 9999.md` fits the
///   255-byte names of APFS, ext4, btrfs and XFS and the 255 UTF-16 units of NTFS, and a cut
///   that leaves a dot or a space at the end drops it. Not every volume: HFS+ counts UTF-16
///   units after decomposing (a `ΐ` of 2 bytes is 3), and eCryptfs holds 143 bytes.
///   Electron does not cut: a name of 241 to 252 bytes is kept there and cut here.
///
/// A file that already exists keeps its name: nothing renames existing files through this.
pub fn sanitize_new_filename(title: &str) -> String {
    let without_controls: String = title
        .chars()
        .filter(|c| !c.is_control() || is_js_space(*c))
        .collect();
    let name = sanitize_filename(&without_controls);
    let name = name.trim_end_matches(['.', ' ']);
    if name.is_empty() {
        return "untitled".to_owned();
    }
    let base_end = name.find('.').unwrap_or(name.len());
    let (base, rest) = name.split_at(base_end);
    let hardened = if is_reserved_windows_name(base.trim_end_matches(' ')) {
        format!("{base}_{rest}")
    } else {
        name.to_owned()
    };
    let cut = truncate_utf16(&hardened, MAX_FILENAME_UTF16);
    let cut = &cut[..cut.floor_char_boundary(MAX_NEW_NAME_BYTES)];
    // Never empty: the name starts with neither (`sanitize_filename` strips both there).
    cut.trim_end_matches(['.', ' ']).to_owned()
}

fn is_reserved_windows_name(base: &str) -> bool {
    let upper = base.to_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|device| {
            upper.strip_prefix(device).is_some_and(|digit| {
                matches!(
                    digit,
                    "1" | "2"
                        | "3"
                        | "4"
                        | "5"
                        | "6"
                        | "7"
                        | "8"
                        | "9"
                        | "\u{b9}"
                        | "\u{b2}"
                        | "\u{b3}"
                )
            })
        })
}

/// `generateNotePath`, for a new note (see [`sanitize_new_filename`]). The folder is joined as given (`..` collapses): the caller checks
/// that the result stays inside the vault.
pub fn generate_note_path(notes_dir: &Path, title: &str, folder: Option<&str>) -> PathBuf {
    generate_file_path(notes_dir, title, "md", folder)
}

/// `generateFilePath`.
pub fn generate_file_path(
    notes_dir: &Path,
    title: &str,
    extension: &str,
    folder: Option<&str>,
) -> PathBuf {
    let filename = format!("{}.{extension}", sanitize_new_filename(title));
    let mut path = notes_dir.to_path_buf();
    if let Some(folder) = folder.filter(|f| !f.is_empty()) {
        path.push(folder);
    }
    normalize(&path.join(filename))
}

/// `path.extname`: from the last dot of the base name, unless that dot starts the name.
fn js_ext_split(file_name: &str) -> (&str, &str) {
    match file_name.rfind('.') {
        Some(dot) if dot > 0 => file_name.split_at(dot),
        _ => (file_name, ""),
    }
}

/// `base`, then `<name> 1<ext>`, `<name> 2<ext>`, ... without looking at the file system.
pub fn unique_candidates(base: &Path) -> impl Iterator<Item = PathBuf> {
    let dir = base.parent().unwrap_or_else(|| Path::new("")).to_path_buf();
    let file_name = base
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (name, ext) = {
        let (name, ext) = js_ext_split(&file_name);
        (name.to_owned(), ext.to_owned())
    };
    std::iter::once(base.to_path_buf())
        .chain((1u64..).map(move |counter| dir.join(format!("{name} {counter}{ext}"))))
}

/// `generateUniquePath`: `base` when nothing is there, else the first of `<name> 1<ext>`,
/// `<name> 2<ext>`, and so on. A dangling link counts as taken.
///
/// This is a suggestion, not a reservation: another process can create the file before the
/// caller does. A caller that writes the file uses [`super::fs_atomic::create_unique`], which
/// claims the name in the same step.
pub fn generate_unique_path(base: &Path) -> PathBuf {
    unique_candidates(base)
        .find(|candidate| candidate.symlink_metadata().is_err())
        .expect("a free name exists")
}
