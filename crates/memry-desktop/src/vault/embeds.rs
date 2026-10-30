//! Obsidian image embeds (`![[photo.png]]`) resolved to a file of the vault
//! (`vault/resolve-embed.ts`). Obsidian writes the target as a path from the vault root, from
//! the note's folder, or as a bare file name it looks up across the vault, so each form maps
//! back to a real file here.
//!
//! **Two output shapes.** Given the note's path, a target is a path relative to the note, which
//! the converter splices into the body and the write-back may later write to the file: it stays
//! valid in Obsidian and names no folder of this device. Without one (a read-only preview) it is
//! an absolute `memry-file://` URL. A target that names nothing resolves to nothing, and the
//! embed stays as written.
//!
//! Paths resolve lexically, as Node's `path.resolve` does, and a file is looked at through
//! symlinks, as `existsSync` and `statSync` do: a link inside the vault to a file outside it
//! resolves, and the `memry-file` handler decides whether to serve it.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use memry_core::api::note_files::NoteFiles;
use memry_core::domain::task_filter::locale_compare;
use memry_core::markdown::convert::EmbedResolver;
use memry_core::markdown::shared::empty_lines::extract_wiki_image_embed_refs;

use super::config::read_vault_config;
use super::file_types::FileType;
use super::layout::ATTACHMENTS_DIR;

/// `defaultNoteFolder` when the config names none.
const NOTES_FOLDER: &str = "notes";

