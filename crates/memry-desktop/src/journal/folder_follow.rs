//! The journal folder moved as a whole, after `vault/journal-folder-follow.ts`.
//!
//! Renaming `Daily Notes` to `Diary` in Finder reaches the watcher as one move per file. With
//! the config still naming `Daily Notes`, each day would land outside the journal and cross into
//! a note: a journal delete synced for every day. A move that is the folder going whole
//! ([`journal_folder_moved`]) is held instead; following the config to the new folder is 13m-7.

use std::fs;
use std::path::Path;

/// The folder a journal entry now lives in, when `new_path` is `old_path` with the journal
/// folder swapped for another one and the path below it unchanged (`inferMovedJournalFolder`):
/// `Daily Notes/2025/01/2025-01-14.md` to `Diary/2025/01/2025-01-14.md` gives `Diary`.
pub fn moved_journal_folder(
    journal_folder: &str,
    old_path: &str,
    new_path: &str,
) -> Option<String> {
    if journal_folder.is_empty() {
        return None;
    }
    let below = old_path.strip_prefix(journal_folder)?.strip_prefix('/')?;
    let folder = new_path.strip_suffix(below)?.strip_suffix('/')?;
    (!folder.is_empty() && folder != journal_folder).then(|| folder.to_owned())
}

/// True when every segment of `folder` is a folder under `root` with exactly this spelling
/// (`folderExistsExactCase`): a plain `exists` says yes to `daily` after a rename to `Daily` on
/// a case-insensitive file system, which would hide exactly that rename.
pub fn folder_exists_exact_case(root: &Path, folder: &str) -> bool {
    let mut current = root.to_path_buf();
    for segment in folder.split('/') {
        let Ok(entries) = fs::read_dir(&current) else {
            return false;
        };
        let found = entries.flatten().any(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir()) && entry.file_name() == segment
        });
        if !found {
            return false;
        }
        current.push(segment);
    }
    true
}

/// The folder the whole journal folder went to, when the move of a day from `old_path` to
/// `new_path` is that (`renameKeepsJournalDate`): the path below the folder unchanged, the
/// configured folder gone and the new one there.
pub fn journal_folder_moved(
    root: &Path,
    journal_folder: &str,
    old_path: &str,
    new_path: &str,
) -> Option<String> {
    moved_journal_folder(journal_folder, old_path, new_path).filter(|moved| {
        !folder_exists_exact_case(root, journal_folder) && folder_exists_exact_case(root, moved)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_folder_a_day_moved_to_has_the_path_below_it_unchanged() {
        let moved = |old, new| moved_journal_folder("Daily Notes", old, new);
        assert_eq!(
            moved("Daily Notes/2026-10-01.md", "Diary/2026-10-01.md").as_deref(),
            Some("Diary")
        );
        assert_eq!(
            moved(
                "Daily Notes/2025/January/2025-01-14.md",
                "Archive/Daily Notes/2025/January/2025-01-14.md"
            )
            .as_deref(),
            Some("Archive/Daily Notes")
        );
        let journal = |old, new| moved_journal_folder("journal", old, new);
        assert_eq!(journal("journal/2026-10-01.md", "notes/renamed.md"), None);
        assert_eq!(journal("journal/2026-10-01.md", "2026-10-01.md"), None);
        assert_eq!(journal("other/2026-10-01.md", "Diary/2026-10-01.md"), None);
        assert_eq!(
            journal("journalx/2026-10-01.md", "Diary/2026-10-01.md"),
            None
        );
        assert_eq!(moved_journal_folder("", "a.md", "b/a.md"), None);
    }

    #[test]
    fn a_folder_is_there_only_under_its_exact_spelling() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("Notes/Daily")).unwrap();
        assert!(folder_exists_exact_case(root.path(), "Notes/Daily"));
        assert!(!folder_exists_exact_case(root.path(), "notes/daily"));
        assert!(!folder_exists_exact_case(root.path(), "Notes/Missing"));
    }
}
