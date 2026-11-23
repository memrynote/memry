//! Where each exported file goes, in desktop's vault layout: a note at
//! `<folder>/<title>.md`, a journal day at `journal/<date>.md`, an attachment
//! at `attachments/<noteId>/<file name>`.
//!
//! Titles, folder paths and file names arrive through sync from any device, so
//! nothing here trusts them as path components.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Desktop's `sanitizeFilename` (`apps/desktop/src/main/vault/file-ops.ts:484`),
/// plus control characters removed and a cap in UTF-8 bytes rather than
/// characters: an iOS file name holds 255 bytes, and 200 leaves room for a
/// clash suffix and the extension.
pub(super) fn file_stem(title: &str) -> String {
    let kept: String = title
        .chars()
        .filter(|c| !"<>:\"/\\|?*[]#^".contains(*c) && !c.is_control())
        .collect();
    let mut stem = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    while let Some(rest) = stem.strip_prefix('.') {
        stem = rest.trim().to_owned();
    }
    if stem.is_empty() {
        return "untitled".to_owned();
    }
    while stem.len() > 200 {
        stem.pop();
    }
    stem.trim_end().to_owned()
}

/// A note's folder, one sanitised component per segment. Empty segments are
/// dropped, and `..` sanitises to a plain name, so the result never leaves the
/// export folder.
pub(super) fn folder(path: Option<&str>) -> Vec<String> {
    path.unwrap_or_default()
        .split(['/', '\\'])
        .filter(|segment| !segment.trim().is_empty())
        .map(file_stem)
        .collect()
}

/// A name that must stay exactly as written to keep a link working (a note id
/// in `attachments/<noteId>/`, an attachment's file name), or `None` when it is
/// not a single safe path component.
pub(super) fn component(name: &str) -> Option<&str> {
    let unsafe_name = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\0'])
        || name.len() > 255;
    (!unsafe_name).then_some(name)
}

/// The last segment of an attachment's file name, as desktop takes it.
pub(super) fn basename(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

/// A relative path under the export folder, joined component by component.
pub(super) fn under(root: &Path, segments: &[String]) -> PathBuf {
    segments
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

/// The file paths already handed out, folded for case, because a Files
/// provider may be case-insensitive and two notes must never share a file.
#[derive(Default)]
pub(super) struct Names {
    taken: HashSet<String>,
}

impl Names {
    /// `folder/stem.ext`, or desktop's `stem 1.ext`, `stem 2.ext` when that
    /// is taken (`generateUniquePathSync`, `file-ops.ts:570`).
    pub fn claim(&mut self, folder: &[String], stem: &str, extension: &str) -> Vec<String> {
        let mut counter = 0;
        loop {
            let name = match counter {
                0 => format!("{stem}{extension}"),
                n => format!("{stem} {n}{extension}"),
            };
            let mut segments = folder.to_vec();
            segments.push(name);
            if self.taken.insert(segments.join("/").to_lowercase()) {
                return segments;
            }
            counter += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_become_desktop_file_names() {
        assert_eq!(file_stem("Plan: Q3 / Q4?"), "Plan Q3 Q4");
        assert_eq!(file_stem("..hidden"), "hidden");
        assert_eq!(file_stem("  "), "untitled");
        assert_eq!(file_stem("a\u{0}b\nc"), "abc");
        assert!(file_stem(&"é".repeat(300)).len() <= 200);
    }

    #[test]
    fn a_folder_never_climbs_out() {
        assert_eq!(folder(Some("../../etc/Work")), ["untitled", "untitled", "etc", "Work"]);
        assert_eq!(folder(Some("/Projects//Q3/")), ["Projects", "Q3"]);
        assert!(folder(None).is_empty());
    }

    #[test]
    fn a_clash_takes_the_next_number_whatever_the_case() {
        let mut names = Names::default();
        assert_eq!(names.claim(&[], "Note", ".md"), ["Note.md"]);
        assert_eq!(names.claim(&[], "note", ".md"), ["note 1.md"]);
        assert_eq!(names.claim(&[], "Note", ".md"), ["Note 2.md"]);
    }

    #[test]
    fn only_single_components_pass() {
        assert_eq!(component("abc_1-Z"), Some("abc_1-Z"));
        assert_eq!(component(".."), None);
        assert_eq!(component("a/b"), None);
        assert_eq!(basename("dir\\a.png"), "a.png");
    }
}