/// `path.resolve(base, rel)` for a `rel` that is not absolute: `.` and `..` segments fold away
/// without looking at the disk, and `..` past the root stays at the root.
fn resolve(base: &Path, rel: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// `isInsideVault`: `path.relative(vault, abs)` is not empty, does not start with `..` (a
/// `..name` at the root included) and is not absolute.
fn is_inside(root: &Path, abs: &Path) -> bool {
    abs.strip_prefix(root).is_ok_and(|rel| {
        let rel = rel.to_string_lossy();
        !rel.is_empty() && !rel.starts_with("..")
    })
}

/// `path.basename`: the last segment, trailing separators dropped.
fn basename(path: &str) -> &str {
    let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    let trimmed = path.trim_end_matches(separators);
    trimmed.rsplit(separators).next().unwrap_or(trimmed)
}

/// `^[a-zA-Z][a-zA-Z\d+\-.]*:`: a URL, or a Windows drive, which is not ours to resolve.
fn has_scheme(target: &str) -> bool {
    let mut chars = target.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars
            .take_while(|c| *c != ':')
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        && target.contains(':')
}

/// `encodeAttachmentUrl`: a space or a parenthesis would end the markdown link.
fn encode(url: &str) -> String {
    url.replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
}

/// `toMemryFileUrl`.
fn memry_file_url(abs: &Path) -> String {
    let path = abs.to_string_lossy();
    if cfg!(windows) {
        format!("memry-file://local/{}", path.replace('\\', "/"))
    } else {
        format!(
            "memry-file://local/{}",
            path.strip_prefix('/').unwrap_or(&path)
        )
    }
}

/// `path.relative(from, to)` of two resolved paths, `/`-separated.
fn relative(from: &Path, to: &Path) -> String {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let ups = std::iter::repeat_n("..".to_owned(), from.len() - common);
    let downs = to[common..]
        .iter()
        .map(|part| part.as_os_str().to_string_lossy().into_owned());
    ups.chain(downs).collect::<Vec<_>>().join("/")
}

/// `embedTarget`: relative to the note when its path is known, the file's URL otherwise.
fn target(root: &Path, abs: &Path, note_path: Option<&str>) -> String {
    let Some(note_path) = note_path else {
        return encode(&memry_file_url(abs));
    };
    let note = resolve(root, note_path);
    let rel = relative(note.parent().unwrap_or(root), abs);
    if rel.is_empty() {
        return encode(&memry_file_url(abs));
    }
    encode(&rel)
}

/// `findOnDisk`: from the vault root, from the note's folder, from the notes folder, then from
/// the root attachments folder, which the index never holds.
fn on_disk(root: &Path, notes_folder: &str, target: &str, note_path: Option<&str>) -> Option<PathBuf> {
    let mut candidates = vec![resolve(root, target)];
    if let Some(note_path) = note_path {
        let dir = resolve(root, note_path);
        candidates.push(resolve(dir.parent().unwrap_or(root), target));
    }
    candidates.push(resolve(&resolve(root, notes_folder), target));
    candidates.push(resolve(&root.join(ATTACHMENTS_DIR), target));
    candidates
        .into_iter()
        .filter(|candidate| is_inside(root, candidate))
        .find(|candidate| std::fs::metadata(candidate).is_ok_and(|meta| meta.is_file()))
}

/// `lookupByFilenames`: the image of each lowercased file name, from the rows of every image in
/// the vault. Several folders can hold one name; the shortest path wins, as in Obsidian.
fn by_file_name(root: &Path, files: &NoteFiles, names: &BTreeSet<String>) -> BTreeMap<String, PathBuf> {
    let groups = match files.by_filename_lower(FileType::Image.as_str(), names) {
        Ok(groups) => groups,
        Err(error) => {
            tracing::warn!(scope = "vault_embeds", "the image lookup failed: {error}");
            return BTreeMap::new();
        }
    };
    groups
        .into_iter()
        .filter_map(|(name, mut paths)| {
            paths.sort_by(|a, b| match a.split('/').count().cmp(&b.split('/').count()) {
                Ordering::Equal => locale_compare(a, b),
                other => other,
            });
            let abs = resolve(root, paths.first()?);
            (is_inside(root, &abs) && abs.exists()).then_some((name, abs))
        })
        .collect()
}

/// `resolveVaultEmbeds` for the vault at `root`: the target each of `refs` resolves to, for the
/// note at `note_path`. A ref that names no file is left out. The files are looked for on disk
/// first; the ones not found there share one lookup of the image rows.
pub fn resolve_embeds(
    root: &Path,
    files: &NoteFiles,
    refs: &[String],
    note_path: Option<&str>,
) -> BTreeMap<String, String> {
    let configured = read_vault_config(root).default_note_folder;
    let notes_folder = if configured.is_empty() { NOTES_FOLDER } else { &configured };
    let mut resolved = BTreeMap::new();
    let mut pending = Vec::new();
    for reference in refs {
        if has_scheme(reference) || Path::new(reference).has_root() {
            continue;
        }
        match on_disk(root, notes_folder, reference, note_path) {
            Some(abs) => {
                resolved.insert(reference.clone(), target(root, &abs, note_path));
            }
            None => pending.push((reference, basename(reference).to_lowercase())),
        }
    }
    if pending.is_empty() {
        return resolved;
    }
    let names = pending.iter().map(|(_, name)| name.clone()).collect();
    let found = by_file_name(root, files, &names);
    for (reference, name) in pending {
        if let Some(abs) = found.get(&name) {
            resolved.insert(reference.clone(), target(root, abs, note_path));
        }
    }
    resolved
}

/// The embeds of one markdown text, resolved before the converter runs: the converter calls it
/// while the database's writer is held, where the image lookup cannot run. A target the text
/// does not hold resolves to nothing.
pub struct Resolved(BTreeMap<String, String>);

impl Resolved {
    /// The embeds of `markdown`, a body of the note at `note_path`. Nothing is read for a text
    /// with no image embed.
    pub fn of_markdown(root: &Path, files: &NoteFiles, markdown: &str, note_path: &str) -> Self {
        let refs = extract_wiki_image_embed_refs(markdown);
        if refs.is_empty() {
            return Self(BTreeMap::new());
        }
        Self(resolve_embeds(root, files, &refs, Some(note_path)))
    }
}

impl EmbedResolver for Resolved {
    fn resolve(&self, target: &str, _note_path: Option<&str>) -> Option<String> {
        self.0.get(target).cloned()
    }
}
