//! What a replay writes: every template file at its moved path with the template's note ids
//! replaced, the asset copies, and the notes to create in the core.
//!
//! The template is bundled, but Step 40 replays its own, so the folder is read as untrusted:
//! a link, a special file, a path that leaves the vault or reaches into `.memry/core`, more
//! than [`MAX_FILES`] files, a file over [`MAX_FILE_BYTES`] or folders more than [`MAX_DEPTH`]
//! deep refuse the template before anything is written. The walk keeps its own stack, so
//! depth never grows the thread's.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeZone};
use sha2::{Digest, Sha256};

use super::{SeedCounts, Template, io_error};
use crate::sandbox::manifest::check_relative_path;
use crate::sandbox::{Manifest, Rebase, Row, SandboxError};

/// Folders a template file may sit in, counted from the vault root.
pub const MAX_DEPTH: usize = 32;
/// Files a template vault may hold.
pub const MAX_FILES: usize = 20_000;
/// Bytes one template file or asset may hold.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Files whose dates and note ids move: the ones the generator wrote as text
/// (notes, canvases, `.memry/config.json`).
const TEXT_EXTENSIONS: &[&str] = &["md", "excalidraw", "json", "txt", "html"];
/// The core's databases, which a template never carries.
const CORE_DIR: &str = ".memry/core";
const ID_PREFIX: &str = "note_";
/// `note_` and a nanoid of 12, as the generator mints note ids.
const ID_LEN: usize = ID_PREFIX.len() + 12;

/// A markdown note to create in the core before its file is claimed.
#[derive(Debug, Clone)]
pub(super) struct NewNote {
    pub path: String,
    pub id: String,
    pub created_ms: i64,
    pub modified_ms: i64,
}

enum Content {
    Text(String),
    Bytes(Vec<u8>),
    Copy(PathBuf),
}

pub(super) struct Plan {
    files: BTreeMap<String, Content>,
    pub notes: Vec<NewNote>,
    pub counts: SeedCounts,
}

/// The plan for `manifest` (already rebased) over `template`'s files, with each kept markdown
/// note's id replaced by `mint`'s.
pub(super) fn plan<Tz: TimeZone>(
    template: &Template,
    manifest: &Manifest,
    rebase: Option<&Rebase<Tz>>,
    mut mint: impl FnMut(&str) -> String,
) -> Result<Plan, SandboxError> {
    let found = walk(&template.vault)?;
    let moved = |text: &str| -> String {
        rebase
            .map_or(Cow::Borrowed(text), |r| r.text(text))
            .into_owned()
    };
    // A file's text also moves a canvas's timestamps ([`Rebase::file`]).
    let moved_file = |path: &str, text: &str| -> String {
        rebase
            .map_or(Cow::Borrowed(text), |r| r.file(path, text))
            .into_owned()
    };
    let template_rows = notes_of(&template.manifest);
    let rows = notes_of(manifest);

    // Files no row names first, then the rows' files in creation order: a later row's file
    // wins a path two land on, as the generator's later write did.
    let mut sources: BTreeMap<String, &str> = BTreeMap::new();
    let mut kept: BTreeMap<String, usize> = BTreeMap::new();
    let row_paths: Vec<&str> = template_rows.iter().map(|row| text(row, "path")).collect();
    for rel in found
        .iter()
        .filter(|rel| !row_paths.contains(&rel.as_str()))
    {
        sources.insert(moved(rel), rel);
    }
    for (at, (template_path, row)) in row_paths.iter().zip(&rows).enumerate() {
        let path = text(row, "path").to_owned();
        // A file note's bytes may be an asset copy, written from the bundled asset below.
        match found.iter().find(|rel| rel == template_path) {
            Some(source) => {
                sources.insert(path.clone(), source);
            }
            None if template
                .manifest
                .assets
                .iter()
                .any(|copy| copy.path == *template_path) => {}
            None => return Err(SandboxError::MissingFile((*template_path).to_owned())),
        }
        kept.insert(path, at);
    }

    let mut ids = HashMap::new();
    let mut counts = SeedCounts::default();
    let mut pending = Vec::new();
    for (path, &at) in &kept {
        let row = rows[at];
        let journal = !row
            .get("journal_date")
            .is_none_or(serde_json::Value::is_null);
        match (text(row, "file_type") == "markdown", journal) {
            (true, true) => counts.journal_entries += 1,
            (true, false) => {
                let old = text(row, "id");
                ids.insert(old.to_owned(), mint(old));
                pending.push((path.as_str(), row));
            }
            (false, _) => counts.files += 1,
        }
    }
    let rewrite =
        |text: &str| -> String { rewrite_ids(text, |old| ids.get(old).cloned()).into_owned() };

    let mut files = BTreeMap::new();
    for (path, source) in &sources {
        let source_path = template.vault.join(source);
        let content = if is_text(path) {
            let bytes = fs::read(&source_path).map_err(|error| io_error(&source_path, &error))?;
            match String::from_utf8(bytes) {
                Ok(raw) => Content::Text(rewrite(&moved_file(path, &raw))),
                Err(raw) => Content::Bytes(raw.into_bytes()),
            }
        } else {
            Content::Copy(source_path)
        };
        counts.canvases += usize::from(path.ends_with(".excalidraw"));
        files.insert(rewrite(path), content);
    }
    for copy in &manifest.assets {
        files.insert(
            rewrite(&copy.path),
            Content::Bytes(asset(template, &copy.asset, &copy.sha256)?),
        );
    }

    let mut notes = Vec::with_capacity(pending.len());
    for (path, row) in pending {
        notes.push(NewNote {
            path: rewrite(path),
            id: ids[text(row, "id")].clone(),
            created_ms: instant_ms(row, "created_at")?,
            modified_ms: instant_ms(row, "modified_at")?,
        });
    }
    counts.notes = notes.len();
    Ok(Plan {
        files,
        notes,
        counts,
    })
}

