//! Tags with fields (`tags:get-schema-snapshot`, `tags:edit-schema` and `tags:preview-impact` of
//! `ipc/tag-schema-handlers.ts`), each one call of `memry_desktop::tags::schema`. A schema edit
//! writes the `tag_definition` record, and for a new field or a ready-made tag the property
//! definitions and a template; never a note file. After an edit it sends what Electron sends:
//! [`PropertyDefinitionChangedEvent`] per definition it created, [`TemplateCreatedEvent`] per
//! template, then [`NoteTagsChangedEvent`] when a schema may have changed. The object search
//! (`ipc/tag-object-handlers.ts`) reads the same resolved tags and writes nothing.

use std::sync::Arc;

use memry_desktop::locale::LocaleService;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::tags::schema::impact::{ImpactQuery, ImpactView};
use memry_desktop::tags::schema::objects::{SearchObjectsInput, SearchObjectsView};
use memry_desktop::tags::schema::view::{
    TagSchemaCommand, TagSchemaCommandResultView, TagSchemaSnapshotView,
};
use memry_desktop::tags::schema::{Ran, Schemas};
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::CommandError;
use super::tags::open_vault;
use crate::events::{
    NoteTagsChangedEvent, PropertyDefinitionChangedEvent, TemplateCreatedEvent, broadcast,
};

/// The open vault's schemas, in the UI language, written under this device's identity.
fn schemas<R: Runtime>(app: &AppHandle<R>) -> Result<Schemas, CommandError> {
    let open = open_vault(app)?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    let locale = app.state::<Arc<LocaleService>>().get();
    Schemas::open(&open, store, locale).map_err(|error| CommandError::from_core(&error))
}

/// The events of an edit that landed. Public for `tests/tag_schema.rs`: a lib unit test that
/// links the Tauri runtime cannot load on Windows (see `build.rs`).
pub fn announce<R: Runtime>(app: &AppHandle<R>, ran: &Ran) {
    for name in &ran.effects.definitions {
        broadcast(app, PropertyDefinitionChangedEvent { name: name.clone() });
    }
    for id in &ran.effects.templates {
        broadcast(app, TemplateCreatedEvent { id: id.clone() });
    }
    if ran.tags_changed {
        broadcast(app, NoteTagsChangedEvent);
    }
}

/// Every tag's resolved schema, the notes that are objects, and the ready-made tags.
#[tauri::command]
#[specta::specta]
pub async fn tags_get_schema_snapshot(
    app: AppHandle<Wry>,
) -> Result<TagSchemaSnapshotView, CommandError> {
    blocking("tags_get_schema_snapshot", move || {
        schemas(&app)?
            .snapshot()
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// One schema command, answered with the snapshot after it.
#[tauri::command]
#[specta::specta]
pub async fn tags_edit_schema(
    app: AppHandle<Wry>,
    command: TagSchemaCommand,
) -> Result<TagSchemaCommandResultView, CommandError> {
    blocking("tags_edit_schema", move || {
        let ran = schemas(&app)?
            .run(command)
            .map_err(|error| CommandError::from_core(&error))?;
        announce(&app, &ran);
        Ok(ran.result)
    })
    .await
}

/// What a schema change would reach, counted for its dialog. It writes no record.
#[tauri::command]
#[specta::specta]
pub async fn tags_preview_impact(
    app: AppHandle<Wry>,
    query: ImpactQuery,
) -> Result<ImpactView, CommandError> {
    blocking("tags_preview_impact", move || {
        schemas(&app)?
            .preview_impact(query)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// The objects whose title matches the query, of one tag and the tags extending it or of every
/// tag with fields.
#[tauri::command]
#[specta::specta]
pub async fn tags_search_objects(
    app: AppHandle<Wry>,
    input: SearchObjectsInput,
) -> Result<SearchObjectsView, CommandError> {
    blocking("tags_search_objects", move || {
        schemas(&app)?
            .search_objects(&input)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}
