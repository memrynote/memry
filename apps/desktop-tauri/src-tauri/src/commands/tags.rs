//! The tag list, a tag's notes and the tag hub's edits (`tags:*` of `ipc/tags-handlers.ts`),
//! each one call of `memry_desktop::tags`. None of them writes a note file. After a write they
//! send what Electron's handler sends: [`TagColorUpdatedEvent`] and [`NoteTagsChangedEvent`]
//! for a colour, [`NoteTagsChangedEvent`] for an icon, [`TagCategoriesChangedEvent`] for a
//! category or a drag.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::tags::view::{
    NotesByTagInput, NotesByTagView, ReorderInput, TagCategoryView, TagWithCountView,
};
use memry_desktop::tags::{self, Hub};
use memry_desktop::telemetry::Service;
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::events::{
    NoteTagsChangedEvent, TagCategoriesChangedEvent, TagColorUpdatedEvent, broadcast,
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
enum Written {
    Color {
        tag: String,
        color: String,
    },
    Icon,
    CategoryCreated(String),
    /// Renamed or deleted.
    Category(String),
    Drag,
}

/// What Electron's handler sends once the write landed: the events, and the telemetry of a
/// created category.
fn announce<R: Runtime>(app: &AppHandle<R>, written: Written) {
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use memry_desktop::seams::transport::NativeTransport;
    use memry_desktop::telemetry::service::{Context, Sender};
    use tauri::Listener;
    use tauri::test::mock_app;
    use tauri_specta::Event;

    use super::*;

    /// A telemetry service that queues and never sends.
    fn telemetry(dir: &std::path::Path) -> Arc<Service> {
        let context = Context {
            install_id: "i".into(),
            session_id: "s".into(),
            app_version: "1.0.0".into(),
            build_channel: "production".into(),
            platform: "linux".into(),
            arch: "x64".into(),
            locale: "en".into(),
            timezone_offset_minutes: 0,
        };
        let sender = Sender::new("http://127.0.0.1:1/x", NativeTransport::loopback());
        Arc::new(Service::start(dir, context, sender, true))
    }

    #[test]
    fn each_hub_write_sends_electrons_events_and_a_new_category_its_telemetry() {
        let dir = tempfile::tempdir().expect("tmp");
        let app = mock_app();
        let service = telemetry(dir.path());
        app.manage(service.clone());
        let heard = Arc::new(Mutex::new(Vec::<(&str, String)>::new()));
        for name in [
            TagColorUpdatedEvent::NAME,
            NoteTagsChangedEvent::NAME,
            TagCategoriesChangedEvent::NAME,
        ] {
            let sink = Arc::clone(&heard);
            app.listen_any(name, move |event| {
                sink.lock()
                    .expect("lock")
                    .push((name, event.payload().to_owned()));
            });
        }
        let sent = |written| {
            announce(app.handle(), written);
            std::mem::take(&mut *heard.lock().expect("lock"))
        };
        let color = |payload: &str| (TagColorUpdatedEvent::NAME, payload.to_owned());
        let tags = (NoteTagsChangedEvent::NAME, "null".to_owned());
        let categories = |payload: &str| (TagCategoriesChangedEvent::NAME, payload.to_owned());

        let written = Written::Color {
            tag: "Work".into(),
            color: "teal".into(),
        };
        assert_eq!(
            sent(written),
            [color(r#"{"tag":"Work","color":"teal"}"#), tags.clone()]
        );
        assert_eq!(sent(Written::Icon), [tags]);
        assert!(service.queued().is_empty());
        assert_eq!(
            sent(Written::CategoryCreated("cat-1".into())),
            [categories(r#"{"categoryId":"cat-1"}"#)]
        );
        let queued = service.queued();
        assert_eq!(queued.len(), 1, "{queued:?}");
        assert_eq!(queued[0].name, "tag_category_created");
        assert_eq!(queued[0].object_type.as_deref(), Some("tag_category"));
        assert_eq!(
            sent(Written::Category("cat-1".into())),
            [categories(r#"{"categoryId":"cat-1"}"#)]
        );
        assert_eq!(sent(Written::Drag), [categories(r#"{"categoryId":null}"#)]);
        assert_eq!(
            service.queued().len(),
            1,
            "only a created category is tracked"
        );
    }
}
