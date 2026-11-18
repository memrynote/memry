//! The agent write gate (Step 28c3) through the MCP registry's call path: Electron's
//! `turn-grants.test.ts`, `permission-gate.test.ts` and `runtime-approval.test.ts` cases, plus
//! the leaks the Rust gate closes (another vault's grant, an approval that outlives its turn).
//! The host records every call that got past the gate, so "writes nothing" is checked there.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use memry_desktop::agent::mcp::{
    CallContext, ToolClass, ToolError, ToolRegistry, ToolReply, VaultToolHost, catalog,
};
use memry_desktop::agent::runtime::{
    APPROVAL_EXPIRED_CODE, APPROVAL_EXPIRED_MESSAGE, APPROVAL_TIMEOUT, AgentWriteGate,
    AlwaysAllowScope, ApproveToolDecision, CANCELLED, DENIED, Gate, GateHost, GateInput, NO_TURN,
    PendingApproval, PreviewKind, ReviewTarget, ToolApprovalMode, TurnGrants, UNKNOWN_CONVERSATION,
    decide_tool_gate, preview_kind_for_tool, previewed_tools, review_target_for_tool,
};
use rmcp::model::{CallToolResult, JsonObject};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const EXAMPLES: &str =
    include_str!("../../../packages/contracts/test-vectors/agent-mcp/examples.json");

#[derive(Default)]
struct Writes(Mutex<Vec<(String, Value)>>);

#[async_trait]
impl VaultToolHost for Writes {
    async fn call(&self, tool: &str, args: Value, _: &CallContext) -> Result<ToolReply, ToolError> {
        self.0.lock().unwrap().push((tool.to_owned(), args));
        Ok(ToolReply::new(json!({ "ok": true })))
    }
}

struct Host {
    conversations: Mutex<HashMap<String, Vec<String>>>,
    vault: Mutex<Vec<String>>,
    mode: Mutex<ToolApprovalMode>,
    requested: mpsc::UnboundedSender<PendingApproval>,
    failed: Mutex<Vec<(String, String, String)>>,
}

impl GateHost for Host {
    fn conversation_trust_list(&self, id: &str) -> Option<Vec<String>> {
        self.conversations.lock().unwrap().get(id).cloned()
    }
    fn add_to_trust_list(&self, id: &str, tool: &str) -> Result<(), String> {
        let mut conversations = self.conversations.lock().unwrap();
        let list = conversations.get_mut(id).ok_or("gone")?;
        if !list.iter().any(|known| known == tool) {
            list.push(tool.to_owned());
        }
        Ok(())
    }
    fn vault_trust_list(&self) -> Vec<String> {
        self.vault.lock().unwrap().clone()
    }
    fn grant_vault_tool(&self, tool: &str) -> Result<(), String> {
        self.vault.lock().unwrap().push(tool.to_owned());
        Ok(())
    }
    fn approval_mode(&self) -> ToolApprovalMode {
        *self.mode.lock().unwrap()
    }
    fn approval_requested(&self, approval: &PendingApproval) {
        let _ = self.requested.send(approval.clone());
    }
    fn approval_failed(&self, approval: &PendingApproval, code: &str, message: &str) {
        self.failed.lock().unwrap().push((
            approval.tool_call_id.clone(),
            code.to_owned(),
            message.to_owned(),
        ));
    }
}

struct Vault {
    registry: Arc<ToolRegistry>,
    gate: Arc<AgentWriteGate>,
    host: Arc<Host>,
    writes: Arc<Writes>,
    requested: mpsc::UnboundedReceiver<PendingApproval>,
}

fn vault() -> Vault {
    let (sender, requested) = mpsc::unbounded_channel();
    let host = Arc::new(Host {
        conversations: Mutex::new(HashMap::from([
            ("conversation-1".to_owned(), Vec::new()),
            ("conversation-2".to_owned(), Vec::new()),
        ])),
        vault: Mutex::default(),
        mode: Mutex::default(),
        requested: sender,
        failed: Mutex::default(),
    });
    let writes = Arc::new(Writes::default());
    let registry = Arc::new(ToolRegistry::new(writes.clone()));
    let gate = Arc::new(AgentWriteGate::new(host.clone()));
    registry.set_write_gate(Some(gate.clone()));
    Vault {
        registry,
        gate,
        host,
        writes,
        requested,
    }
}

