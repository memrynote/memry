//! Reading a `[[wiki link]]` target: its note and heading halves, and the note
//! a note half names.
//!
//! Desktop's `packages/shared/src/wiki-target.ts` is the reference. Two rules
//! from it shape everything here:
//!
//!   * `Note#Heading` addresses a heading inside `Note`, but `#` is legal in a
//!     title (`Sprint #4`), so a caller resolves the split half first and falls
//!     back to the raw string ([`split`], [`resolve`]).
//!   * A title is a file's basename and never holds `/`, so a note half with a
//!     `/` is a path from the vault root (`Folder/Note`), matched
//!     case-insensitively against the note's vault-relative path with or
//!     without `.md`. A path that matches nothing falls back to the title.
//!
//! The core has no `path` column: a note sits at `folder_path` and its file is
//! named after its title, `Title.md` for markdown and `Title.<ext>` for an
//! attachment, whose title desktop takes from the filename without its
//! extension (`indexer.ts`). The extension itself is not projected, so a path
//! link to an attachment matches on any extension.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::api::errors::StorageError;

/// A target's note half, and its heading half when it carries a `#`.
///
/// `Note#H1#H2` names the last heading, like desktop's `splitWikiTarget`.
pub fn split(target: &str) -> (&str, Option<&str>) {
    let raw = target.trim();
    match raw.split_once('#') {
        None => (raw, None),
        Some((note, rest)) => (note.trim(), rest.rsplit('#').next().map(str::trim)),
    }
}

/// The vault-relative stem a path-form note half names, or `None` for a
/// title. One leading `/` is tolerated.
pub fn path_stem(note_half: &str) -> Option<&str> {
    let half = note_half.trim();
    half.contains('/')
        .then(|| half.strip_prefix('/').unwrap_or(half))
}

/// The note a target names and the heading to scroll to: the split note half
/// first, then the raw string, where any `#` belongs to the title and there is
/// no heading. A `#^block` reference opens the note with no heading. `None` is
/// a broken link, and also `[[#Heading]]`, which the caller that knows the
/// current note answers.
pub fn resolve(
    conn: &Connection,
    target: &str,
) -> Result<Option<(String, Option<String>)>, StorageError> {
    let raw = target.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let (note, heading) = split(raw);
    if let Some(heading) = heading {
        if note.is_empty() {
            return Ok(None);
        }
        if let Some(id) = resolve_note(conn, note)? {
            let anchor =
                (!heading.is_empty() && !heading.starts_with('^')).then(|| heading.to_owned());
            return Ok(Some((id, anchor)));
        }
    }
    Ok(resolve_note(conn, raw)?.map(|id| (id, None)))
}

/// The live note a note half names: [`by_path_or_title`], then by alias.
pub fn resolve_note(conn: &Connection, half: &str) -> Result<Option<String>, StorageError> {
    match by_path_or_title(conn, half)? {
        Some(id) => Ok(Some(id)),
        None if half.trim().is_empty() => Ok(None),
        None => by_alias(conn, half.trim()),
    }
}

/// The live note a note half names by vault path when it holds a `/`, then by
/// title case-insensitively. No aliases: this is what the link index resolves
/// with, as desktop's `resolveNotesByTitles` does. Ties go to the lowest id so
/// two runs answer the same note.
pub fn by_path_or_title(conn: &Connection, half: &str) -> Result<Option<String>, StorageError> {
    let wanted = half.trim();
    if wanted.is_empty() {
        return Ok(None);
    }
    if let Some(stem) = path_stem(wanted)
        && let Some(id) = by_path(conn, stem)?
    {
        return Ok(Some(id));
    }
    let by_title = conn
        .query_row(
            "SELECT id FROM notes WHERE deleted_at IS NULL \
             AND title = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
            [wanted],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(by_title)
}

/// The lowercased `note_links.target_title` forms a path-form link to a
/// markdown note can be stored under: `Folder/Note` and `Folder/Note.md`, each
/// with or without a leading `/`. Desktop's `pathLinkKeys`. A root note's
/// path form is `/Note`.
pub fn path_link_keys(folder_path: Option<&str>, title: &str) -> Vec<String> {
    let stem = match folder_path.filter(|folder| !folder.is_empty()) {
        Some(folder) => format!("{folder}/{title}"),
        None => title.to_owned(),
    }
    .to_lowercase();
    let mut keys = vec![format!("/{stem}"), format!("/{stem}.md")];
    if stem.contains('/') {
        keys.extend([stem.clone(), format!("{stem}.md")]);
    }
    keys
}

/// The note at a vault-relative path, `.md` optional for markdown.
fn by_path(conn: &Connection, stem: &str) -> Result<Option<String>, StorageError> {
    let (folder, name) = match stem.rsplit_once('/') {
        Some((folder, name)) => (folder, name),
        None => ("", stem),
    };
    if name.is_empty() {
        return Ok(None);
    }
    // `name` is `Title`, `Title.md`, or `Title.<ext>` for an attachment.
    let (bare, ext) = match name.rsplit_once('.') {
        Some((bare, ext)) if !bare.is_empty() => (bare, Some(ext)),
        _ => (name, None),
    };
    let markdown_ext = ext.is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
    conn.query_row(
        "SELECT id FROM notes WHERE deleted_at IS NULL \
         AND COALESCE(folder_path, '') = ?1 COLLATE NOCASE \
         AND ((file_type = 'markdown' AND (title = ?2 COLLATE NOCASE \
                 OR (?4 AND title = ?3 COLLATE NOCASE))) \
           OR (file_type <> 'markdown' AND ?5 AND title = ?3 COLLATE NOCASE)) \
         ORDER BY id LIMIT 1",
        rusqlite::params![
            folder,
            name,
            bare,
            markdown_ext,
            ext.is_some() && !markdown_ext
        ],
        |row| row.get(0),
    )
    .optional()
    .map_err(failed)
}

/// `aliases` is JSON text in the projection rather than its own table, so the
/// match is done in Rust against the parsed array: a `LIKE` over the raw JSON
/// would match a note whose alias merely contains the target.
fn by_alias(conn: &Connection, wanted: &str) -> Result<Option<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, aliases FROM notes \
             WHERE deleted_at IS NULL AND aliases IS NOT NULL ORDER BY id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?;
    for row in rows {
        let (id, raw) = row.map_err(failed)?;
        // A malformed `aliases` on some other note is not this link's problem.
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if items
            .iter()
            .filter_map(Value::as_str)
            .any(|alias| alias.trim().eq_ignore_ascii_case(wanted))
        {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
