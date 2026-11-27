//! A vault's standing tool approvals, the port of Electron's `agent/settings.ts`
//! (`getAlwaysAllowedTools`, `grantAlwaysAllowedTool`, `revokeAlwaysAllowedTool`). They live in
//! the app config under `agent.alwaysAllowedTools[vaultUuid]`, never synced, and outlive the chat
//! that granted them, which is why Settings lists them and revokes them. The gate reads them at
//! every write call, so a revoke holds from the next call on.

use crate::registry::{AppConfig, ConfigError};

/// The tools carrying a standing approval in `vault_uuid`.
pub fn vault_trust_list(config: &AppConfig, vault_uuid: &str) -> Vec<String> {
    config
        .agent()
        .always_allowed_tools
        .remove(vault_uuid)
        .unwrap_or_default()
}

/// Grants `add`, then revokes `remove`, as the `agent:editTrustList` vault branch does
/// (`agent-handlers.ts:283-289`). Returns the list as written.
pub fn edit_vault_trust_list(
    config: &AppConfig,
    vault_uuid: &str,
    add: &[String],
    remove: &[String],
) -> Result<Vec<String>, ConfigError> {
    config.edit_always_allowed_tools(vault_uuid, |tools| {
        for tool in add {
            if !tools.contains(tool) {
                tools.push(tool.clone());
            }
        }
        tools.retain(|tool| !remove.contains(tool));
    })
}
