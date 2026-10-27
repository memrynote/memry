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

/// `openVaultFile`: the file, or `None` when missing.
pub fn open_vault_file(vault: &Path, rel: &str) -> Result<Option<File>, OpenError> {
    file_open::open_under_root(vault, rel)
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
    let mut units = 0;
    let mut end = 0;
    for (index, c) in sanitized.char_indices() {
        units += c.len_utf16();
        if units > MAX_FILENAME_UTF16 {
            break;
        }
        end = index + c.len_utf8();
    }
    sanitized[..end].to_owned()
}

/// `generateNotePath`. The folder is joined as given (`..` collapses): the caller checks
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
    let filename = format!("{}.{extension}", sanitize_filename(title));
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

/// `generateUniquePath`: `base` when nothing is there, else the first of `<name> 1<ext>`,
/// `<name> 2<ext>`, and so on. A dangling link counts as taken, so a new file is never
/// created through it.
pub fn generate_unique_path(base: &Path) -> PathBuf {
    let taken = |p: &Path| p.symlink_metadata().is_ok();
    if !taken(base) {
        return base.to_path_buf();
    }
    let dir = base.parent().unwrap_or_else(|| Path::new(""));
    let file_name = base
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (name, ext) = js_ext_split(&file_name);
    (1u64..)
        .map(|counter| dir.join(format!("{name} {counter}{ext}")))
        .find(|candidate| !taken(candidate))
        .expect("a free name exists")
}
