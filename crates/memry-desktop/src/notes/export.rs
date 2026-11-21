//! A note written out as a self-contained HTML file: Electron's `renderNoteForExport` and the
//! write of `notes:export-html` (`apps/desktop/src/main/ipc/notes-handlers.ts:174-203`,
//! `:1096`). The document itself comes from [`crate::export`].

use std::path::Path;

use chrono::{DateTime, Local, NaiveDate};

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

/// The local calendar date of an epoch-millisecond time, as `toLocaleDateString` prints it.
fn local_date(ms: i64) -> NaiveDate {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .with_timezone(&Local)
        .date_naive()
}

impl NotesService {
    /// The note as Electron's `renderNoteForExport` gives it: rendered, its images inlined from
    /// the vault or `app_data` (the app's data folder, `memry-file`'s other root).
    pub fn note_html(
        &self,
        open: &OpenVault,
        note: &NoteView,
        export: HtmlExport,
        app_data: &Path,
    ) -> String {
        // The header asks only for a `custom:` icon, as Electron's `getCustomIcon` reads the row
        // only then. An icon that cannot be read is left out, as Electron leaves out a missing one.
        let find_custom_icon = |id: &str| match open.vault.custom_icon_list() {
            Ok(list) => list
                .icons
                .into_iter()
                .find(|icon| icon.id == id)
                .map(|icon| CustomIcon {
                    ext: icon.ext,
                    data: icon.data,
                }),
            Err(error) => {
                tracing::warn!("note export renders without its custom icon: {error}");
                None
            }
        };
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
        inline_export_images(
            &html,
            ImageSource {
                note_path: Some(&note.path),
                vault_path: Some(&open.path),
                app_data: Some(app_data),
            },
        )
    }

    /// Writes the note's HTML to `target`, as `fs.writeFile` does: created or replaced.
    pub fn export_html(
        &self,
        open: &OpenVault,
        note: &NoteView,
        export: HtmlExport,
        app_data: &Path,
        target: &Path,
    ) -> std::io::Result<()> {
        std::fs::write(target, self.note_html(open, note, export, app_data))
    }
}
