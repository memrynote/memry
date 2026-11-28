//! `DesktopToolHost`: the vault tools behind the agent's [`ToolRegistry`], the Rust twin of
//! Electron's `tools/read-tools.ts` over `tools/handles-adapter.ts` (Step 28c4, #3545). The
//! registry has already validated the arguments and, for a write tool, passed the write gate.
//!
//! The host belongs to one vault: every call reads the session's open vault and refuses when it
//! is not the vault the agent was built for, so a tool never reads another vault's data after a
//! switch. Tools not ported yet answer `INTERNAL` with "not available in this build yet".
//!
//! [`ToolRegistry`]: crate::agent::mcp::ToolRegistry

mod read_help;
mod read_tasks;

use std::fmt::Display;
use std::sync::Arc;

use async_trait::async_trait;
use memry_core::seams::secure_store::SecureStore;
use serde_json::Value;

use crate::agent::mcp::{CallContext, ToolError, ToolErrorCode, ToolReply, VaultToolHost};
use crate::session::{OpenVault, Session};

/// The refusal of a call that reaches the host after its vault closed.
pub const VAULT_CLOSED: &str = "The vault this agent was opened for is no longer open.";

pub struct DesktopToolHost {
    session: Session,
    vault_id: String,
    identity: Arc<dyn SecureStore>,
}

impl DesktopToolHost {
    /// The tools of the vault `vault_id`; `identity` signs the reads that open a synced store.
    pub fn new(session: Session, vault_id: String, identity: Arc<dyn SecureStore>) -> Self {
        Self {
            session,
            vault_id,
            identity,
        }
    }

    fn open_vault(&self) -> Result<OpenVault, ToolError> {
        self.session
            .current()
            .filter(|open| open.vault_id == self.vault_id)
            .ok_or_else(|| ToolError::new(ToolErrorCode::PermissionDenied, VAULT_CLOSED))
    }
}

#[async_trait]
impl VaultToolHost for DesktopToolHost {
    async fn call(&self, tool: &str, args: Value, _: &CallContext) -> Result<ToolReply, ToolError> {
        match tool {
            "memry_help_search" => Ok(ToolReply::new(read_help::search(&args))),
            "memry_help_read" => read_help::read(&args).map(ToolReply::new),
            _ if read_tasks::TOOLS.contains(&tool) => {
                let open = self.open_vault()?;
                let identity = Arc::clone(&self.identity);
                let tool = tool.to_owned();
                tokio::task::spawn_blocking(move || read_tasks::call(&tool, &args, &open, identity))
                    .await
                    .map_err(internal)?
                    .map(ToolReply::new)
            }
            _ => Err(ToolError::new(
                ToolErrorCode::Internal,
                format!("{tool} is not available in this build yet."),
            )),
        }
    }
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn internal(error: impl Display) -> ToolError {
    ToolError::new(ToolErrorCode::Internal, error.to_string())
}
