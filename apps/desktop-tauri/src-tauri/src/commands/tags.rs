//! The tag list, a tag's notes, the tag hub's edits and a tag's pins (`tags:*` of
//! `ipc/tags-handlers.ts`), each one call of `memry_desktop::tags`. None of them writes a note
//! file. After a write they send what Electron's handler sends: [`TagColorUpdatedEvent`] and
//! [`NoteTagsChangedEvent`] for a colour, [`NoteTagsChangedEvent`] for an icon,
//! [`TagCategoriesChangedEvent`] for a category or a drag, [`TagNotesChangedEvent`] for a pin.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::tags::view::{
    NotesByTagInput, NotesByTagView, ReorderInput, TagCategoryView, TagWithCountView,
};
use memry_desktop::tags::{self, Hub, TagsError};
use memry_desktop::telemetry::Service;
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::events::{
    NoteTagsChangedEvent, TagCategoriesChangedEvent, TagColorUpdatedEvent, TagNoteAction,
    TagNotesChangedEvent, broadcast,
};

/// The open vault, or the localized "no vault is open".
fn open_vault<R: Runtime>(app: &AppHandle<R>) -> Result<OpenVault, CommandError> {
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
        TagNoteAction::Unpinned => (false, "errors:tag.unpinNoteFailed"),
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
