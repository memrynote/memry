//! The Inbox job runner in the app (Step 27, #3544): built at the vault stage, run in the
//! background of every open vault, stopped by the `stop-schedulers` quit step, and its notices
//! sent to the renderer.

use std::sync::Arc;

use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::services::inbox_jobs::{InboxJobNotice, InboxJobs};
use memry_desktop::services::web_fetch::WebFetch;
use memry_desktop::session::Session;
use tauri::{AppHandle, Manager, Wry};

use crate::events::{
    InboxLinkPreview, InboxMetadataCompleteEvent, InboxProcessingErrorEvent, InboxUpdatedEvent,
    broadcast,
};
use crate::shutdown::ShutdownService;

/// Registers the runner on `session` before its first open, so the launch's vault resumes its
/// jobs.
pub fn register(app: &AppHandle<Wry>, session: &Session) {
    // Managed by the `Handlers` stage, which runs before this one.
    let Some(store) = app.try_state::<Arc<DeviceIdentityStore>>() else {
        tracing::error!(
            scope = "Inbox:Jobs",
            "no device identity store: links are not fetched"
        );
        return;
    };
    let web = match WebFetch::new() {
        Ok(web) => web,
        Err(error) => {
            tracing::error!(scope = "Inbox:Jobs", %error, "no web client: links are not fetched");
            return;
        }
    };
    let notifier = app.clone();
    let jobs = InboxJobs::new(
        web,
        tauri::async_runtime::handle().inner().clone(),
        store.inner().clone(),
        Box::new(move |notice| send(&notifier, notice)),
    );
    jobs.register(session);
    match app.try_state::<ShutdownService>() {
        Some(shutdown) => {
            let stopping = jobs.clone();
            let step = Arc::new(move |_, _| -> memry_desktop::shell::shutdown::StepFuture {
                stopping.stop();
                Box::pin(async { Ok(()) })
            });
            if let Err(error) = shutdown.register("stop-schedulers", step) {
                tracing::error!(scope = "Inbox:Jobs", %error, "a quit does not stop the runner");
            }
        }
        None => tracing::error!(
            scope = "Inbox:Jobs",
            "no shutdown service: a quit does not stop the runner"
        ),
    }
    app.manage(jobs);
}

fn send(app: &AppHandle<Wry>, notice: InboxJobNotice) {
    match notice {
        InboxJobNotice::Updated { item_id, changes } => broadcast(
            app,
            InboxUpdatedEvent {
                id: item_id,
                changes: changes.into(),
            },
        ),
        InboxJobNotice::MetadataComplete {
            item_id,
            title,
            description,
            image,
            thumbnail_path,
        } => broadcast(
            app,
            InboxMetadataCompleteEvent {
                id: item_id,
                metadata: InboxLinkPreview {
                    title,
                    description,
                    image,
                    thumbnail_path,
                },
            },
        ),
        InboxJobNotice::ProcessingError {
            item_id,
            operation,
            error,
        } => broadcast(
            app,
            InboxProcessingErrorEvent {
                id: item_id,
                operation: operation.to_owned(),
                error,
            },
        ),
    }
}
