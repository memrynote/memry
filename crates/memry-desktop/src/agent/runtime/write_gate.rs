//! The [`WriteGate`] the MCP registry consults for every write tool: the gate closure of
//! Electron's `AgentRuntime.install` (`runtime/runtime.ts:136-224`), with its turn grants,
//! approval map, cancel and shutdown. One instance per open vault.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use memry_core::crypto::sodium::random_bytes;

use super::approvals::{
    AlwaysAllowScope, Approvals, ApproveToolDecision, Outcome, PendingApproval,
};
use super::gate::{
    Gate, GateInput, PreviewKind, ToolApprovalMode, decide_tool_gate, is_in_page_review_tool,
    review_target_for_tool,
};
use super::grants::{TurnGrant, TurnGrants};
use crate::agent::mcp::{GateDecision, GateRequest, WriteGate};

pub const NO_TURN: &str =
    "Vault writes are only available to a tool call inside a running memrynote Agent turn.";
pub const UNKNOWN_CONVERSATION: &str = "Unknown conversation";
pub const DENIED: &str = "User denied request.";
pub const CANCELLED: &str = "Turn cancelled before approval.";

/// What the gate reads and writes outside itself: the conversation store, the app config's
/// standing approvals and preferences, and the agent event stream. The runtime implements it.
pub trait GateHost: Send + Sync {
    /// The trust list of a live conversation; `None` when it does not exist or sync deleted it.
    fn conversation_trust_list(&self, conversation_id: &str) -> Option<Vec<String>>;
    fn add_to_trust_list(&self, conversation_id: &str, tool: &str) -> Result<(), String>;
    /// `agent.alwaysAllowedTools[vaultUuid]` of the app config.
    fn vault_trust_list(&self) -> Vec<String>;
    fn grant_vault_tool(&self, tool: &str) -> Result<(), String>;
    fn approval_mode(&self) -> ToolApprovalMode;
    /// Puts the approval card on screen (`tool_call_pending_approval`).
    fn approval_requested(&self, approval: &PendingApproval);
    /// Clears a card nobody decided (`tool_call_failed` with `{code, message}`).
    fn approval_failed(&self, approval: &PendingApproval, code: &str, message: &str);
}

pub struct AgentWriteGate {
    grants: Arc<TurnGrants>,
    approvals: Approvals,
    host: Arc<dyn GateHost>,
    closed: AtomicBool,
}

impl AgentWriteGate {
    pub fn new(host: Arc<dyn GateHost>) -> Self {
        Self {
            grants: Arc::default(),
            approvals: Approvals::default(),
            host,
            closed: AtomicBool::new(false),
        }
    }

    /// The write capability of a turn that is starting; it dies when the returned grant drops.
    pub fn mint_turn_write_grant(&self, conversation_id: &str) -> TurnGrant {
        self.grants.mint(conversation_id)
    }

    /// The turn lock was released: its capability ends and its open approvals are denied.
    pub fn end_turn(&self, conversation_id: &str) {
        self.grants.revoke_for(conversation_id);
        self.cancel_turn(conversation_id);
    }

    /// Stop was pressed: every approval the turn left on screen settles as a denial.
    pub fn cancel_turn(&self, conversation_id: &str) {
        let denied = Outcome::Decided(ApproveToolDecision::Deny);
        for approval in self.approvals.settle_where(
            |approval| approval.conversation_id == conversation_id,
            &denied,
        ) {
            self.host
                .approval_failed(&approval, "PERMISSION_DENIED", CANCELLED);
        }
    }

    /// The user's answer. `false` for an approval that is no longer pending.
    pub fn resolve_approval(&self, tool_call_id: &str, decision: ApproveToolDecision) -> bool {
        let settled = self
            .approvals
            .settle(tool_call_id, Outcome::Decided(decision))
            .is_some();
        if !settled {
            tracing::warn!(scope = "AgentRuntime", "stale approval for {tool_call_id}");
        }
        settled
    }

