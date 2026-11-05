//! What the identity reads off a vault file: its place, its markdown class, its creation time,
//! and whether Electron's database is beside it.

use std::path::Path;
use std::time::UNIX_EPOCH;

use memry_core::markdown::shared::markdown_class::{
    MarkdownClassThresholds, classify_markdown_content, classify_markdown_stat,
};

/// Electron's database is beside the vault's files (`<vault>/.memry/data.db`).
pub(in crate::notes) fn electron_db_beside(root: &Path) -> bool {
    root.join(".memry").join("data.db").is_file()
}

/// Large-file class (`packages/shared/src/markdown-class.ts`): the size alone, else the text.
pub(in crate::notes) fn is_large_file(size: u64, raw: &str) -> bool {
    let thresholds = MarkdownClassThresholds::default();
    let by_size = usize::try_from(size).map_or(true, |bytes| {
        classify_markdown_stat(bytes, thresholds).is_some()
    });
    by_size
        || classify_markdown_content(raw, thresholds)
            .large_file
            .is_some()
}

/// The folder (`None` at the root) and the title of a vault-relative `/` path: the file name
/// without `.md`, as `path.basename(p, '.md')` reads it (a name that is only `.md` keeps it).
/// Exact: a title that differs from a record's only in case or Unicode normalization is
/// another title, as it is to Electron.
pub(in crate::notes) fn place(path: &str) -> (Option<&str>, &str) {
    let (folder, name) = match path.rsplit_once('/') {
        Some((folder, name)) => (Some(folder), name),
        None => (None, path),
    };
    let title = match name.strip_suffix(".md") {
        Some(stem) if !stem.is_empty() => stem,
        _ => name,
    };
    (folder, title)
}

/// When the file was created, where the file system records it.
pub(super) fn created_ms(path: &Path) -> Option<i64> {
    let created = std::fs::metadata(path).ok()?.created().ok()?;
    let since = created.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_is_the_file_name_without_md_and_the_folder_its_parent() {
        assert_eq!(place("a.md"), (None, "a"));
        assert_eq!(place("x/y/a.b.md"), (Some("x/y"), "a.b"));
        assert_eq!(place("x/Note.MD"), (Some("x"), "Note.MD"));
        assert_eq!(place("x/.md"), (Some("x"), ".md"));
    }

    #[test]
    fn the_large_file_class_is_the_size_or_a_block() {
        assert!(!is_large_file(5, "small"));
        assert!(is_large_file(2 * 1024 * 1024, "small"));
        assert!(is_large_file(200 * 1024, &"x".repeat(200 * 1024)));
        assert!(!is_large_file(200 * 1024, &"x\n\n".repeat(60 * 1024)));
    }
}
