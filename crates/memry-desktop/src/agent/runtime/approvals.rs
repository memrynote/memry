//! Approvals waiting on the user, the approval map of Electron's `runtime/runtime.ts`
//! (`waitForApproval`, `settleApproval`, `expireApproval`). Each entry is a `oneshot` sender keyed
//! by tool call id; the single exit is [`Approvals::settle`], which drops the entry and resolves.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use super::gate::{PreviewKind, ReviewTarget};
use super::write_gate::GateHost;

/// How long an approval may sit unanswered. Half an hour, as in Electron: an expiry tells the
/// model the call did not go through, so it must not fire under a reader's hands.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Shown to the user and handed to the model. It says "expired", never "denied".
pub const APPROVAL_EXPIRED_MESSAGE: &str = "Approval request expired after 30 minutes with no \
                                            answer. This was not a denial — the tool did not run; \
                                            ask again if it is still needed.";
pub const APPROVAL_EXPIRED_CODE: &str = "APPROVAL_EXPIRED";

/// How far a standing "always allow" reaches (`AlwaysAllowScopeSchema`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlwaysAllowScope {
    #[default]
    Conversation,
    Vault,
}

/// `ApproveToolDecisionSchema` (`ipc-agent.ts:570`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ApproveToolDecision {
    Allow,
    AllowAlways {
        #[serde(default)]
        scope: AlwaysAllowScope,
    },
    /// Absent or null `editedArgs` keep the parsed arguments, as `decision.args ?? parsedArgs`.
    EditAllow {
        #[serde(rename = "editedArgs", default)]
        edited_args: Option<Value>,
    },
    Deny,
}

/// A write on screen: what the approval card shows and what `agent_get_tool_call` serves.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub conversation_id: String,
    pub tool_call_id: String,
    pub name: String,
    /// The parsed arguments the write runs with when approved, kept whole: the preview is built
    /// from them. The deadline bounds how long they are held.
    pub args: Value,
    pub requires_diff: bool,
    pub preview_kind: PreviewKind,
    pub review_target: Option<ReviewTarget>,
}

/// What a pending approval settles as. `Expired` is never a user decision.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Outcome {
    Decided(ApproveToolDecision),
    Expired,
}

struct Entry {
    approval: PendingApproval,
    settle: oneshot::Sender<Outcome>,
}

#[derive(Default)]
pub(super) struct Approvals {
    pending: Mutex<HashMap<String, Entry>>,
}

impl Approvals {
    fn pending(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Shows `approval` and waits for its outcome. A request dropped while waiting (its HTTP
    /// call ended, the server stopped) takes its entry and its card with it.
    pub(super) async fn wait(&self, approval: PendingApproval, host: &dyn GateHost) -> Outcome {
        let id = approval.tool_call_id.clone();
        let (settle, mut outcome) = oneshot::channel();
        self.pending().insert(
            id.clone(),
            Entry {
                approval: approval.clone(),
                settle,
            },
        );
        let _abandoned = Abandoned {
            approvals: self,
            id: &id,
            host,
        };
        host.approval_requested(&approval);
        if let Ok(settled) = tokio::time::timeout(APPROVAL_TIMEOUT, &mut outcome).await {
            return settled.unwrap_or(Outcome::Decided(ApproveToolDecision::Deny));
        }
        let expired = self.pending().remove(&id);
        match expired {
            Some(entry) => {
                tracing::warn!(
                    scope = "AgentRuntime",
                    "approval {id} expired with no decision"
                );
                host.approval_failed(
                    &entry.approval,
                    APPROVAL_EXPIRED_CODE,
                    APPROVAL_EXPIRED_MESSAGE,
                );
                Outcome::Expired
            }
            // Settled at the deadline: the decision is already in the channel.
            None => outcome
                .await
                .unwrap_or(Outcome::Decided(ApproveToolDecision::Deny)),
        }
    }

    pub(super) fn settle(&self, tool_call_id: &str, outcome: Outcome) -> Option<PendingApproval> {
        let entry = self.pending().remove(tool_call_id)?;
        // The waiter may be gone already; the entry is dropped either way.
        let _ = entry.settle.send(outcome);
        Some(entry.approval)
    }

    pub(super) fn get(&self, tool_call_id: &str) -> Option<PendingApproval> {
        self.pending()
            .get(tool_call_id)
            .map(|entry| entry.approval.clone())
    }

    /// Settles every approval `matches` selects and returns them.
    pub(super) fn settle_where(
        &self,
        matches: impl Fn(&PendingApproval) -> bool,
        outcome: &Outcome,
    ) -> Vec<PendingApproval> {
        let ids: Vec<String> = self
            .pending()
            .iter()
            .filter(|(_, entry)| matches(&entry.approval))
            .map(|(id, _)| id.clone())
            .collect();
        ids.iter()
            .filter_map(|id| self.settle(id, outcome.clone()))
            .collect()
    }
}

/// Clears a card whose request went away before an outcome.
struct Abandoned<'a> {
    approvals: &'a Approvals,
    id: &'a str,
    host: &'a dyn GateHost,
}

impl Drop for Abandoned<'_> {
    fn drop(&mut self) {
        let entry = self.approvals.pending().remove(self.id);
        if let Some(entry) = entry {
            self.host.approval_failed(
                &entry.approval,
                "PERMISSION_DENIED",
                super::write_gate::CANCELLED,
            );
        }
    }
}