impl Plan {
    /// Writes every file under `root`.
    pub fn write(&self, root: &Path) -> Result<(), SandboxError> {
        for (path, content) in &self.files {
            check_relative_path(path)?;
            if in_core(path) {
                return Err(SandboxError::UnsafePath(path.clone()));
            }
            let to = root.join(path);
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|error| io_error(parent, &error))?;
            }
            let written = match content {
                Content::Text(text) => fs::write(&to, text),
                Content::Bytes(bytes) => fs::write(&to, bytes),
                Content::Copy(from) => fs::copy(from, &to).map(drop),
            };
            written.map_err(|error| io_error(&to, &error))?;
        }
        Ok(())
    }
}

/// `path` is the core's folder or under it, in any case: APFS and NTFS ignore case.
fn in_core(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    path == CORE_DIR || path.starts_with(&format!("{CORE_DIR}/"))
}

fn notes_of(manifest: &Manifest) -> Vec<&Row> {
    manifest
        .data
        .get("note_metadata")
        .map_or_else(Vec::new, |rows| rows.iter().collect())
}

fn text<'a>(row: &'a Row, column: &str) -> &'a str {
    row.get(column)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

fn instant_ms(row: &Row, column: &str) -> Result<i64, SandboxError> {
    DateTime::parse_from_rfc3339(text(row, column))
        .map(|at| at.timestamp_millis())
        .map_err(|_| {
            SandboxError::BadRow(format!("note_metadata.{column} of {}", text(row, "path")))
        })
}

fn is_text(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| TEXT_EXTENSIONS.contains(&ext))
}

/// The bundled asset's bytes, checked against the template's sha256.
fn asset(template: &Template, name: &str, sha256: &str) -> Result<Vec<u8>, SandboxError> {
    let path = template.assets.join(name);
    let meta = fs::symlink_metadata(&path).map_err(|error| io_error(&path, &error))?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Err(SandboxError::BadAsset(name.to_owned()));
    }
    let bytes = fs::read(&path).map_err(|error| io_error(&path, &error))?;
    if hex::encode(Sha256::digest(&bytes)) != sha256 {
        return Err(SandboxError::BadAsset(name.to_owned()));
    }
    Ok(bytes)
}

/// The template vault's files, vault-relative and sorted.
fn walk(root: &Path) -> Result<Vec<String>, SandboxError> {
    let too_large = SandboxError::TooLarge;
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|error| io_error(&dir, &error))? {
            let entry = entry.map_err(|error| io_error(&dir, &error))?;
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| SandboxError::UnsafePath(name.to_string_lossy().into_owned()))?;
            let rel = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            check_relative_path(&rel)?;
            if in_core(&rel) {
                return Err(SandboxError::UnsafePath(rel));
            }
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|error| io_error(&path, &error))?;
            if meta.is_dir() {
                if depth >= MAX_DEPTH {
                    return Err(too_large(format!(
                        "{rel} is more than {MAX_DEPTH} folders deep"
                    )));
                }
                stack.push((path, rel, depth + 1));
            } else if meta.is_file() {
                if meta.len() > MAX_FILE_BYTES {
                    return Err(too_large(format!("{rel} is over {MAX_FILE_BYTES} bytes")));
                }
                found.push(rel);
                if found.len() > MAX_FILES {
                    return Err(too_large(format!("more than {MAX_FILES} files")));
                }
            } else {
                // A link or a special file: the template is copied, never followed.
                return Err(SandboxError::UnsafePath(rel));
            }
        }
    }
    found.sort();
    Ok(found)
}

