//! The account's side of sync: the session's auth signals reach the renderer as events, and the
//! open vault's supervisor runs while the account is signed in. Built once, after the vault boot
//! (the `Session` exists from `VaultOpen`).

use memry_desktop::session::at_rest_key::AtRestKeys;
use std::sync::Arc;

use memry_desktop::account::AccountService;
use memry_desktop::account::binding::BindingState;
use memry_desktop::account::session_events::{self, AccountEvent};
use memry_desktop::account::vault_sync::{OpenVaultBinding, SyncWiring};
use memry_desktop::seams::reachability::DesktopReachability;
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore};
use memry_desktop::session::Session;
use memry_desktop::shell::power::PowerEvent;
use memry_desktop::sync::signals::SessionEndReason;
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use crate::commands::error::CommandError;
use crate::events::{
    AuthSessionExpiredEvent, SessionExpiredReason, SyncDeviceRemovedEvent,
    SyncLinkingApprovedEvent, SyncLinkingRequestedEvent, SyncStatusChangedEvent,
    SyncVaultBindingChangedEvent, VaultListChangedEvent, broadcast,
};
use crate::power::PowerMonitor;
use crate::shell::services;
use crate::startup::{self, Stage};

pub fn register_stages() {
    startup::register(Stage::Schedulers, "start account sync", start);
}

fn start(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let runtime = tauri::async_runtime::handle().inner().clone();
    let account = app.state::<Arc<AccountService>>().inner().clone();
    let session = app.state::<Session>().inner().clone();

    // Subscribed before the first `attach_sync`, so the first supervisor's signals are heard.
    let emitter = app.clone();
    session_events::listen(
        &runtime,
        account.clone(),
        session.clone(),
        session.subscribe_auth_signals(),
        move |event| emit(&emitter, event),
    );

    let reachability = Arc::new(DesktopReachability::start(&runtime));
    // The e2e network switch (`e2e_set_network_online`) reaches it here.
    app.manage(reachability.clone());
    let power = app.state::<PowerMonitor>().sender();
    forward_power(&runtime, power.subscribe(), reachability.clone());
    let keychain_recovered = broadcast::Sender::new(4);
    let recovered = keychain_recovered.clone();
    app.state::<Arc<KeyringStore>>()
        .subscribe_recovered(move || {
            let _ = recovered.send(());
        });

    // One owner of the open vault's at-rest key, shared by sync and the agent (#3545 D3). Its
    // close hook is registered before sync's and the agent's, so it runs after both let go.
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    let at_rest_keys = AtRestKeys::new(store.clone());
    let closing = Arc::clone(&at_rest_keys);
    session.on_close(
        "at-rest-key",
        Arc::new(move |open| closing.close(&open.vault)),
    );
    app.manage(Arc::clone(&at_rest_keys));

    let bindings = Arc::new(OpenVaultBinding::default());
    let binding_app = app.clone();
    let status_app = app.clone();
    let list_app = app.clone();
    let wiring = Arc::new(SyncWiring {
        runtime,
        account,
        registry: session.registry().clone(),
        store,
        reachability,
        power: Some(power),
        keychain_recovered,
        at_rest_keys,
        telemetry: services::telemetry(app),
        on_status: Arc::new(move |status| {
            broadcast(&status_app, SyncStatusChangedEvent(status.clone()));
        }),
        bindings: bindings.clone(),
        on_binding: Arc::new(move |state: &BindingState| {
            broadcast(&binding_app, SyncVaultBindingChangedEvent(state.into()));
        }),
        on_vault_list_changed: Arc::new(move || broadcast(&list_app, VaultListChangedEvent)),
    });
    app.manage(bindings);
    app.manage(wiring);
    attach_if_signed_in(app.clone());
    Ok(())
}

/// Runs the open vault's supervisor when the account is signed in: at launch, and after each
/// sign-in that ends with the master key in the keychain. A supervisor already running is
/// rebuilt, so it reads the new account. Off the async workers: the attach waits on the session
/// lifecycle and a running supervisor's stop.
pub fn attach_if_signed_in(app: AppHandle<Wry>) {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(wiring) = app.try_state::<Arc<SyncWiring>>() else {
            return;
        };
        if !wiring.account.info().signed_in {
            return;
        }
        app.state::<Session>()
            .attach_sync(Arc::clone(wiring.inner()).factory());
    });
}

/// After a sign-in registered this device: an empty open vault joins the account's vault
/// (`adoptAccountVaultIfAbsent`, before its first push), then sync attaches.
pub fn after_sign_in(app: AppHandle<Wry>) {
    tauri::async_runtime::spawn(async move {
        if let Some(open) = app.state::<Session>().current() {
            let account = app.state::<Arc<AccountService>>().inner().clone();
            if let Err(error) = account.adopt_account_vault_if_absent(&open).await {
                tracing::warn!(scope = "Binding", "account vault adoption failed: {error}");
            }
        }
        attach_if_signed_in(app);
    });
}

fn emit(app: &AppHandle<Wry>, event: AccountEvent) {
    match event {
        AccountEvent::SessionExpired { reason } => broadcast(
            app,
            AuthSessionExpiredEvent {
                reason: match reason {
                    SessionEndReason::RefreshRejected => SessionExpiredReason::RefreshRejected,
                },
            },
        ),
        AccountEvent::DeviceRevoked { unsynced_count } => broadcast(
            app,
            SyncDeviceRemovedEvent {
                unsynced_count: u32::try_from(unsynced_count).unwrap_or(u32::MAX),
            },
        ),
        AccountEvent::LinkingRequest {
            session_id,
            new_device_name,
            new_device_platform,
        } => broadcast(
            app,
            SyncLinkingRequestedEvent {
                session_id,
                new_device_name,
                new_device_platform,
            },
        ),
        AccountEvent::LinkingApproved { session_id } => {
            broadcast(app, SyncLinkingApprovedEvent { session_id });
        }
    }
}

/// Sleep takes the network offline at once and wake reads it again (`network.ts`).
fn forward_power(
    runtime: &tokio::runtime::Handle,
    mut events: broadcast::Receiver<PowerEvent>,
    reachability: Arc<DesktopReachability>,
) {
    runtime.spawn(async move {
        loop {
            match events.recv().await {
                Ok(PowerEvent::Suspend) => reachability.on_power_suspend(),
                Ok(PowerEvent::Resume) => reachability.on_power_resume(),
                Ok(PowerEvent::SessionEnding) | Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return,
            }
        }
    });
}