    /// The pending write as the approval card shows it, arguments included.
    pub fn pending_approval(&self, tool_call_id: &str) -> Option<PendingApproval> {
        self.approvals.get(tool_call_id)
    }

    /// Vault close, switch or quit: no grant survives and every open approval is denied.
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.grants.revoke_all();
        let denied = Outcome::Decided(ApproveToolDecision::Deny);
        self.approvals.settle_where(|_| true, &denied);
    }

    /// The conversation whose running turn presented `grant`, or `None`.
    fn turn_of(&self, grant: &str) -> Option<String> {
        if self.closed.load(Ordering::SeqCst) {
            return None;
        }
        self.grants.resolve(grant)
    }

    fn record_standing_approval(
        &self,
        conversation_id: &str,
        tool: &str,
        preview_kind: PreviewKind,
        scope: AlwaysAllowScope,
    ) -> Result<(), String> {
        // The gate ignores a standing approval for a loss and an in-page review, so none is
        // recorded. For `vault_desktop_write` one would also trust the tool's other operations.
        if preview_kind == PreviewKind::Loss || is_in_page_review_tool(tool) {
            return Ok(());
        }
        match scope {
            AlwaysAllowScope::Conversation => self.host.add_to_trust_list(conversation_id, tool),
            AlwaysAllowScope::Vault => self.host.grant_vault_tool(tool),
        }
    }
}

fn denied(reason: &str) -> GateDecision {
    GateDecision::Denied {
        reason: Some(reason.to_owned()),
    }
}

fn tool_call_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    format!("gate-{now}-{}", hex::encode(random_bytes(6)))
}

#[async_trait]
impl WriteGate for AgentWriteGate {
    async fn decide(&self, request: GateRequest<'_>) -> GateDecision {
        // The only thing that authorises a write: a conversation id, a stale grant or another
        // vault's grant all land here.
        let Some(conversation_id) = self.turn_of(request.write_grant) else {
            return denied(NO_TURN);
        };
        let Some(trust_list) = self.host.conversation_trust_list(&conversation_id) else {
            return denied(UNKNOWN_CONVERSATION);
        };
        let gate = decide_tool_gate(&GateInput {
            tool: request.tool,
            args: request.args,
            trust_list: &trust_list,
            vault_trust_list: &self.host.vault_trust_list(),
            mode: self.host.approval_mode(),
        });
        let (requires_diff, preview_kind) = match gate {
            Gate::AutoApprove => return GateDecision::Approved { args: None },
            Gate::AwaitUser {
                requires_diff,
                preview_kind,
            } => (requires_diff, preview_kind),
        };
        let approval = PendingApproval {
            conversation_id: conversation_id.clone(),
            tool_call_id: tool_call_id(),
            name: request.tool.to_owned(),
            args: request.args.clone(),
            requires_diff,
            preview_kind,
            review_target: review_target_for_tool(request.tool, request.args),
        };
        let decision = match self.approvals.wait(approval, &*self.host).await {
            Outcome::Expired => return denied(super::approvals::APPROVAL_EXPIRED_MESSAGE),
            Outcome::Decided(ApproveToolDecision::Deny) => return denied(DENIED),
            Outcome::Decided(decision) => decision,
        };
        // An approval outlives nothing: a turn that ended while the card was open writes nothing.
        if self.turn_of(request.write_grant).as_deref() != Some(conversation_id.as_str()) {
            return denied(NO_TURN);
        }
        if let ApproveToolDecision::AllowAlways { scope } = decision
            && let Err(error) =
                self.record_standing_approval(&conversation_id, request.tool, preview_kind, scope)
        {
            tracing::error!(
                scope = "AgentRuntime",
                tool = request.tool,
                "could not record the standing approval: {error}"
            );
            return denied(&format!("Could not record the standing approval: {error}"));
        }
        let args = match decision {
            ApproveToolDecision::EditAllow { edited_args } => {
                edited_args.filter(|args| !args.is_null())
            }
            _ => None,
        };
        GateDecision::Approved { args }
    }
}
