//! The agent of the open vault (Step 28d, #3545): on every vault open the app builds its tool
//! registry with the write gate installed over the production gate host, and on every close,
//! switch and quit (`stop-chat-server`) shuts it down. Built after account sync, which owns the
//! at-rest key and its close hook: the agent's close hook then runs first and lets go of the key.

use std::sync::Arc;

use memry_desktop::account::vault_sync::SyncWiring;
use memry_desktop::agent::mcp::ToolRegistry;
use memry_desktop::agent::runtime::{
    AgentService, HostParts, ToolsNotPorted, VaultAgent, VaultGateHost,
};
use memry_desktop::agent::store::gate::EntitlementGate;
use memry_desktop::agent::store::{AgentStore, StoreParts};
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::at_rest_key::AtRestKeys;
use memry_desktop::session::{OpenVault, Session};
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::watch;

use crate::commands::error::CommandError;
use crate::events::{AgentEventEmittedEvent, broadcast};
use crate::shell::services;
use crate::startup::{self, Stage};

pub fn register_stages() {
    startup::register(Stage::Schedulers, "start the vault agent", start);
}

fn start(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let Some(wiring) = app.try_state::<Arc<SyncWiring>>() else {
        tracing::warn!(
            scope = "AgentRuntime",
            "no account wiring; the vault agent stays off"
        );
        return Ok(());
    };
    let runtime = tauri::async_runtime::handle().inner().clone();
    let keys = app.state::<Arc<AtRestKeys>>().inner().clone();
    let identity = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    let recovered = wiring.keychain_recovered.clone();
    let session = app.state::<Session>().inner().clone();
    let config = session.registry().config().clone();
    let events_app = app.clone();
    let telemetry = services::telemetry(app);
    let build = move |open: &OpenVault| -> Option<VaultAgent> {
        let device_id = match open.vault.notes_writer(identity.clone()) {
            Ok(writer) => writer.device_id(),
            Err(error) => {
                tracing::warn!(scope = "AgentRuntime", %error, "no device identity; no vault agent");
                return None;
            }
        };
        // Agent records stay local until the entitlement feed lands (Step 28g).
        let store = AgentStore::open(
            StoreParts {
                vault: open.vault.clone(),
                keys: keys.clone(),
                device_id,
                gate: EntitlementGate::new(watch::Sender::new(false).subscribe()),
                keychain_recovered: recovered.subscribe(),
            },
            &runtime,
        );
        let events_app = events_app.clone();
        let telemetry = telemetry.clone();
        let host = VaultGateHost::new(HostParts {
            vault_id: open.vault_id.clone(),
            config: config.clone(),
            store,
            events: Arc::new(move |event| {
                broadcast(&events_app, AgentEventEmittedEvent(event));
            }),
            track: Arc::new(move |event| {
                if let Some(telemetry) = &telemetry {
                    telemetry.track_main_event(event);
                }
            }),
        });
        let registry = Arc::new(ToolRegistry::new(Arc::new(ToolsNotPorted)));
        Some(VaultAgent::new(
            open.vault_id.clone(),
            registry,
            Arc::new(host),
        ))
    };
    let service = AgentService::new(Arc::new(build));
    app.manage(service.clone());
    // Off the boot thread: the attach waits behind a running open and reads the keychain.
    tauri::async_runtime::spawn_blocking(move || service.attach(&session));
    Ok(())
}