const TASK: (&str, &str) = ("vault_create_task", r#"{"title":"Task"}"#);
const NOTE_EDIT: (&str, &str) = (
    "vault_update_note",
    r#"{"id":"note-1","mode":"replace","content_markdown":"B"}"#,
);
const DELETE: (&str, &str) = ("vault_delete_note", r#"{"id":"note-1"}"#);

fn object(json: &str) -> Option<JsonObject> {
    serde_json::from_str(json).ok()
}

fn turn(grant: &str) -> CallContext {
    CallContext {
        write_grant: Some(grant.to_owned()),
        window: Some("main".into()),
    }
}

/// `(code, message)` of a refused call; `None` when the call succeeded.
fn refusal(result: &CallToolResult) -> Option<(String, String)> {
    if result.is_error != Some(true) {
        return None;
    }
    let text = serde_json::to_value(result).unwrap()["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    let body: Value = serde_json::from_str(&text).unwrap();
    Some((
        body["code"].as_str().unwrap().to_owned(),
        body["message"].as_str().unwrap().to_owned(),
    ))
}

fn denied_with(message: &str) -> Option<(String, String)> {
    Some(("PERMISSION_DENIED".to_owned(), message.to_owned()))
}

impl Vault {
    fn spawn(
        &self,
        (tool, args): (&str, &str),
        grant: &str,
    ) -> tokio::task::JoinHandle<CallToolResult> {
        let registry = self.registry.clone();
        let (tool, args, ctx) = (tool.to_owned(), object(args), turn(grant));
        tokio::spawn(async move { registry.call(&tool, args, &ctx).await })
    }

    async fn call(&self, call: (&str, &str), grant: &str) -> CallToolResult {
        self.spawn(call, grant).await.unwrap()
    }

    /// The card `call` raised; a call that ends without one fails the test.
    async fn card(
        &mut self,
        call: &mut tokio::task::JoinHandle<CallToolResult>,
    ) -> PendingApproval {
        tokio::select! {
            card = self.requested.recv() => card.unwrap(),
            done = call => panic!("the call ended without a card: {:?}", done.map(|r| refusal(&r))),
        }
    }

    fn written(&self) -> Vec<(String, Value)> {
        self.writes.0.lock().unwrap().clone()
    }

    fn failed(&self) -> Vec<(String, String, String)> {
        self.host.failed.lock().unwrap().clone()
    }
}

mod grants {
    use super::*;

    #[test]
    fn a_grant_is_unguessable_and_resolves_to_its_conversation_only() {
        let grants = Arc::new(TurnGrants::default());
        let grant = grants.mint("conversation-1");
        assert_eq!(grant.secret().len(), 64);
        assert!(grant.secret().bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(
            grants.resolve(grant.secret()).as_deref(),
            Some("conversation-1")
        );
        assert_eq!(grants.resolve("conversation-1"), None);
        assert_eq!(grants.resolve(""), None);
        assert_eq!(format!("{grant:?}"), "TurnGrant(..)");
    }

    #[test]
    fn a_new_turn_drops_the_previous_grant_and_revokes_stay_per_conversation() {
        let grants = Arc::new(TurnGrants::default());
        let first = grants.mint("conversation-1");
        let second = grants.mint("conversation-1");
        let other = grants.mint("conversation-2");
        assert_ne!(first.secret(), second.secret());
        assert_eq!(grants.resolve(first.secret()), None);
        grants.revoke_for("conversation-1");
        assert_eq!(grants.resolve(second.secret()), None);
        assert_eq!(
            grants.resolve(other.secret()).as_deref(),
            Some("conversation-2")
        );
        grants.revoke_all();
        assert_eq!(grants.resolve(other.secret()), None);
    }

    #[test]
    fn a_grant_dies_with_its_turn() {
        let grants = Arc::new(TurnGrants::default());
        let grant = grants.mint("conversation-1");
        let secret = grant.secret().to_owned();
        drop(grant);
        assert_eq!(grants.resolve(&secret), None);
    }
}

mod order {
    use super::*;

    fn decide(tool: &str, trust: &[&str], vault: &[&str], mode: ToolApprovalMode) -> Gate {
        let owned = |list: &[&str]| {
            list.iter()
                .map(|tool| (*tool).to_owned())
                .collect::<Vec<_>>()
        };
        decide_tool_gate(&GateInput {
            tool,
            trust_list: &owned(trust),
            vault_trust_list: &owned(vault),
            mode,
        })
    }

    fn asks(preview_kind: PreviewKind) -> Gate {
        Gate::AwaitUser {
            requires_diff: preview_kind != PreviewKind::None,
            preview_kind,
        }
    }

    use ToolApprovalMode::{AlwaysAccept, Ask};

    #[test]
    fn electrons_gate_order() {
        assert_eq!(ToolApprovalMode::default(), Ask);
        assert_eq!(
            decide("vault_create_task", &[], &[], Ask),
            asks(PreviewKind::Fields)
        );
        assert_eq!(
            decide("vault_update_task", &[], &[], Ask),
            asks(PreviewKind::Fields)
        );
        assert_eq!(
            decide("vault_delete_note", &[], &[], AlwaysAccept),
            Gate::AutoApprove
        );
        assert_eq!(decide("vault_read_note", &[], &[], Ask), Gate::AutoApprove);
        let task = "vault_create_task";
        assert_eq!(decide(task, &[task], &[], Ask), Gate::AutoApprove);
        assert_eq!(decide(task, &[], &[task], Ask), Gate::AutoApprove);
        assert_eq!(
            decide("vault_archive_task", &[], &[], Ask),
            asks(PreviewKind::Fields)
        );
        assert_eq!(
            decide("vault_create_note", &[], &[], Ask),
            asks(PreviewKind::Body)
        );
        assert_eq!(
            decide("vault_unknown_write", &[], &[], Ask),
            asks(PreviewKind::None)
        );
    }

    #[test]
    fn a_delete_or_an_in_page_edit_asks_whatever_was_trusted() {
        let deletes: Vec<_> = previewed_tools()
            .filter(|tool| preview_kind_for_tool(tool) == PreviewKind::Loss)
            .collect();
        assert_eq!(deletes.len(), 7);
        for tool in deletes
            .into_iter()
            .chain(["vault_update_note", "vault_update_journal_entry"])
        {
            let gate = decide(tool, &[tool], &[tool], Ask);
            assert!(matches!(gate, Gate::AwaitUser { .. }), "{tool} was trusted");
        }
        assert_eq!(
            decide("vault_delete_task", &[], &[], Ask),
            asks(PreviewKind::Loss)
        );
    }

    #[test]
    fn every_write_tool_has_a_preview_and_no_read_tool_does() {
        let mut writes: Vec<_> = catalog()
            .tools()
            .filter(|spec| spec.class == ToolClass::Write)
            .map(|spec| spec.name())
            .collect();
        let mut previewed: Vec<_> = previewed_tools().collect();
        writes.sort_unstable();
        previewed.sort_unstable();
        assert_eq!(writes, previewed);
    }

    #[test]
    fn review_targets_follow_electron() {
        assert_eq!(
            review_target_for_tool("vault_update_note", &json!({ "id": "n1" })),
            Some(ReviewTarget::Note { id: "n1".into() })
        );
        let journal = json!({ "date": "2026-11-18", "content_markdown": "x" });
        assert_eq!(
            review_target_for_tool("vault_update_journal_entry", &journal),
            Some(ReviewTarget::Journal {
                date: "2026-11-18".into()
            })
        );
        let tags_only = json!({ "date": "2026-11-18", "tags": ["a"] });
        assert_eq!(
            review_target_for_tool("vault_update_journal_entry", &tags_only),
            None
        );
        assert_eq!(
            review_target_for_tool("vault_create_note", &json!({})),
            None
        );
    }

    #[test]
    fn decisions_parse_as_the_contract_writes_them() {
        let parse = |value: Value| serde_json::from_value::<ApproveToolDecision>(value).unwrap();
        assert_eq!(
            parse(json!({ "kind": "allow_always" })),
            ApproveToolDecision::AllowAlways {
                scope: AlwaysAllowScope::Conversation
            }
        );
        assert_eq!(
            parse(json!({ "kind": "edit_allow", "editedArgs": { "a": 1 } })),
            ApproveToolDecision::EditAllow {
                edited_args: Some(json!({ "a": 1 }))
            }
        );
        assert_eq!(parse(json!({ "kind": "deny" })), ApproveToolDecision::Deny);
    }
}

mod capability {
    use super::*;

    /// One valid example call per write tool, from Electron's vectors.
    fn every_write_call() -> Vec<(String, String)> {
        let file: Value = serde_json::from_str(EXAMPLES).unwrap();
        let mut calls: Vec<(String, String)> = Vec::new();
        for spec in catalog()
            .tools()
            .filter(|spec| spec.class == ToolClass::Write)
        {
            let case = file["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["tool"] == spec.name() && case["valid"] == json!(true))
                .unwrap_or_else(|| panic!("no valid example for {}", spec.name()));
            calls.push((spec.name().to_owned(), case["arguments"].to_string()));
        }
        assert_eq!(calls.len(), 53);
        calls
    }

    #[tokio::test]
    async fn no_write_tool_runs_without_a_live_grant() {
        let vault = vault();
        *vault.host.mode.lock().unwrap() = ToolApprovalMode::AlwaysAccept;
        let _turn = vault.gate.mint_turn_write_grant("conversation-1");
        for (tool, args) in every_write_call() {
            for presented in ["conversation-1", "0".repeat(64).as_str()] {
                let result = vault.call((&tool, &args), presented).await;
                assert_eq!(refusal(&result), denied_with(NO_TURN), "{tool}");
            }
            let anonymous = vault
                .registry
                .call(&tool, object(&args), &CallContext::default())
                .await;
            assert_eq!(
                refusal(&anonymous).unwrap().0,
                "PERMISSION_DENIED",
                "{tool}"
            );
        }
        assert_eq!(vault.written(), []);
    }

    #[tokio::test]
    async fn a_grant_reused_in_the_next_turn_writes_nothing() {
        let vault = vault();
        *vault.host.mode.lock().unwrap() = ToolApprovalMode::AlwaysAccept;
        let first = vault.gate.mint_turn_write_grant("conversation-1");
        let stale = first.secret().to_owned();
        assert_eq!(refusal(&vault.call(TASK, &stale).await), None);
        drop(first);
        let next = vault.gate.mint_turn_write_grant("conversation-1");
        assert_eq!(
            refusal(&vault.call(TASK, &stale).await),
            denied_with(NO_TURN)
        );
        assert_eq!(refusal(&vault.call(TASK, next.secret()).await), None);
        assert_eq!(vault.written().len(), 2);
    }

    #[tokio::test]
    async fn a_grant_never_crosses_vaults_or_outlives_a_session() {
        let one = vault();
        let two = vault();
        *one.host.mode.lock().unwrap() = ToolApprovalMode::AlwaysAccept;
        *two.host.mode.lock().unwrap() = ToolApprovalMode::AlwaysAccept;
        let grant = one.gate.mint_turn_write_grant("conversation-1");
        assert_eq!(
            refusal(&two.call(TASK, grant.secret()).await),
            denied_with(NO_TURN)
        );
        one.gate.shutdown();
        assert_eq!(
            refusal(&one.call(TASK, grant.secret()).await),
            denied_with(NO_TURN)
        );
        let after = one.gate.mint_turn_write_grant("conversation-1");
        assert_eq!(
            refusal(&one.call(TASK, after.secret()).await),
            denied_with(NO_TURN)
        );
        assert_eq!(one.written(), []);
        assert_eq!(two.written(), []);
    }

    #[tokio::test]
    async fn a_conversation_that_is_gone_writes_nothing() {
        let vault = vault();
        let grant = vault.gate.mint_turn_write_grant("conversation-1");
        vault
            .host
            .conversations
            .lock()
            .unwrap()
            .remove("conversation-1");
        let result = vault.call(TASK, grant.secret()).await;
        assert_eq!(refusal(&result), denied_with(UNKNOWN_CONVERSATION));
        assert_eq!(vault.written(), []);
    }
}

#[path = "agent_write_gate_approvals.rs"]
mod approvals;
