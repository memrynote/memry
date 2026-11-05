//! The tag list, a tag's notes, the tag hub's edits and a tag's pins (`tags:*` of
//! `ipc/tags-handlers.ts`), each one call of `memry_desktop::tags`. None of them writes a note
//! file. After a write they send what Electron's handler sends: [`TagColorUpdatedEvent`] and
//! [`NoteTagsChangedEvent`] for a colour, [`NoteTagsChangedEvent`] for an icon,
//! [`TagCategoriesChangedEvent`] for a category or a drag, [`TagNotesChangedEvent`] for a pin.
//!
//! A rename is the one that writes the note files, through `NotesService::rename_tag`: it sends
//! [`TagsProgressEvent`] as the notes go, then [`TagRenamedEvent`] and [`NoteTagsChangedEvent`],
//! once the note index measured the files it wrote, as a day's save is
//! (`shell::journal_events::measure`): the tag list's refetch on the event reads their headers.

use std::sync::Arc;

use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::tag_rename::{RenameJob, TagRenamed};
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::tags::view::{
    NotesByTagInput, NotesByTagView, ReorderInput, TagCategoryView, TagWithCountView,
};
use memry_desktop::tags::{self, Hub, TagsError};
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::events::Metrics;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::service;
use crate::events::{
    NoteTagsChangedEvent, TagCategoriesChangedEvent, TagColorUpdatedEvent, TagNoteAction,
    TagNotesChangedEvent, TagRenamedEvent, TagsProgressEvent, broadcast,
};

/// The open vault, or the localized "no vault is open".
pub(super) fn open_vault<R: Runtime>(app: &AppHandle<R>) -> Result<OpenVault, CommandError> {
    app.state::<Session>().current().ok_or_else(|| {
        let locale = app.state::<Arc<LocaleService>>().get();
        CommandError::new(
            ErrorKind::Invalid,
            "no_vault_open",
            i18n::t(locale, "errors:ipc.noVaultOpen", &Args::new()),
        )
    })
}

/// A category name that is blank once trimmed, refused with Electron's localized message
/// before it reaches the hub (which refuses it too).
fn category_name<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<(), CommandError> {
    if !name.trim().is_empty() {
        return Ok(());
    }
    let locale = app.state::<Arc<LocaleService>>().get();
    Err(CommandError::new(
        ErrorKind::Invalid,
        "invalid",
        i18n::t(locale, "errors:tag.categoryNameRequired", &Args::new()),
    ))
}

/// A hub write that landed, for [`announce`].
pub enum Written {
    Color {
        tag: String,
        color: String,
    },
    Icon,
    CategoryCreated(String),
    /// Renamed or deleted.
    Category(String),
    Drag,
    Pin {
        tag: String,
        note_id: String,
        action: TagNoteAction,
    },
    Renamed {
        old_name: String,
        new_name: String,
        renamed: TagRenamed,
    },
}

/// What Electron's handler sends once the write landed: the events, and the telemetry of a
/// created category. Public for `tests/tags.rs`: a lib unit test that links the Tauri runtime
/// cannot load on Windows (see `build.rs`).
pub fn announce<R: Runtime>(app: &AppHandle<R>, written: Written) {
    match written {
        Written::Color { tag, color } => {
            broadcast(app, TagColorUpdatedEvent { tag, color });
            broadcast(app, NoteTagsChangedEvent);
        }
        Written::Icon => broadcast(app, NoteTagsChangedEvent),
        Written::CategoryCreated(id) => {
            broadcast(
                app,
                TagCategoriesChangedEvent {
                    category_id: Some(id),
                },
            );
            if let Some(telemetry) = app.try_state::<Arc<Service>>() {
                let mut event = Service::event("tag_category_created", "tags", "created");
                event.object_type = Some("tag_category".to_owned());
                event.result = Some("success".to_owned());
                telemetry.track_main_event(event);
            }
        }
        Written::Category(id) => broadcast(
            app,
            TagCategoriesChangedEvent {
                category_id: Some(id),
            },
        ),
        Written::Drag => broadcast(app, TagCategoriesChangedEvent { category_id: None }),
        Written::Pin {
            tag,
            note_id,
            action,
        } => broadcast(
            app,
            TagNotesChangedEvent {
                tag,
                note_id,
                action,
            },
        ),
        Written::Renamed {
            old_name,
            new_name,
            renamed,
        } => {
            broadcast(
                app,
                TagRenamedEvent {
                    old_name,
                    new_name,
                    affected_notes: written_count(&renamed),
                },
            );
            broadcast(app, NoteTagsChangedEvent);
            if let Some(telemetry) = app.try_state::<Arc<Service>>() {
                let mut event = Service::event("tag_renamed", "tags", "renamed");
                event.object_type = Some("tag".to_owned());
                let failed = !renamed.failed_note_ids.is_empty();
                event.result = Some(if failed { "failed" } else { "success" }.to_owned());
                event.metrics = Some(Metrics {
                    item_count: Some(f64::from(written_count(&renamed))),
                    ..Metrics::default()
                });
                telemetry.track_main_event(event);
            }
        }
    }
}

