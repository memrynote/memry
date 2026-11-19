//! The production [`GateHost`] of one open vault: the conversation trust list from the
//! [`AgentStore`], the standing approvals and the approval mode from the app config, the approval
//! cards as [`AgentEvent`]s, and the approval telemetry of Electron's `runtime/runtime.ts`
//! (`tool_approval_requested`, `tool_approval_decided`). Telemetry names the tool and the
//! decision only, never an argument.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::approvals::PendingApproval;
use super::gate::{PreviewKind, ReviewTarget, ToolApprovalMode};
use super::trust::{edit_vault_trust_list, vault_trust_list};
use super::write_gate::{ApprovalLabel, GateHost};
use crate::agent::store::{AgentStore, ConversationPatch};
use crate::registry::AppConfig;
use crate::telemetry::events::{TelemetryEvent, to_safe_token};
use crate::telemetry::service::Service;

/// `AgentEventSchema` (`ipc-agent.ts:700`), the variants the gate raises. The runtime stage adds
/// the rest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    #[serde(rename_all = "camelCase")]
    ToolCallPendingApproval {
        conversation_id: String,
        tool_call_id: String,
        name: String,
        args: Value,
        requires_diff: bool,
        preview_kind: PreviewKind,
        review_target: Option<ReviewTarget>,
    },
    #[serde(rename_all = "camelCase")]
    ToolCallFailed {
        conversation_id: String,
        tool_call_id: String,
        error: AgentEventError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AgentEventError {
    pub code: String,
    pub message: String,
}

/// Delivers an event to every window (`broadcastAgentEvent`).
pub type AgentEvents = Arc<dyn Fn(AgentEvent) + Send + Sync>;
/// Queues a main-process telemetry event (`trackMainEvent`).
pub type TrackEvent = Arc<dyn Fn(TelemetryEvent) + Send + Sync>;

pub struct HostParts {
    /// The vault uuid, the key of `agent.alwaysAllowedTools`.
    pub vault_id: String,
    pub config: Arc<AppConfig>,
    pub store: Arc<AgentStore>,
    pub events: AgentEvents,
    pub track: TrackEvent,
}

pub struct VaultGateHost(HostParts);

impl VaultGateHost {
    pub fn new(parts: HostParts) -> Self {
        Self(parts)
    }

    fn track(&self, action: &str, failed: bool, dimension: (&str, String)) {
        let mut event = Service::event("ai_action_completed", "ai", action);
        event.result = Some(if failed { "failed" } else { "success" }.to_owned());
        event.dimensions = Some(BTreeMap::from([(dimension.0.to_owned(), dimension.1)]));
        (self.0.track)(event);
    }
}

impl GateHost for VaultGateHost {
    fn conversation_trust_list(&self, conversation_id: &str) -> Option<Vec<String>> {
        match self.0.store.records().conversation(conversation_id) {
            Ok(conversation) => conversation.map(|conversation| conversation.trust_list),
            Err(error) => {
                tracing::warn!(scope = "AgentRuntime", %error, "could not read the conversation");
                None
            }
        }
    }

    /// `addToTrustList`: a tool already listed is not added twice.
    fn add_to_trust_list(&self, conversation_id: &str, tool: &str) -> Result<(), String> {
        let records = self.0.store.records();
        let mut trust_list = records
            .conversation(conversation_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the conversation is gone".to_owned())?
            .trust_list;
        if trust_list.iter().any(|known| known == tool) {
            return Ok(());
        }
        trust_list.push(tool.to_owned());
        let patch = ConversationPatch {
            trust_list: Some(&trust_list),
            ..ConversationPatch::default()
        };
        records
            .update_conversation(conversation_id, &patch)
            .map(drop)
            .map_err(|error| error.to_string())
    }

    fn vault_trust_list(&self) -> Vec<String> {
        vault_trust_list(&self.0.config, &self.0.vault_id)
    }

    fn grant_vault_tool(&self, tool: &str) -> Result<(), String> {
        edit_vault_trust_list(&self.0.config, &self.0.vault_id, &[tool.to_owned()], &[])
            .map(drop)
            .map_err(|error| error.to_string())
    }

    fn approval_mode(&self) -> ToolApprovalMode {
        self.0
            .config
            .agent()
            .tool_approval_mode
            .and_then(|mode| serde_json::from_value(Value::String(mode)).ok())
            .unwrap_or_default()
    }

    fn approval_requested(&self, approval: &PendingApproval) {
        (self.0.events)(AgentEvent::ToolCallPendingApproval {
            conversation_id: approval.conversation_id.clone(),
            tool_call_id: approval.tool_call_id.clone(),
            name: approval.name.clone(),
            args: approval.args.clone(),
            requires_diff: approval.requires_diff,
            preview_kind: approval.preview_kind,
            review_target: approval.review_target.clone(),
        });
        self.track(
            "tool_approval_requested",
            false,
            ("tool", to_safe_token(&approval.name, "unknown_tool")),
        );
    }

    fn approval_failed(&self, approval: &PendingApproval, code: &str, message: &str) {
        (self.0.events)(AgentEvent::ToolCallFailed {
            conversation_id: approval.conversation_id.clone(),
            tool_call_id: approval.tool_call_id.clone(),
            error: AgentEventError {
                code: code.to_owned(),
                message: message.to_owned(),
            },
        });
    }

    fn approval_decided(&self, label: ApprovalLabel) {
        self.track(
            "tool_approval_decided",
            label.failed(),
            ("decision", to_safe_token(label.as_str(), "unknown")),
        );
    }
}
