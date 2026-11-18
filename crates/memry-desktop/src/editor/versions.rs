//! The version history of a note or a journal day (Step 14d, #3531; Electron
//! `vault/notes-versions.ts` and `note-snapshots.ts`). Core keeps the versions and their rules
//! ([`memry_core::domain::note_snapshots`]); this lists, reads, deletes and restores them, and
//! keeps the close version of every open note as the app quits.
//!
//! **Restore** replaces the note's body with the version's, through the app edit with
//! [`Precondition::Restore`], in the note's write turn: the file it replaces is kept as the
//! newest version first, and the feed keeps the document's body when it is ahead of the file,
//! so the text the user had can be restored in turn. The feed is the outside-edit feed
//! (`Origin::External`), so every open editor swaps to the restored body. The file's
//! frontmatter stays as it is: a version is a whole file, but the frontmatter carries the
//! note's id, tags and properties, whose records follow only their own edits. A locked note
//! refuses the restore (`Kept::Locked`).
//!
//! **Close versions**: the `close-snapshots` quit step keeps the file of every note an editor
//! holds as a `close` version (`createCloseSnapshots`), after the write-back's flush, so it
//! holds the last edit.

use std::cell::RefCell;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::domain::note_snapshots::{Kept, Listed};
use memry_core::markdown::frontmatter::split_frontmatter_block;
use serde::Serialize;

use crate::notes::error::NotesError;
use crate::notes::read;
use crate::notes::service::NotesService;
use crate::notes::update::tag_keys;
use crate::notes::view::NoteView;
use crate::session::{OpenVault, Session};
use crate::shell::shutdown::{StepFn, close_versions_timeout};
use crate::vault::app_edit::{Edited, Precondition};
use crate::vault::consumer::ChangeSource;
use crate::vault::file_types::FileType;
use crate::vault::note_file::read_note;

const SCOPE: &str = "versions";

/// `SnapshotListItem`. `reason` is the stored column, which the renderer reads as
/// `SnapshotReason`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VersionView {
    pub id: String,
    pub note_id: String,
    pub title: String,
    pub word_count: u32,
    pub reason: String,
    pub created_at: String,
}

/// `SnapshotDetail`: the version and what a restore puts in the note, which the panel previews:
/// the version's body ([`restore_body`]). Electron sent the whole file, whose frontmatter its
/// restore wrote too; this restore keeps the note's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VersionDetailView {
    pub id: String,
    pub note_id: String,
    pub title: String,
    pub word_count: u32,
    pub reason: String,
    pub created_at: String,
    pub file_content: String,
}

impl From<Listed> for VersionView {
    fn from(listed: Listed) -> Self {
        Self {
            word_count: u32::try_from(listed.word_count).unwrap_or(u32::MAX),
            id: listed.id,
            note_id: listed.note_id,
            title: listed.title,
            reason: listed.reason,
            created_at: listed.created_at,
        }
    }
}

impl From<Kept> for VersionDetailView {
    fn from(kept: Kept) -> Self {
        let VersionView {
            id,
            note_id,
            title,
            word_count,
            reason,
            created_at,
        } = kept.listed.into();
        Self {
            id,
            note_id,
            title,
            word_count,
            reason,
            created_at,
            file_content: restore_body(&kept.content).to_owned(),
        }
    }
}

/// What a restore came to.
#[derive(Debug)]
pub struct Restored {
    /// The note as it reads now; `None` for a journal day, which is no note.
    pub note: Option<NoteView>,
    /// The body's `#tags` changed (`notes:tags-changed`).
    pub tags_changed: bool,
}

/// The note's versions, newest first (`notes:get-versions`).
pub fn list(open: &OpenVault, note_id: &str) -> Result<Vec<VersionView>, NotesError> {
    let listed = open.vault.versions().list(note_id)?;
    Ok(listed.into_iter().map(VersionView::from).collect())
}

/// One version (`notes:get-version`).
pub fn get(open: &OpenVault, id: &str) -> Result<Option<VersionDetailView>, NotesError> {
    Ok(open.vault.versions().get(id)?.map(VersionDetailView::from))
}

