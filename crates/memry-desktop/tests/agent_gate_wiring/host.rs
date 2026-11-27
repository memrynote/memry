//! The production gate host over a real `AgentStore` and app config: the vault's standing
//! approvals under `agent.alwaysAllowedTools[vaultUuid]` (revoked in Settings, the gate stops
//! auto-approving at the next call), the conversation trust list, the approval card events and
//! the approval telemetry of Electron's `runtime.ts`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::vault::Vault;
use memry_desktop::agent::mcp::ToolRegistry;
use memry_desktop::agent::runtime::{
    APPROVAL_TIMEOUT, AgentEvent, AlwaysAllowScope, ApproveToolDecision, HostParts, VaultAgent,
    VaultGateHost, edit_vault_trust_list,
};
use memry_desktop::agent::store::gate::EntitlementGate;
use memry_desktop::agent::store::{AgentStore, NewConversation, StoreParts};
use memry_desktop::registry::AppConfig;
use memry_desktop::session::at_rest_key::AtRestKeys;
use memry_desktop::telemetry::events::TelemetryEvent;
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};

use super::{Writes, denied_with, refusal, spawn};
use crate::device_key;

const VAULT: &str = "vault-uuid-a";
/// The argument telemetry must never carry.
const SECRET: &str = "Quarterly salary review";

struct Fixture {
    _dir: tempfile::TempDir,
    config_path: std::path::PathBuf,
    config: Arc<AppConfig>,
    store: Arc<AgentStore>,
    agent: VaultAgent,
    writes: Arc<Writes>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
    telemetry: Arc<Mutex<Vec<TelemetryEvent>>>,
    conversation: String,
}

/// The store runs in memory (the keychain holds no master key), as it does signed out.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let core = dir.path().join("vault/.memry/core");
    std::fs::create_dir_all(&core).unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    let config_path = dir.path().join("app/memry-config.json");
    std::fs::write(
        &config_path,
        r#"{"agent":{"alwaysAllowedTools":{"vault-uuid-b":["vault_create_task"]}}}"#,
    )
    .unwrap();
    let config = Arc::new(AppConfig::load(config_path.clone()));
    let vault = Arc::new(Vault::open("v1".into(), core.to_string_lossy().into_owned()).unwrap());
    let store = AgentStore::open(
        StoreParts {
            vault,
            keys: AtRestKeys::new(device_key::with_device_key()),
            device_id: "device-a".to_owned(),
            gate: EntitlementGate::new(watch::Sender::new(false).subscribe()),
            keychain_recovered: broadcast::Sender::new(1).subscribe(),
        },
        &tokio::runtime::Handle::current(),
    );
    let conversation = store
        .records()
        .create_conversation(&NewConversation {
            vault_id: VAULT,
            title: "Chat",
            backend: "claude",
            backend_model: None,
        })
        .unwrap()
        .id;
    let events = Arc::new(Mutex::new(Vec::new()));
    let telemetry = Arc::new(Mutex::new(Vec::new()));
    let (sink, track) = (Arc::clone(&events), Arc::clone(&telemetry));
    let host = VaultGateHost::new(HostParts {
        vault_id: VAULT.to_owned(),
        config: Arc::clone(&config),
        store: Arc::clone(&store),
        events: Arc::new(move |event| sink.lock().unwrap().push(event)),
        track: Arc::new(move |event| track.lock().unwrap().push(event)),
    });
    let writes = Arc::new(Writes::default());
    let registry = Arc::new(ToolRegistry::new(writes.clone()));
    let agent = VaultAgent::new(VAULT.to_owned(), registry, Arc::new(host));
    Fixture {
        _dir: dir,
        config_path,
        config,
        store,
        agent,
        writes,
        events,
        telemetry,
        conversation,
    }
}

fn task() -> String {
    json!({ "title": SECRET }).to_string()
}

impl Fixture {
    /// The card a call raises, read from the event stream.
    async fn card(&self, call: &tokio::task::JoinHandle<rmcp::model::CallToolResult>) -> String {
        for _ in 0..500 {
            let cards: Vec<String> = self
                .events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|event| match event {
                    AgentEvent::ToolCallPendingApproval { tool_call_id, .. } => {
                        Some(tool_call_id.clone())
                    }
                    AgentEvent::ToolCallFailed { .. } => None,
                })
                .collect();
            if let Some(id) = cards
                .iter()
                .find(|id| self.agent.gate().pending_approval(id).is_some())
            {
                return id.clone();
            }
            assert!(!call.is_finished(), "the call ended without a card");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no card");
    }

