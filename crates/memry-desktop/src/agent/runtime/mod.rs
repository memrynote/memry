//! The agent runtime (Step 28, #3545), the port of Electron's `agent/runtime`: the write gate
//! (turn grants, the gate order, the approval map), the turn locks, the vault's standing
//! approvals and the per-vault agent the app builds on every vault open.

mod approvals;
mod gate;
mod grants;
mod host;
mod service;
mod trust;
mod turns;
mod write_gate;

pub use approvals::{
    APPROVAL_ABANDONED_CODE, APPROVAL_ABANDONED_MESSAGE, APPROVAL_EXPIRED_CODE,
    APPROVAL_EXPIRED_MESSAGE, APPROVAL_TIMEOUT, AlwaysAllowScope, ApproveToolDecision,
    PendingApproval,
};
pub use gate::{
    Gate, GateInput, IN_PAGE_REVIEW_TOOLS, PreviewKind, ReviewTarget, ToolApprovalMode,
    classified_desktop_writes, decide_tool_gate, is_in_page_review_tool, preview_kind_for_call,
    preview_kind_for_tool, previewed_tools, review_target_for_tool,
};
pub use grants::{TurnGrant, TurnGrants};
pub use host::{AgentEvent, AgentEventError, AgentEvents, HostParts, TrackEvent, VaultGateHost};
pub use service::{AgentFactory, AgentService, ToolsNotPorted, VaultAgent, stop_chat_server};
pub use trust::{edit_vault_trust_list, vault_trust_list};
pub use turns::{KillBackend, TrackedBackend, Turn, TurnError};
pub use write_gate::{
    AgentWriteGate, ApprovalLabel, CANCELLED, DENIED, GateHost, NO_TURN, UNKNOWN_CONVERSATION,
};
