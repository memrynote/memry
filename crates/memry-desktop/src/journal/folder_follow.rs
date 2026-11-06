//! The journal folder moved as a whole, after `vault/journal-folder-follow.ts`.
//!
//! Renaming `Daily Notes` to `Diary` in Finder reaches the watcher as one move per file. With
//! the config still naming `Daily Notes`, each day would land outside the journal and cross into
//! a note: a journal delete synced for every day. A move that is the folder going whole
//! ([`journal_folder_moved`]) is held instead, owed its move, and the setting follows the folder
//! ([`follow_moved_journal`]).

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use memry_core::api::notes_write::NotesWriter;

use crate::notes::folders::holds_journal_days;
use crate::notes::owed_moves::settle_followed;
use crate::vault::config::read_vault_config_strict;
use crate::vault::config::settings::JournalFollow;
use crate::vault::journal_format::{JournalDays, normalize_journal_folder};
use crate::vault::path_key::folded_key;

const SCOPE: &str = "journal_folder_follow";

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

/// The journal folder once the app moved the folder `from` to `to`, when `journal_folder` is
/// `from` or inside it (`followJournalFolderMove`): `Personal/journal`, with `Personal` moved to
/// `Archive/Personal`, gives `Archive/Personal/journal`. The setting is read as the days are
/// (`normalize_journal_folder`): `/Personal/journal/` is that folder too.
pub(crate) fn followed_journal_folder(
    journal_folder: &str,
    from: &str,
    to: &str,
) -> Option<String> {
    let journal_folder = normalize_journal_folder(journal_folder);
    let below = journal_folder.strip_prefix(from)?;
    (below.is_empty() || below.starts_with('/')).then(|| format!("{to}{below}"))
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

/// What [`follow_moved_journal`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Follow {
    /// No day is held, or the settings cannot be read (each caller refuses that on its own).
    Nothing,
    /// The setting followed the folder the held days are in.
    Followed,
    /// Days are held in `folders`, and the setting cannot follow them (the module's doc of
    /// [`follow_moved_journal`]). A day named under the old folder would make it again, and a
    /// change saved over them would leave them outside the journal: either way the next open
    /// would cross every held day into a note. So no day is made, no journal setting change
    /// moves days, and no folder that is, holds or is inside one of `folders` moves or goes,
    /// until they can follow or go back.
    HeldWaits { folders: Vec<String> },
}

impl Follow {
    /// Whether `folder` is, holds or is inside a folder whose held days wait.
    pub(crate) fn holds(&self, folder: &str) -> bool {
        let Self::HeldWaits { folders } = self else {
            return false;
        };
        folders.iter().any(|held| overlaps(held, folder))
    }
}

/// Whether one of the two folders is the other or inside it, in any case.
pub(crate) fn overlaps(a: &str, b: &str) -> bool {
    let at_or_below = |inner: &str, outer: &str| {
        let (inner, outer) = (folded_key(inner), folded_key(outer));
        inner == outer || inner.starts_with(&format!("{outer}/"))
    };
    at_or_below(a, b) || at_or_below(b, a)
}

