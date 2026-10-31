//! Obsidian image embeds (`![[photo.png]]`) resolved to a file of the vault
//! (`vault/resolve-embed.ts`). Obsidian writes the target as a path from the vault root, from
//! the note's folder, or as a bare file name it looks up across the vault, so each form maps
//! back to a real file here.
//!
//! **Two output shapes.** Given the note's path, a target is a path relative to the note. The
//! converter splices it into the body, and the write-back may later write it to the file: it
//! stays valid in Obsidian and names no folder of this device. Without one (a read-only
//! preview) it is an absolute `memry-file://` URL. A target that names nothing resolves to
//! nothing, and the embed stays as written. Unlike Electron, a target with a note path is
//! never a URL: where `path.relative` would give nothing to write, it resolves to nothing.
//!
//! Paths resolve lexically, as Node's `path.resolve` does, and compare without case on
//! Windows, as Node's win32 `path` does. Only an image target resolves, and an empty note path
//! is no note path, as in Electron. A hit is a file whose real location is in the vault
//! ([`UnderRoot`]): a link or a junction that leads out of it resolves to nothing, so an
//! embed never tells what is on disk outside the vault. Electron's `existsSync` follows it.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use memry_core::api::note_files::NoteFiles;
use memry_core::domain::task_filter::locale_compare;
use memry_core::markdown::convert::EmbedResolver;
use memry_core::markdown::shared::empty_lines::{
    extract_wiki_image_embed_refs, is_wiki_image_embed_target,
};

use super::config::read_vault_config;
use super::file_types::FileType;
use super::layout::ATTACHMENTS_DIR;
use crate::shell::file_open::{Resolution, UnderRoot};

/// `defaultNoteFolder` when the config names none.
const NOTES_FOLDER: &str = "notes";

/// Whether Node's `path` is `path.win32` here. The helpers that branch on it take it as an
/// argument, so both branches are tested on every platform.
const WINDOWS: bool = cfg!(windows);

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

