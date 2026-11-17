//! Sync test commands: the gate inputs Steps 19 and 20 will own, and the network switch, so a
//! spec or a live-app check can drive the status badge without an account server.

use std::sync::Arc;

use memry_desktop::account::vault_sync::OpenVaultBinding;
use memry_desktop::seams::reachability::DesktopReachability;
use memry_desktop::sync::gate::{Entitlement, VaultBinding};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};

fn invalid(code: &'static str, message: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Invalid, code, message.to_string())
}

/// Sets the running supervisor's binding (`bound`, `local-only`, `needs-decision`, `foreign`,
/// `unknown`) and entitlement (`entitled`, `unentitled`, `unknown`). Fails with no supervisor.
#[tauri::command]
pub fn e2e_set_gate_inputs(
    app: AppHandle<Wry>,
    binding: String,
    entitlement: String,
) -> Result<(), CommandError> {
    let binding = match binding.as_str() {
        "bound" => VaultBinding::Bound,
        "local-only" => VaultBinding::LocalOnly,
        "needs-decision" => VaultBinding::NeedsDecision,
        "foreign" => VaultBinding::Foreign,
        "unknown" => VaultBinding::Unknown,
        other => return Err(invalid("e2e_gate_binding", other)),
    };
    let entitlement = match entitlement.as_str() {
        "entitled" => Entitlement::Entitled,
        "unentitled" => Entitlement::Unentitled,
        "unknown" => Entitlement::Unknown,
        other => return Err(invalid("e2e_gate_entitlement", other)),
    };
    let set = app
        .try_state::<Arc<OpenVaultBinding>>()
        .is_some_and(|bindings| bindings.set_gate_inputs(binding, entitlement));
    if set {
        Ok(())
    } else {
        Err(invalid(
            "e2e_no_supervisor",
            "no sync supervisor is running",
        ))
    }
}

/// Takes the network offline, as sleep does, or reads it again, as wake does (`network.ts`'s
/// test switch). A later OS address event can change it again.
#[tauri::command]
pub fn e2e_set_network_online(app: AppHandle<Wry>, online: bool) -> Result<(), CommandError> {
    let reachability = app
        .try_state::<Arc<DesktopReachability>>()
        .ok_or_else(|| invalid("e2e_no_reachability", "sync is not wired yet"))?;
    if online {
        reachability.on_power_resume();
    } else {
        reachability.on_power_suspend();
    }
    Ok(())
}
