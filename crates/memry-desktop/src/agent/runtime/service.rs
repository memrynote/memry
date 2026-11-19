//! The agent of the open vault and its place in the vault lifecycle. Each open builds one
//! [`VaultAgent`] (its tool registry with the write gate installed, its turns); close, switch and
//! quit shut it down, so no grant, card or backend outlives its vault. The port of Electron's
//! `startVaultAgentServices` / `stopVaultAgentServices` around `AgentRuntime.install` and
//! `killAll` (`runtime.ts:327-345`).

use std::sync::{Arc, Mutex, MutexGuard, Weak};

use async_trait::async_trait;
use serde_json::Value;

use super::turns::{KillBackend, TrackedBackend, Turn, TurnError, Turns};
use super::write_gate::{AgentWriteGate, GateHost};
use crate::agent::mcp::{
    CallContext, ToolError, ToolErrorCode, ToolRegistry, ToolReply, VaultToolHost,
};
use crate::session::{OpenStage, OpenVault, Session};
use crate::shell::shutdown::StepFn;

pub struct VaultAgent {
    vault_id: String,
    registry: Arc<ToolRegistry>,
    gate: Arc<AgentWriteGate>,
    turns: Arc<Turns>,
}

impl VaultAgent {
    /// Installs a gate over `host` in `registry`: from here on every write tool asks it.
    pub fn new(vault_id: String, registry: Arc<ToolRegistry>, host: Arc<dyn GateHost>) -> Self {
        let gate = Arc::new(AgentWriteGate::new(host));
        registry.set_write_gate(Some(gate.clone()));
        Self {
            vault_id,
            registry,
            turns: Turns::new(Arc::clone(&gate)),
            gate,
        }
    }

    pub fn vault_id(&self) -> &str {
        &self.vault_id
    }

    pub fn registry(&self) -> &Arc<ToolRegistry> {
        &self.registry
    }

    /// Answers and reads the approval cards (`agent_approve_tool`, `agent_get_tool_call`).
    pub fn gate(&self) -> &Arc<AgentWriteGate> {
        &self.gate
    }

    pub fn begin_turn(&self, conversation_id: &str) -> Result<Turn, TurnError> {
        self.turns.begin(conversation_id)
    }

    pub fn track_backend(&self, conversation_id: &str, kill: KillBackend) -> TrackedBackend {
        self.turns.track_backend(conversation_id, kill)
    }

    pub fn cancel_turn(&self, conversation_id: &str) {
        self.turns.cancel(conversation_id);
    }

    /// Kills every backend, revokes every grant, denies every card and takes the gate out of
    /// the registry. Idempotent.
    pub fn shutdown(&self) {
        self.turns.shutdown();
        self.registry.set_write_gate(None);
    }
}

/// The registry's host until the vault tools land with `DesktopToolHost` (Step 28c4). Nothing
/// calls the registry before then: no MCP server or turn runs yet.
pub struct ToolsNotPorted;

#[async_trait]
impl VaultToolHost for ToolsNotPorted {
    async fn call(&self, tool: &str, _: Value, _: &CallContext) -> Result<ToolReply, ToolError> {
        Err(ToolError::new(
            ToolErrorCode::Internal,
            format!("{tool} is not available in this build yet."),
        ))
    }
}

/// Builds the agent of a vault that just opened; `None` leaves the vault without one.
pub type AgentFactory = Arc<dyn Fn(&OpenVault) -> Option<VaultAgent> + Send + Sync>;

pub struct AgentService {
    factory: AgentFactory,
    current: Mutex<Option<Arc<VaultAgent>>>,
}

impl AgentService {
    pub fn new(factory: AgentFactory) -> Arc<Self> {
        Arc::new(Self {
            factory,
            current: Mutex::new(None),
        })
    }

    fn current_slot(&self) -> MutexGuard<'_, Option<Arc<VaultAgent>>> {
        self.current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Builds an agent for every vault `session` opens, the one open now included, and shuts it
    /// down on every close (a switch closes first). Register it after the at-rest key's close
    /// hook, so the agent lets go of the vault key before the key is cleared.
    pub fn attach(self: &Arc<Self>, session: &Session) {
        let opening = Arc::downgrade(self);
        let closing = Arc::downgrade(self);
        session.attach_lifecycle(
            "agent",
            OpenStage::SyncStart,
            Arc::new(move |open| {
                if let Some(service) = Weak::upgrade(&opening) {
                    service.start(open);
                }
                Ok(())
            }),
            Arc::new(move |_| {
                if let Some(service) = Weak::upgrade(&closing) {
                    service.stop();
                }
            }),
        );
    }

    pub fn current(&self) -> Option<Arc<VaultAgent>> {
        self.current_slot().clone()
    }

    /// Shuts the open vault's agent down (vault close, and `stop-chat-server` at quit).
    pub fn stop(&self) {
        let agent = self.current_slot().take();
        if let Some(agent) = agent {
            agent.shutdown();
        }
    }

    fn start(&self, open: &OpenVault) {
        let agent = (self.factory)(open).map(Arc::new);
        let previous = std::mem::replace(&mut *self.current_slot(), agent);
        if let Some(previous) = previous {
            previous.shutdown();
        }
    }
}

/// The `stop-chat-server` shutdown step: the agent stops before the vault closes, so a card on
/// screen at quit settles at once instead of holding the close.
pub fn stop_chat_server(service: Arc<AgentService>) -> StepFn {
    Arc::new(move |_, _| {
        let service = Arc::clone(&service);
        Box::pin(async move {
            service.stop();
            Ok(())
        })
    })
}
