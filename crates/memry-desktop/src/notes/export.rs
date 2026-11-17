//! A note written out as a self-contained HTML file: Electron's `renderNoteForExport` and the
//! write of `notes:export-html` (`apps/desktop/src/main/ipc/notes-handlers.ts:174-203`,
//! `:1096`). The document itself comes from [`crate::export`].

use std::path::Path;

use chrono::{DateTime, Local, NaiveDate};
use memry_core::api::errors::{AuthError, StorageError};

use super::service::NotesService;
use super::view::NoteView;
use crate::export::{
    CustomIcon, ImageSource, NoteExport, RenderOptions, inline_export_images, render_note_as_html,
};
use crate::session::OpenVault;

/// The `ExportNoteSchema` switches the HTML reads.
#[derive(Debug, Clone, Copy)]
pub struct HtmlExport {
    /// Icon, dates and tags in the header.
    pub include_metadata: bool,
    /// Keep each task's `{task:<id>}` suffix.
    pub include_task_markers: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error(transparent)]
    Icons(#[from] AuthError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("{0}")]
    Write(#[from] std::io::Error),
}

const CUSTOM_ICON_PREFIX: &str = "custom:";

/// The local calendar date of an epoch-millisecond time, as `toLocaleDateString` prints it.
fn local_date(ms: i64) -> NaiveDate {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .with_timezone(&Local)
        .date_naive()
}

impl NotesService {
    /// The note as Electron's `renderNoteForExport` gives it: rendered, its images inlined.
    pub fn note_html(
        &self,
        open: &OpenVault,
        note: &NoteView,
        export: HtmlExport,
    ) -> Result<String, ExportError> {
        // Electron's `getCustomIcon` reads the row only for a `custom:` icon.
        let custom = match note
            .emoji
            .as_deref()
            .and_then(|icon| icon.strip_prefix(CUSTOM_ICON_PREFIX))
        {
            Some(id) => open
                .vault
                .custom_icons(self.store.clone())?
                .list()?
                .icons
                .into_iter()
                .find(|icon| icon.id == id)
                .map(|icon| CustomIcon {
                    ext: icon.ext,
                    data: icon.data,
                }),
            None => None,
        };
        let find_custom_icon = |_: &str| custom.clone();
        let html = render_note_as_html(
            &NoteExport {
                title: &note.title,
                content: &note.content,
                icon: note.emoji.as_deref(),
                tags: &note.tags,
                created: local_date(note.created),
                modified: local_date(note.modified),
            },
            &RenderOptions {
                include_metadata: export.include_metadata,
                include_task_markers: export.include_task_markers,
                find_custom_icon: &find_custom_icon,
            },
        );
        Ok(inline_export_images(
            &html,
            ImageSource {
                note_path: Some(&note.path),
                vault_path: Some(&open.path),
            },
        ))
    }

    /// Writes the note's HTML to `target`, as `fs.writeFile` does: created or replaced.
    pub fn export_html(
        &self,
        open: &OpenVault,
        note: &NoteView,
        export: HtmlExport,
        target: &Path,
    ) -> Result<(), ExportError> {
        let html = self.note_html(open, note, export)?;
        std::fs::write(target, html)?;
        Ok(())
    }
}