/// `text` with each template note id `lookup` knows replaced. One pass, one lookup per
/// `note_` the text holds.
pub(super) fn rewrite_ids<'t>(
    text: &'t str,
    mut lookup: impl FnMut(&str) -> Option<String>,
) -> Cow<'t, str> {
    let id_char = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut copied = 0;
    let mut from = 0;
    while let Some(found) = text[from..].find(ID_PREFIX) {
        let start = from + found;
        let end = start + ID_LEN;
        let candidate = bytes.get(start + ID_PREFIX.len()..end);
        match candidate
            .filter(|tail| tail.iter().all(|&b| id_char(b)))
            .and_then(|_| lookup(&text[start..end]))
        {
            Some(new) => {
                out.push_str(&text[copied..start]);
                out.push_str(&new);
                copied = end;
                from = end;
            }
            None => from = start + ID_PREFIX.len(),
        }
    }
    if copied == 0 {
        return Cow::Borrowed(text);
    }
    out.push_str(&text[copied..]);
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect()
    }

    #[test]
    fn rewrite_replaces_only_known_ids() {
        let ids = map(&[("note_AyzpvW1VSKE1", "abc123")]);
        let text = "related: 'memry://note/note_AyzpvW1VSKE1'\nother: note_zzzzzzzzzzzz\n\
                    short: note_abc\nattachments/note_AyzpvW1VSKE1/a.png";
        let out = rewrite_ids(text, |old| ids.get(old).cloned());
        assert_eq!(
            out,
            "related: 'memry://note/abc123'\nother: note_zzzzzzzzzzzz\n\
             short: note_abc\nattachments/abc123/a.png"
        );
        assert!(matches!(
            rewrite_ids("no ids here", |_| None),
            Cow::Borrowed(_)
        ));
    }

    /// A hostile text of nothing but `note_` asks one lookup per occurrence, so the pass is
    /// linear in the text.
    #[test]
    fn rewrite_looks_up_each_prefix_once() {
        let text = "note_".repeat(200_000);
        let mut lookups = 0usize;
        let out = rewrite_ids(&text, |_| {
            lookups += 1;
            None
        });
        assert_eq!(out.len(), text.len());
        assert!(lookups <= 200_000, "{lookups} lookups");
    }

    /// A minted id lands in an `attachments/<id>/` path; one that leaves the folder is refused
    /// before anything is written.
    #[test]
    fn a_minted_id_that_leaves_the_vault_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        let id = "note_AAAAAAAAAAAA";
        fs::create_dir_all(vault.join("attachments").join(id)).unwrap();
        fs::write(vault.join("A.md"), "a\n").unwrap();
        fs::write(vault.join("attachments").join(id).join("a.txt"), "x").unwrap();
        let at = "2026-01-14T12:00:00.000Z";
        let seed = serde_json::json!({
            "version": 1, "generatedAt": at, "timezone": "UTC", "assets": [], "index": {},
            "data": { "note_metadata": [{
                "id": id, "path": "A.md", "file_type": "markdown", "journal_date": null,
                "created_at": at, "modified_at": at,
            }] },
        });
        let template = Template {
            manifest: Manifest::parse(seed.to_string().as_bytes()).unwrap(),
            vault,
            assets: dir.path().join("assets"),
        };
        let plan =
            plan::<chrono::Utc>(&template, &template.manifest, None, |_| "../x".into()).unwrap();
        let root = dir.path().join("out");
        let refused = plan.write(&root);
        assert!(
            matches!(&refused, Err(SandboxError::UnsafePath(path)) if path == "attachments/../x/a.txt"),
            "{:?}",
            refused.err()
        );
        assert!(!dir.path().join("x").exists() && !root.join("x").exists());
    }

    #[test]
    fn rewrite_keeps_multibyte_text_around_ids() {
        let ids = map(&[("note_vO9_ecATMB48", "N")]);
        let out = rewrite_ids("é note_vO9_ecATMB48 ü note_é", |old| {
            ids.get(old).cloned()
        });
        assert_eq!(out, "é N ü note_é");
    }
}