/// The journal setting follows the journal folder moved outside the app
/// (`followJournalFolderMove` for the watcher's moves). A day the move carried is held, owed
/// its move (`notes::owed_moves::held`); once every held day went from the configured folder to
/// one folder `M` with the path below unchanged, the configured folder is gone under its exact
/// spelling and `M` is there, and `M` is a folder the days can live in, `M` is saved. The moves
/// the folder's files are owed then settle by [`settle_followed`], so each day keeps its day and
/// a note a date names stays that note. Each held day's move is read from where it was before
/// the first move the record is owed (the owed `from_path`), so a folder renamed twice is the
/// journal moving twice.
///
/// Electron follows at the first event of the move. Here the consumer follows once its queue
/// went quiet after the batch of facts that held a day, the rows' lane released
/// (`NoteIdentity::follow_held`): every file of the folder's move is applied by then, so a note
/// a date names moved with the days is never judged under the new setting mid-move, and no
/// later move, folder made again under the old name, day create or settings change sees the
/// held state. The open follows too, before its lane and walk, for days an earlier session
/// held and could not follow; a day create, a settings update, a folder move and a folder delete
/// ask first, for days a batch held and could not follow yet, and refuse while they wait
/// ([`Follow::HeldWaits`]). Called with no settings' lock held, since it takes it, and only
/// when a move is owed.
///
/// Nothing follows while a journal setting change is recorded (it owns the days until it
/// settles), while the settings cannot be read, while the held days name more than one folder,
/// or into a folder the days cannot live in. The days then stay held; the failures are logged.
pub(crate) fn follow_moved_journal(root: &Path, writer: &NotesWriter) -> Follow {
    let owed = match writer.owed_places() {
        Ok(owed) if owed.is_empty() => return Follow::Nothing,
        Ok(owed) => owed,
        Err(error) => {
            tracing::error!(scope = SCOPE, "the owed moves could not be read: {error}");
            return Follow::Nothing;
        }
    };
    let settings = JournalFollow::hold();
    let followed = (|| -> Result<Follow, String> {
        let failed = |error: &dyn std::fmt::Display| error.to_string();
        let Ok(config) = read_vault_config_strict(root) else {
            return Ok(Follow::Nothing);
        };
        let journal = normalize_journal_folder(&config.journal_folder);
        let mut moved = BTreeSet::new();
        for owed in &owed {
            let day = writer.journal_date(&owed.note_id).map_err(|e| failed(&e))?;
            if let Some(to) = day.and(moved_journal_folder(&journal, &owed.from_path, &owed.path)) {
                moved.insert(to);
            }
        }
        if moved.is_empty() {
            return Ok(Follow::Nothing);
        }
        let waits = Follow::HeldWaits {
            folders: moved.iter().cloned().collect(),
        };
        let mut folders = moved.into_iter();
        let (Some(to), None) = (folders.next(), folders.next()) else {
            return Ok(waits);
        };
        // A check that cannot be made counts as failed: the days stay held. A target that is
        // gone, or there in another spelling, is one the days cannot live in.
        if !writer
            .pending_journal_change()
            .is_ok_and(|change| change.is_none())
            || folder_exists_exact_case(root, &journal)
            || !holds_journal_days(root, &to, config.exclude_patterns.clone()).unwrap_or(false)
        {
            return Ok(waits);
        }
        if let Err(error) = settings.save(root, &to) {
            tracing::warn!(
                scope = SCOPE,
                "the followed journal folder was not saved: {error}"
            );
            return Ok(waits);
        }
        let format = &config.journal_date_format;
        let days = (
            JournalDays::new(&journal, format),
            JournalDays::new(&to, format),
        );
        let carried: Vec<(&str, &str, &str)> = owed
            .iter()
            .filter(|owed| {
                moved_journal_folder(&journal, &owed.from_path, &owed.path).as_ref() == Some(&to)
            })
            .map(|owed| (&*owed.note_id, &*owed.from_path, &*owed.path))
            .collect();
        if let Err(error) = settle_followed(&days, writer, &carried) {
            // Saved: the open's identity settles each day's move by the new setting.
            tracing::warn!(scope = SCOPE, "the followed folder's moves wait: {error}");
        }
        tracing::info!(
            scope = SCOPE,
            folder = to,
            "the journal setting followed the journal folder moved outside the app"
        );
        Ok(Follow::Followed)
    })();
    match followed {
        Ok(Follow::HeldWaits { folders }) => {
            // TODO(#3531 Step 14): tell the user the journal days wait in these folders.
            tracing::warn!(
                scope = SCOPE,
                ?folders,
                "journal days the journal folder's move carried wait for the setting to follow"
            );
            Follow::HeldWaits { folders }
        }
        Ok(follow) => follow,
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                "the journal setting waits to follow a journal folder moved outside the app: \
                 {error}"
            );
            Follow::Nothing
        }
    }
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
