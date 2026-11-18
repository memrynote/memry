//! The agent runtime (Step 28, #3545), the port of Electron's `agent/runtime`. This stage holds
//! the write gate: turn grants, the gate order and the approval map.

mod approvals;
mod gate;
mod grants;
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
pub use write_gate::{AgentWriteGate, CANCELLED, DENIED, GateHost, NO_TURN, UNKNOWN_CONVERSATION};
