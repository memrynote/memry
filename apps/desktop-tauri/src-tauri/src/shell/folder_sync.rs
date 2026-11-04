//! A pulled folder mirrored into the vault (#3906), for the sync engine (Step 17, #3534) to call
//! once the record committed, as `folder-config-handler.ts` and `deleted-folder-prune.ts` do.
//! The folder the record names and each folder removed go out as [`FolderConfigUpdatedEvent`],
//! on which the renderer refetches the tree. The file work is best effort: a failure is logged
//! with its code and never fails the pull, and the event goes out all the same because the
//! record changed.

use tauri::{AppHandle, Runtime};

use crate::commands::blocking;
use crate::commands::error::CommandError;
use crate::commands::notes::{open_vault, service};
use crate::events::{FolderConfigUpdatedEvent, broadcast};

/// A pulled `folder_config` upsert: `icon` into the folder's `.folder.md`, the folder made when
/// it is not here.
pub async fn remote_folder_applied<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    icon: Option<String>,
) {
    let (handle, folder) = (app.clone(), path.clone());
    let _ = blocking("remote_folder_applied", move || {
        service(&handle)?
            .apply_remote_folder(&open_vault(&handle)?, &folder, icon.as_deref())
            .map_err(|error| CommandError::from_core(&error))
    })
    .await;
    broadcast(&app, FolderConfigUpdatedEvent { path });
}

/// A pulled `folder_config` delete: the folder loses its icon and goes once it holds nothing
/// worth keeping, then each deleted folder above it.
pub async fn remote_folder_deleted<R: Runtime>(app: AppHandle<R>, path: String) {
    let (handle, folder) = (app.clone(), path.clone());
    let removed = blocking("remote_folder_deleted", move || {
        service(&handle)?
            .apply_remote_folder_delete(&open_vault(&handle)?, &folder)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
    .unwrap_or_default();
    broadcast(&app, FolderConfigUpdatedEvent { path: path.clone() });
    announce(&app, removed.into_iter().filter(|folder| *folder != path));
}

/// A pulled note delete left `path`, the note's folder: each deleted folder from there up that
/// holds nothing worth keeping goes.
pub async fn prune_deleted_folders<R: Runtime>(app: AppHandle<R>, path: String) {
    let handle = app.clone();
    let removed = blocking("prune_deleted_folders", move || {
        service(&handle)?
            .prune_deleted_folders(&open_vault(&handle)?, &path, false)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
    .unwrap_or_default();
    announce(&app, removed);
}

fn announce<R: Runtime>(app: &AppHandle<R>, folders: impl IntoIterator<Item = String>) {
    for path in folders {
        broadcast(app, FolderConfigUpdatedEvent { path });
    }
}