    fn written(&self) -> usize {
        self.writes.0.lock().unwrap().len()
    }

    fn cards(&self) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| matches!(event, AgentEvent::ToolCallPendingApproval { .. }))
            .count()
    }

    fn saved_grants(&self) -> Value {
        let file: Value =
            serde_json::from_str(&std::fs::read_to_string(&self.config_path).unwrap()).unwrap();
        file["agent"]["alwaysAllowedTools"].clone()
    }

    /// `(action, result, dimensions)` of every approval event.
    fn tracked(&self) -> Vec<(String, String, Value)> {
        self.telemetry
            .lock()
            .unwrap()
            .iter()
            .map(|event| {
                assert_eq!(event.name, "ai_action_completed");
                assert_eq!(event.surface, "ai");
                (
                    event.action.clone(),
                    event.result.clone().unwrap(),
                    serde_json::to_value(&event.dimensions).unwrap(),
                )
            })
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_grant_revoked_in_settings_stops_auto_approval_at_the_next_call() {
    let f = fixture();
    let turn = f.agent.begin_turn(&f.conversation).unwrap();
    let task = task();
    let call = || spawn(&f.agent, ("vault_create_task", &task), turn.grant());

    // A standing approval granted from a card's "always allow" at vault scope.
    let first = call();
    let card = f.card(&first).await;
    let scope = AlwaysAllowScope::Vault;
    f.agent
        .gate()
        .resolve_approval(&card, ApproveToolDecision::AllowAlways { scope });
    assert_eq!(refusal(&first.await.unwrap()), None);
    assert_eq!(
        f.saved_grants(),
        json!({ "vault-uuid-a": ["vault_create_task"], "vault-uuid-b": ["vault_create_task"] })
    );
    assert_eq!(refusal(&call().await.unwrap()), None);
    assert_eq!((f.written(), f.cards()), (2, 1));

    // Settings revokes it (`agent_edit_vault_trust_list`): the next call asks again.
    let left = edit_vault_trust_list(&f.config, VAULT, &[], &["vault_create_task".to_owned()]);
    assert_eq!(left.unwrap(), Vec::<String>::new());
    let asked = call();
    let card = f.card(&asked).await;
    assert_eq!(f.cards(), 2);
    f.agent
        .gate()
        .resolve_approval(&card, ApproveToolDecision::Deny);
    assert_eq!(
        refusal(&asked.await.unwrap()),
        denied_with(memry_desktop::agent::runtime::DENIED)
    );
    assert_eq!(f.written(), 2);
    // Another vault's grants are never touched.
    assert_eq!(
        f.saved_grants(),
        json!({ "vault-uuid-a": [], "vault-uuid-b": ["vault_create_task"] })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_conversation_grant_lands_in_the_stored_trust_list() {
    let f = fixture();
    let turn = f.agent.begin_turn(&f.conversation).unwrap();
    let task = task();
    let first = spawn(&f.agent, ("vault_create_task", &task), turn.grant());
    let card = f.card(&first).await;
    let scope = AlwaysAllowScope::Conversation;
    f.agent
        .gate()
        .resolve_approval(&card, ApproveToolDecision::AllowAlways { scope });
    assert_eq!(refusal(&first.await.unwrap()), None);
    let stored = f.store.records().conversation(&f.conversation).unwrap();
    assert_eq!(stored.unwrap().trust_list, ["vault_create_task"]);
    assert_eq!(f.saved_grants()["vault-uuid-a"], Value::Null);
    let again = spawn(&f.agent, ("vault_create_task", &task), turn.grant());
    assert_eq!(refusal(&again.await.unwrap()), None);
    assert_eq!((f.written(), f.cards()), (2, 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_card_events_have_the_contract_shape() {
    let f = fixture();
    let turn = f.agent.begin_turn(&f.conversation).unwrap();
    let task = task();
    let call = spawn(&f.agent, ("vault_create_task", &task), turn.grant());
    let card = f.card(&call).await;
    f.agent.cancel_turn(&f.conversation);
    call.await.unwrap();
    let events: Vec<Value> = f
        .events
        .lock()
        .unwrap()
        .iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .collect();
    assert_eq!(
        events,
        [
            json!({
                "kind": "tool_call_pending_approval",
                "conversationId": f.conversation,
                "toolCallId": card,
                "name": "vault_create_task",
                "requiresDiff": true,
                "previewKind": "fields",
                "reviewTarget": null,
            }),
            json!({
                "kind": "tool_call_failed",
                "conversationId": f.conversation,
                "toolCallId": card,
                "error": { "code": "PERMISSION_DENIED", "message": "Turn cancelled before approval." },
            }),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_card_event_for_a_large_write_stays_under_one_kib() {
    let f = fixture();
    let turn = f.agent.begin_turn(&f.conversation).unwrap();
    let body = "x".repeat(200 * 1024);
    let note = json!({ "title": SECRET, "content_markdown": body }).to_string();
    let call = spawn(&f.agent, ("vault_create_note", &note), turn.grant());
    let card = f.card(&call).await;
    // The arguments stay with the gate for `agent_get_tool_call`.
    let pending = f.agent.gate().pending_approval(&card).unwrap();
    assert_eq!(pending.args["content_markdown"], body);
    f.agent.cancel_turn(&f.conversation);
    call.await.unwrap();

    let events = f.events.lock().unwrap();
    assert_eq!(events.len(), 2);
    for event in events.iter() {
        let wire = serde_json::to_string(event).unwrap();
        assert!(wire.len() < 1024, "{} bytes", wire.len());
        assert!(!wire.contains(SECRET), "an event carried a tool argument");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approval_telemetry_names_the_tool_and_the_decision_never_an_argument() {
    let f = fixture();
    let turn = f.agent.begin_turn(&f.conversation).unwrap();
    let task = task();
    let call = || spawn(&f.agent, ("vault_create_task", &task), turn.grant());
    for decision in [ApproveToolDecision::Allow, ApproveToolDecision::Deny] {
        let pending = call();
        let card = f.card(&pending).await;
        f.agent.gate().resolve_approval(&card, decision);
        pending.await.unwrap();
    }
    // A request that goes away unanswered (the HTTP call ended).
    let dropped = call();
    f.card(&dropped).await;
    dropped.abort();
    let _ = dropped.await;
    // Auto-accept mode.
    f.config
        .set_agent_field("toolApprovalMode", Some("always_accept".into()))
        .unwrap();
    call().await.unwrap();
    f.config.set_agent_field("toolApprovalMode", None).unwrap();
    // Shutdown with a card on screen.
    let pending = call();
    f.card(&pending).await;
    f.agent.shutdown();
    pending.await.unwrap();

    let requested = (
        "tool_approval_requested",
        "success",
        json!({ "tool": "vault_create_task" }),
    );
    let decided = |result: &str, decision: &str| {
        (
            "tool_approval_decided",
            result.to_owned(),
            json!({ "decision": decision }),
        )
    };
    let expected = [
        (requested.0, requested.1.to_owned(), requested.2.clone()),
        decided("success", "allow"),
        (requested.0, requested.1.to_owned(), requested.2.clone()),
        decided("failed", "deny"),
        (requested.0, requested.1.to_owned(), requested.2.clone()),
        decided("failed", "abandoned"),
        decided("success", "auto"),
        (requested.0, requested.1.to_owned(), requested.2.clone()),
        decided("failed", "abandoned"),
    ];
    let tracked = f.tracked();
    let tracked: Vec<(&str, String, Value)> = tracked
        .iter()
        .map(|(action, result, dims)| (action.as_str(), result.clone(), dims.clone()))
        .collect();
    assert_eq!(tracked, expected);
    let shipped = serde_json::to_string(&*f.telemetry.lock().unwrap()).unwrap();
    assert!(
        !shipped.contains(SECRET),
        "telemetry carried a tool argument"
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_unanswered_card_is_tracked_as_expired() {
    let f = fixture();
    let turn = f.agent.begin_turn(&f.conversation).unwrap();
    let task = task();
    let pending = spawn(&f.agent, ("vault_create_task", &task), turn.grant());
    f.card(&pending).await;
    tokio::time::advance(APPROVAL_TIMEOUT).await;
    pending.await.unwrap();
    let last = f.tracked().pop().unwrap();
    assert_eq!(
        last,
        (
            "tool_approval_decided".to_owned(),
            "failed".to_owned(),
            json!({ "decision": "expired" })
        )
    );
}