/// One segment of two paths is the same: byte for byte, or without case on Windows.
fn same(a: &Component<'_>, b: &Component<'_>, windows: bool) -> bool {
    if windows {
        a.as_os_str().to_string_lossy().to_lowercase()
            == b.as_os_str().to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// The segments `to` has past the ones it shares with `from`, and how many of `from` it does not.
fn split_common<'a>(from: &Path, to: &'a Path) -> (usize, Vec<Component<'a>>) {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(a, b)| same(a, b, WINDOWS))
        .count();
    (from.len() - common, to[common..].to_vec())
}

/// `isInsideVault`: `path.relative(vault, abs)` is not empty, does not start with `..` (a
/// `..name` at the root included) and is not absolute.
fn is_inside(root: &Path, abs: &Path) -> bool {
    let (ups, downs) = split_common(root, abs);
    ups == 0
        && downs
            .first()
            .is_some_and(|first| !first.as_os_str().to_string_lossy().starts_with(".."))
}

/// `path.relative(from, to)` of two resolved paths, `/`-separated.
fn relative(from: &Path, to: &Path) -> String {
    let (ups, downs) = split_common(from, to);
    std::iter::repeat_n("..".to_owned(), ups)
        .chain(
            downs
                .iter()
                .map(|part| part.as_os_str().to_string_lossy().into_owned()),
        )
        .collect::<Vec<_>>()
        .join("/")
}

/// `path.basename`: the last segment, trailing separators dropped.
fn basename(path: &str, windows: bool) -> &str {
    let separators: &[char] = if windows { &['/', '\\'] } else { &['/'] };
    let trimmed = path.trim_end_matches(separators);
    trimmed.rsplit(separators).next().unwrap_or(trimmed)
}

/// `^[a-zA-Z][a-zA-Z\d+\-.]*:`: a URL, or a Windows drive, which is not ours to resolve.
fn has_scheme(target: &str) -> bool {
    let Some((scheme, _)) = target.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// `encodeAttachmentUrl`: a space or a parenthesis would end the markdown link.
fn encode(url: &str) -> String {
    url.replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
}

/// `toMemryFileUrl`.
fn memry_file_url(abs: &Path, windows: bool) -> String {
    let path = abs.to_string_lossy();
    if windows {
        format!("memry-file://local/{}", path.replace('\\', "/"))
    } else {
        format!(
            "memry-file://local/{}",
            path.strip_prefix('/').unwrap_or(&path)
        )
    }
}

/// `embedTarget`: relative to the note when its path is known, the file's URL otherwise.
fn target(root: &Path, abs: &Path, note_path: Option<&str>) -> Option<String> {
    let Some(note_path) = note_path else {
        return Some(encode(&memry_file_url(abs, WINDOWS)));
    };
    let note = resolve(root, note_path);
    let rel = relative(note.parent().unwrap_or(root), abs);
    (!rel.is_empty()).then(|| encode(&rel))
}

/// A file at `abs`, a path in the vault, whose real location is in the vault too. Most
/// candidates are misses, so a plain `stat` turns them away before the real location is asked.
fn is_vault_file(vault: &UnderRoot, root: &Path, abs: &Path) -> bool {
    if !std::fs::metadata(abs).is_ok_and(|meta| meta.is_file()) {
        return false;
    }
    let rel = relative(root, abs);
    matches!(vault.resolve(&rel), Ok(Resolution::Inside(real)) if real.is_file())
}

/// `findOnDisk`: from the vault root, from the note's folder, from the notes folder, then from
/// the root attachments folder, which the index never holds.
fn on_disk(
    vault: &UnderRoot,
    root: &Path,
    notes_folder: &str,
    target: &str,
    note_path: Option<&str>,
) -> Option<PathBuf> {
    let mut candidates = vec![resolve(root, target)];
    if let Some(note_path) = note_path {
        let note = resolve(root, note_path);
        candidates.push(resolve(note.parent().unwrap_or(root), target));
    }
    candidates.push(resolve(&resolve(root, notes_folder), target));
    candidates.push(resolve(&root.join(ATTACHMENTS_DIR), target));
    candidates
        .into_iter()
        .filter(|candidate| is_inside(root, candidate))
        .find(|candidate| is_vault_file(vault, root, candidate))
}

/// `lookupByFilenames`: the image of each lowercased file name, from the rows of every image in
/// the vault. Several folders can hold one name; the shortest path wins, as in Obsidian, and
/// only when it is on disk.
fn by_file_name(
    vault: &UnderRoot,
    root: &Path,
    files: &NoteFiles,
    names: &BTreeSet<String>,
) -> BTreeMap<String, PathBuf> {
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
            paths.sort_by(
                |a, b| match a.split('/').count().cmp(&b.split('/').count()) {
                    Ordering::Equal => locale_compare(a, b),
                    other => other,
                },
            );
            let abs = resolve(root, paths.first()?);
            (is_inside(root, &abs) && is_vault_file(vault, root, &abs)).then_some((name, abs))
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
    let note_path = note_path.filter(|path| !path.is_empty());
    let vault = match UnderRoot::new(root) {
        Ok(vault) => vault,
        Err(error) => {
            tracing::warn!(
                scope = "vault_embeds",
                "the vault folder could not be read: {error}"
            );
            return BTreeMap::new();
        }
    };
    let configured = read_vault_config(root).default_note_folder;
    let notes_folder = if configured.is_empty() {
        NOTES_FOLDER
    } else {
        &configured
    };
    let mut resolved = BTreeMap::new();
    let mut pending = Vec::new();
    for reference in refs {
        if !is_wiki_image_embed_target(reference)
            || has_scheme(reference)
            || Path::new(reference).has_root()
        {
            continue;
        }
        match on_disk(&vault, root, notes_folder, reference, note_path) {
            Some(abs) => {
                if let Some(target) = target(root, &abs, note_path) {
                    resolved.insert(reference.clone(), target);
                }
            }
            None => pending.push((reference, basename(reference, WINDOWS).to_lowercase())),
        }
    }
    if pending.is_empty() {
        return resolved;
    }
    let names = pending.iter().map(|(_, name)| name.clone()).collect();
    let found = by_file_name(&vault, root, files, &names);
    for (reference, name) in pending {
        if let Some(target) = found
            .get(&name)
            .and_then(|abs| target(root, abs, note_path))
        {
            resolved.insert(reference.clone(), target);
        }
    }
    resolved
}

/// The embeds of one markdown text, resolved before the converter runs: the converter asks for
/// them while the database's writer is held, where the image lookup cannot run. A target the
/// text does not hold resolves to nothing.
pub struct Resolved(BTreeMap<String, String>);

impl Resolved {
    /// The embeds of `markdown`, a body of the note at `note_path`, each relative to the note.
    /// Nothing is read for a text with no image embed.
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

/// The Windows branches, against Node's `path.win32` (`basename`, the case-insensitive
/// `relative`) and the win32 branch of `toMemryFileUrl`, run on every platform.
#[cfg(test)]
mod tests {
    use std::path::{Component, Path};

    use super::{basename, memry_file_url, same};

    #[test]
    fn the_windows_branches_answer_as_node_s_win32_path() {
        // path.win32.basename / path.posix.basename
        assert_eq!(basename("img\\photo.png", true), "photo.png");
        assert_eq!(basename("a/b\\c.png", true), "c.png");
        assert_eq!(basename("dir\\", true), "dir");
        assert_eq!(basename("img\\photo.png", false), "img\\photo.png");
        // path.win32.relative('C:\\Vault\\Notes', 'c:\\vault\\img\\x.png') === '..\\img\\x.png'
        let (img, upper) = (
            Component::Normal("Img".as_ref()),
            Component::Normal("img".as_ref()),
        );
        assert!(same(&img, &upper, true));
        assert!(!same(&img, &upper, false));
        // 'memry-file://local/' + path.win32.normalize(p).replace(/\\/g, '/')
        let url = memry_file_url(Path::new("C:\\Vault\\img\\a b.png"), true);
        assert_eq!(url, "memry-file://local/C:/Vault/img/a b.png");
        let url = memry_file_url(Path::new("/Users/v/img/a.png"), false);
        assert_eq!(url, "memry-file://local/Users/v/img/a.png");
    }
}