/// Deletes one version (`notes:delete-version`). True when it was there.
pub fn delete(open: &OpenVault, id: &str) -> Result<bool, NotesError> {
    Ok(open.vault.versions().delete(id)?)
}

/// Restores the version `id` (`notes:restore-version`): see the module comment.
pub fn restore(notes: &NotesService, open: &OpenVault, id: &str) -> Result<Restored, NotesError> {
    let version = open
        .vault
        .versions()
        .get(id)?
        .ok_or_else(|| NotesError::NotFound(id.to_owned()))?;
    let note_id = version.listed.note_id.as_str();
    let body = restore_body(&version.content);
    let read_body = RefCell::new(String::new());
    let edited = notes.order.run(note_id, |turn| {
        notes.save_edit(open)?.run(
            turn,
            Precondition::Restore(&notes.own_files),
            ChangeSource::Save,
            |text| {
                let split = split_frontmatter_block(text);
                *read_body.borrow_mut() = split.body.to_owned();
                Ok::<_, NotesError>(Some(format!("{}{body}", split.block.unwrap_or(""))))
            },
        )
    })?;
    if let Edited::Kept(kept) = edited {
        tracing::info!(scope = SCOPE, note_id, ?kept, "a restore was refused");
        return Err(NotesError::EditKept(kept));
    }
    Ok(Restored {
        note: read::get(open, note_id, None)?,
        tags_changed: tag_keys(&read_body.into_inner()) != tag_keys(body),
    })
}

/// What a restore of a version whose file is `content` puts in the note: its body, without the
/// frontmatter block and the byte order mark, which the note's file keeps as they are.
pub fn restore_body(content: &str) -> &str {
    split_frontmatter_block(content.strip_prefix('\u{feff}').unwrap_or(content)).body
}

/// The `close-snapshots` quit step: [`keep_close_versions`] for the open vault, within what is
/// left of the quit, at most [`close_versions_timeout`] of it. Best effort, as Electron's
/// `createCloseSnapshots`: a failure or a timeout is logged and the step succeeds, since a
/// failed step ends the sequence before the steps behind it (the sync runtime's stop and final
/// push), and the timeout leaves them the rest. The versions a timeout cuts short go on being
/// kept beside them.
pub fn close_step(session: Session) -> StepFn {
    Arc::new(move |_, deadline| {
        let session = session.clone();
        Box::pin(async move {
            let keep = tokio::task::spawn_blocking(move || {
                session
                    .current()
                    .map_or(0, |open| keep_close_versions(&open))
            });
            let timeout = close_versions_timeout(deadline.remaining());
            match tokio::time::timeout(timeout, keep).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    tracing::error!(scope = SCOPE, "the close versions failed: {error}");
                }
                Err(_) => tracing::warn!(scope = SCOPE, "the close versions ran out of time"),
            }
            Ok(())
        })
    })
}

/// Keeps the file of every note an editor holds as a `close` version; the number kept. The
/// editor is never built here (that reads the device identity, which a locked keychain
/// refuses): with none built, no note is open. A note that fails is logged by id and the
/// rest still run.
pub fn keep_close_versions(open: &OpenVault) -> usize {
    let Some(editor) = open.vault.built_editor() else {
        return 0;
    };
    let mut kept = 0;
    for note_id in editor.open_note_ids() {
        match keep_close(open, &note_id) {
            Ok(true) => kept += 1,
            Ok(false) => {}
            Err(error) => {
                tracing::error!(scope = SCOPE, note_id, "no close version was kept: {error}")
            }
        }
    }
    if kept > 0 {
        tracing::info!(scope = SCOPE, kept, "close versions kept");
    }
    kept
}

fn keep_close(open: &OpenVault, note_id: &str) -> Result<bool, String> {
    let row = open.vault.note_files().by_id(note_id);
    let Some(row) = row.map_err(|error| error.to_string())? else {
        return Ok(false);
    };
    if row.file_type != FileType::Markdown.as_str() {
        return Ok(false);
    }
    let file = read_note(&open.path, &row.path).map_err(|error| error.to_string())?;
    let Some(file) = file else { return Ok(false) };
    open.vault
        .versions()
        .keep_close(note_id, &file.raw)
        .map_err(|error: StorageError| error.to_string())
}