/// The open vault's tag hub, written under this device's identity.
fn hub<R: Runtime>(app: &AppHandle<R>) -> Result<Hub, CommandError> {
    let open = open_vault(app)?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    Hub::open(&open, store).map_err(|error| CommandError::from_core(&error))
}

#[tauri::command]
#[specta::specta]
pub async fn tags_get_all_with_counts(
    app: AppHandle<Wry>,
) -> Result<Vec<TagWithCountView>, CommandError> {
    blocking("tags_get_all_with_counts", move || {
        tags::all_with_counts(&open_vault(&app)?).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_get_notes_by_tag(
    app: AppHandle<Wry>,
    input: NotesByTagInput,
) -> Result<NotesByTagView, CommandError> {
    blocking("tags_get_notes_by_tag", move || {
        tags::notes_by_tag(&open_vault(&app)?, &input)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_update_color(
    app: AppHandle<Wry>,
    tag: String,
    color: String,
) -> Result<(), CommandError> {
    blocking("tags_update_color", move || {
        hub(&app)?
            .set_color(&tag, &color)
            .map_err(|error| CommandError::from_core(&error))?;
        announce(&app, Written::Color { tag, color });
        Ok(())
    })
    .await
}

/// `icon` is an emoji or `icon:Name`; `None` clears it.
#[tauri::command]
#[specta::specta]
pub async fn tags_update_icon(
    app: AppHandle<Wry>,
    tag: String,
    icon: Option<String>,
) -> Result<(), CommandError> {
    blocking("tags_update_icon", move || {
        hub(&app)?
            .set_icon(&tag, icon.as_deref())
            .map_err(|error| CommandError::from_core(&error))?;
        announce(&app, Written::Icon);
        Ok(())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_list_categories(
    app: AppHandle<Wry>,
) -> Result<Vec<TagCategoryView>, CommandError> {
    blocking("tags_list_categories", move || {
        tags::categories(&open_vault(&app)?).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_create_category(
    app: AppHandle<Wry>,
    name: String,
) -> Result<TagCategoryView, CommandError> {
    blocking("tags_create_category", move || {
        category_name(&app, &name)?;
        let category = hub(&app)?
            .create_category(&name)
            .map_err(|error| CommandError::from_core(&error))?;
        announce(&app, Written::CategoryCreated(category.id.clone()));
        Ok(category)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_rename_category(
    app: AppHandle<Wry>,
    id: String,
    name: String,
) -> Result<(), CommandError> {
    blocking("tags_rename_category", move || {
        category_name(&app, &name)?;
        hub(&app)?
            .rename_category(&id, &name)
            .map_err(|error| CommandError::from_core(&error))?;
        announce(&app, Written::Category(id));
        Ok(())
    })
    .await
}

/// The category's tags become uncategorised.
#[tauri::command]
#[specta::specta]
pub async fn tags_delete_category(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    blocking("tags_delete_category", move || {
        hub(&app)?
            .delete_category(&id)
            .map_err(|error| CommandError::from_core(&error))?;
        announce(&app, Written::Category(id));
        Ok(())
    })
    .await
}

/// A drag in the tag hub: tag assignments and category order, all or nothing.
#[tauri::command]
#[specta::specta]
pub async fn tags_reorder(app: AppHandle<Wry>, input: ReorderInput) -> Result<(), CommandError> {
    blocking("tags_reorder", move || {
        hub(&app)?
            .reorder(&input)
            .map_err(|error| CommandError::from_core(&error))?;
        announce(&app, Written::Drag);
        Ok(())
    })
    .await
}

/// A pin the core refused or failed, worded as Electron's handler words it (`key`), with the
/// core's kind and code; the cause goes to the log.
fn pin_failed<R: Runtime>(app: &AppHandle<R>, key: &str, error: &TagsError) -> CommandError {
    tracing::warn!(scope = "TagsHandlers", "a tag pin failed: {error}");
    let core = CommandError::from_core(error);
    let locale = app.state::<Arc<LocaleService>>().get();
    CommandError::new(core.kind, core.code, i18n::t(locale, key, &Args::new()))
}

/// Pins or unpins a note in a tag and sends [`TagNotesChangedEvent`], as Electron does after
/// every pin, also one that changed nothing.
fn set_pinned<R: Runtime>(
    app: &AppHandle<R>,
    note_id: String,
    tag: String,
    action: TagNoteAction,
) -> Result<(), CommandError> {
    let (pinned, key) = match action {
        TagNoteAction::Pinned => (true, "errors:tag.pinNoteFailed"),
        TagNoteAction::Unpinned | TagNoteAction::Removed => (false, "errors:tag.unpinNoteFailed"),
    };
    hub(app)?
        .set_pinned(&note_id, &tag, pinned)
        .map_err(|error| pin_failed(app, key, &error))?;
    announce(
        app,
        Written::Pin {
            tag,
            note_id,
            action,
        },
    );
    Ok(())
}

/// Only a tag the note's record carries can be pinned (`memry_core::domain::tags::set_pinned`).
#[tauri::command]
#[specta::specta]
pub async fn tags_pin_note_to_tag<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    tag: String,
) -> Result<(), CommandError> {
    blocking("tags_pin_note_to_tag", move || {
        set_pinned(&app, note_id, tag, TagNoteAction::Pinned)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_unpin_note_from_tag<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    tag: String,
) -> Result<(), CommandError> {
    blocking("tags_unpin_note_from_tag", move || {
        set_pinned(&app, note_id, tag, TagNoteAction::Unpinned)
    })
    .await
}

/// `RenameTagSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameTagInput {
    pub old_name: String,
    pub new_name: String,
    /// Names the run in its [`TagsProgressEvent`]s; one is made up when absent.
    #[serde(default)]
    #[specta(optional)]
    pub run_id: Option<String>,
}

/// `RenameTagResponse` of a rename that ran.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameTagView {
    pub affected_notes: u32,
    /// The notes and days that keep the old name.
    pub failed_note_ids: Vec<String>,
    /// The new name cannot be an inline `#tag`, so the bodies keep the old one.
    pub body_skipped: bool,
}

/// `tags:rename`: the tag and its children across the vault, merged into a name in use.
#[tauri::command]
#[specta::specta]
pub async fn tags_rename<R: Runtime>(
    app: AppHandle<R>,
    input: RenameTagInput,
) -> Result<RenameTagView, CommandError> {
    blocking("tags_rename", move || rename(&app, input)).await
}

fn rename<R: Runtime>(
    app: &AppHandle<R>,
    input: RenameTagInput,
) -> Result<RenameTagView, CommandError> {
    let units = |text: &str| text.encode_utf16().count();
    let run_id = input
        .run_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if units(&input.old_name) == 0
        || !(1..=50).contains(&units(&input.new_name))
        || !(1..=100).contains(&units(&run_id))
    {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "invalid",
            "a tag rename takes an old name, a new one of at most 50 characters and a run id of \
             at most 100",
        ));
    }
    let open = open_vault(app)?;
    let job = RenameJob {
        from: input.old_name,
        to: input.new_name,
        run_id,
    };
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let mut progress = |done: usize, total: usize| {
        let run_id = job.run_id.clone();
        let (done, total) = (count(done), count(total));
        broadcast(
            app,
            TagsProgressEvent {
                run_id,
                done,
                total,
            },
        );
    };
    let renamed = service(app)?
        .rename_tag(&open, &job, &mut progress)
        .map_err(|error| rename_failed(app, &error))?;
    measure(app, &renamed.written);
    let view = RenameTagView {
        affected_notes: written_count(&renamed),
        failed_note_ids: renamed.failed_note_ids.clone(),
        body_skipped: renamed.body_skipped,
    };
    announce(
        app,
        Written::Renamed {
            old_name: job.from,
            new_name: job.to,
            renamed,
        },
    );
    Ok(view)
}

fn written_count(renamed: &TagRenamed) -> u32 {
    u32::try_from(renamed.written.len()).unwrap_or(u32::MAX)
}

/// The files a rename wrote measured into their index rows; one left to a pass lags the list
/// until the pass writes it, which sends [`NoteTagsChangedEvent`] again
/// (`shell::journal_events::landed`).
pub(super) fn measure<R: Runtime>(app: &AppHandle<R>, written: &[String]) {
    let Some(index) = app.try_state::<Arc<NoteIndex>>() else {
        tracing::warn!(
            scope = "TagsHandlers",
            "no note index: the tag list lags the rename"
        );
        return;
    };
    for note_id in written {
        match index.measure(note_id) {
            Ok(true) => {}
            Ok(false) => {
                tracing::debug!(scope = "TagsHandlers", note_id, "measured by a later pass")
            }
            Err(error) => {
                tracing::warn!(
                    scope = "TagsHandlers",
                    "the tag list lags the rename: {error}"
                );
                return;
            }
        }
    }
}

/// A rename left with notes it could not write, and those notes.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnfinishedRenameView {
    pub old_name: String,
    pub new_name: String,
    /// How many notes it left; `notes` names the first of them.
    pub left: u32,
    pub notes: Vec<UnfinishedNoteView>,
}

/// A note a rename left, named by its file's name.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UnfinishedNoteView {
    pub id: String,
    pub title: String,
}

/// The rename left with notes it could not write, if any; none while one runs. Tauri only:
/// Electron forgets the notes it could not write.
#[tauri::command]
#[specta::specta]
pub async fn tags_rename_unfinished<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<UnfinishedRenameView>, CommandError> {
    blocking("tags_rename_unfinished", move || {
        let open = open_vault(&app)?;
        let left = service(&app)?
            .unfinished_tag_rename(&open)
            .map_err(|error| CommandError::from_core(&error))?;
        Ok(left.map(|left| UnfinishedRenameView {
            old_name: left.job.from,
            new_name: left.job.to,
            left: u32::try_from(left.left).unwrap_or(u32::MAX),
            notes: left
                .notes
                .into_iter()
                .map(|note| UnfinishedNoteView {
                    id: note.id,
                    title: note.title,
                })
                .collect(),
        }))
    })
    .await
}

/// Stops the rename left unfinished: the notes it wrote keep the new name, the ones it left the
/// old, and other renames run again. `false` when none was recorded. A record it renamed sends
/// [`NoteTagsChangedEvent`].
#[tauri::command]
#[specta::specta]
pub async fn tags_rename_abandon<R: Runtime>(app: AppHandle<R>) -> Result<bool, CommandError> {
    blocking("tags_rename_abandon", move || {
        let open = open_vault(&app)?;
        let stopped = service(&app)?
            .abandon_tag_rename(&open)
            .map_err(|error| rename_failed(&app, &error))?;
        if stopped.as_ref().is_some_and(|stopped| stopped.renamed) {
            broadcast(&app, NoteTagsChangedEvent);
        }
        Ok(stopped.is_some())
    })
    .await
}

/// A rename running now is refused with Electron's words (`errors:tag.renameInProgress`), one
/// recorded with notes left with what finishes it (`errors:tag.renameUnfinished`), a merge into
/// another spelling of its tag with `errors:tag.mergeSameTag`; any other failure carries the
/// cause, as Electron's handler answers it.
pub(super) fn rename_failed<R: Runtime>(app: &AppHandle<R>, error: &NotesError) -> CommandError {
    let core = CommandError::from_core(error);
    let (key, from, to, left) = match error {
        NotesError::TagRenameInProgress { from, to } => {
            ("errors:tag.renameInProgress", from, to, 0)
        }
        NotesError::TagRenameUnfinished { from, to, left } => {
            ("errors:tag.renameUnfinished", from, to, *left)
        }
        NotesError::TagMergeSameTag => {
            let locale = app.state::<Arc<LocaleService>>().get();
            let message = i18n::t(locale, "errors:tag.mergeSameTag", &Args::new());
            return CommandError::new(core.kind, core.code, message);
        }
        _ => return core,
    };
    let locale = app.state::<Arc<LocaleService>>().get();
    let args = Args::from([
        ("from".to_owned(), Arg::from(from.as_str())),
        ("to".to_owned(), Arg::from(to.as_str())),
        (
            "count".to_owned(),
            Arg::from(i64::try_from(left).unwrap_or(i64::MAX)),
        ),
    ]);
    CommandError::new(core.kind, core.code, i18n::t(locale, key, &args))
}
