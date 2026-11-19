//! The agent write gate wired into the app (Step 28d): the vault lifecycle over a real
//! `Session` (close, switch, quit), the turn lock and the stop. A pending approval never outlives
//! the turn, the vault or the app that raised it, and a stopped backend raises no new card.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use memry_desktop::agent::mcp::{CallContext, ToolError, ToolRegistry, ToolReply, VaultToolHost};
use memry_desktop::agent::runtime::{
    AgentService, ApprovalLabel, CANCELLED, DENIED, GateHost, NO_TURN, PendingApproval,
    ToolApprovalMode, TurnError, VaultAgent, stop_chat_server,
};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::shell::shutdown::{Deadline, ShutdownContext, ShutdownReason};
use rmcp::model::CallToolResult;
use serde_json::{Value, json};
use tokio::sync::mpsc;

const NO_GATE: &str =
    "Write tools require an active memrynote Agent conversation with an approval gate.";

#[derive(Default)]
pub(crate) struct Writes(pub(crate) Mutex<Vec<(String, Value)>>);

#[async_trait]
impl VaultToolHost for Writes {
    async fn call(&self, tool: &str, args: Value, _: &CallContext) -> Result<ToolReply, ToolError> {
        self.0.lock().unwrap().push((tool.to_owned(), args));
        Ok(ToolReply::new(json!({ "ok": true })))
    }
}

/// Every conversation exists with an empty trust list; cards go to `requested`.
struct Host {
    requested: mpsc::UnboundedSender<PendingApproval>,
    failed: Arc<Mutex<Vec<(String, String, String)>>>,
    decided: Arc<Mutex<Vec<ApprovalLabel>>>,
}

impl GateHost for Host {
    fn conversation_trust_list(&self, _: &str) -> Option<Vec<String>> {
        Some(Vec::new())
    }
    fn add_to_trust_list(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn vault_trust_list(&self) -> Vec<String> {
        Vec::new()
    }
    fn grant_vault_tool(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn approval_mode(&self) -> ToolApprovalMode {
        ToolApprovalMode::Ask
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
    fn approval_decided(&self, label: ApprovalLabel) {
        self.decided.lock().unwrap().push(label);
    }
}

struct App {
    _dir: tempfile::TempDir,
    vault_a: std::path::PathBuf,
    vault_b: std::path::PathBuf,
    session: Session,
    service: Arc<AgentService>,
    writes: Arc<Writes>,
    requested: mpsc::UnboundedReceiver<PendingApproval>,
    failed: Arc<Mutex<Vec<(String, String, String)>>>,
    decided: Arc<Mutex<Vec<ApprovalLabel>>>,
}

/// A real session with the agent attached as the app attaches it.
fn app() -> App {
    let dir = tempfile::tempdir().unwrap();
    let (vault_a, vault_b) = (dir.path().join("a"), dir.path().join("b"));
    std::fs::create_dir_all(&vault_a).unwrap();
    std::fs::create_dir_all(&vault_b).unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    let config = AppConfig::load(dir.path().join("app/memry-config.json"));
    let session = Session::new(VaultRegistry::new(Arc::new(config)));
    let (sender, requested) = mpsc::unbounded_channel();
    let writes = Arc::new(Writes::default());
    let failed = Arc::new(Mutex::default());
    let decided = Arc::new(Mutex::default());
    let (tools, cards, failures, decisions) = (
        writes.clone(),
        sender,
        Arc::clone(&failed),
        Arc::clone(&decided),
    );
    let service = AgentService::new(Arc::new(move |open| {
        let host = Arc::new(Host {
            requested: cards.clone(),
            failed: Arc::clone(&failures),
            decided: Arc::clone(&decisions),
        });
        let registry = Arc::new(ToolRegistry::new(tools.clone()));
        Some(VaultAgent::new(open.vault_id.clone(), registry, host))
    }));
    service.attach(&session);
    App {
        _dir: dir,
        vault_a,
        vault_b,
        session,
        service,
        writes,
        requested,
        failed,
        decided,
    }
}

const TASK: (&str, &str) = ("vault_create_task", r#"{"title":"Task"}"#);

fn spawn(
    agent: &VaultAgent,
    (tool, args): (&str, &str),
    grant: &str,
) -> tokio::task::JoinHandle<CallToolResult> {
    let registry = Arc::clone(agent.registry());
    let (tool, args) = (tool.to_owned(), serde_json::from_str(args).ok());
    let ctx = CallContext {
        write_grant: Some(grant.to_owned()),
        window: Some("main".into()),
    };
    tokio::spawn(async move { registry.call(&tool, args, &ctx).await })
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

impl App {
    fn open(&self, path: &std::path::Path) -> Arc<VaultAgent> {
        self.session.open(path, OpenSource::Select).unwrap();
        self.service.current().expect("the open vault has an agent")
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

    fn no_new_card(&mut self) {
        assert!(self.requested.try_recv().is_err(), "a new card appeared");
    }

    fn written(&self) -> usize {
        self.writes.0.lock().unwrap().len()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_vault_close_denies_its_open_approval_and_stops_its_agent() {
    let mut app = app();
    let agent = app.open(&app.vault_a.clone());
    let turn = agent.begin_turn("conversation-1").unwrap();
    let mut call = spawn(&agent, TASK, turn.grant());
    app.card(&mut call).await;

    app.session.close();

    // Settled now, not after the 30 minute deadline.
    let result = tokio::time::timeout(Duration::from_secs(5), call).await;
    assert_eq!(refusal(&result.unwrap().unwrap()), denied_with(DENIED));
    assert_eq!(*app.decided.lock().unwrap(), [ApprovalLabel::Abandoned]);
    assert!(app.service.current().is_none());
    assert_eq!(
        agent.begin_turn("conversation-2").err(),
        Some(TurnError::Closed)
    );
    // The closed vault's registry has no gate: its writes are refused before any card.
    let late = spawn(&agent, TASK, turn.grant()).await.unwrap();
    assert_eq!(refusal(&late), denied_with(NO_GATE));
    app.no_new_card();
    assert_eq!(app.written(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_vault_switch_denies_the_old_vaults_approval_and_builds_a_fresh_agent() {
    let mut app = app();
    let old = app.open(&app.vault_a.clone());
    let turn = old.begin_turn("conversation-1").unwrap();
    let mut call = spawn(&old, TASK, turn.grant());
    app.card(&mut call).await;

    app.session.switch(&app.vault_b.clone()).unwrap();

    let result = tokio::time::timeout(Duration::from_secs(5), call).await;
    assert_eq!(refusal(&result.unwrap().unwrap()), denied_with(DENIED));
    let new = app.service.current().expect("the new vault has an agent");
    assert!(!Arc::ptr_eq(&old, &new));
    assert_ne!(old.vault_id(), new.vault_id());
    // The old vault's turn grant authorises nothing in the new one.
    let stale = spawn(&new, TASK, turn.grant()).await.unwrap();
    assert_eq!(refusal(&stale), denied_with(NO_TURN));
    app.no_new_card();
    assert_eq!(app.written(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quit_denies_open_approvals_in_stop_chat_server() {
    let mut app = app();
    let agent = app.open(&app.vault_a.clone());
    let turn = agent.begin_turn("conversation-1").unwrap();
    let killed = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&killed);
    let _backend = agent.track_backend(
        "conversation-1",
        Arc::new(move || flag.store(true, Ordering::SeqCst)),
    );
    let mut call = spawn(&agent, TASK, turn.grant());
    app.card(&mut call).await;

    let step = stop_chat_server(Arc::clone(&app.service));
    let context = ShutdownContext {
        installing_update: false,
        reason: ShutdownReason::Quit,
    };
    step(context, Deadline::after(Duration::from_secs(1)))
        .await
        .unwrap();

    let result = tokio::time::timeout(Duration::from_secs(5), call).await;
    assert_eq!(refusal(&result.unwrap().unwrap()), denied_with(DENIED));
    assert!(killed.load(Ordering::SeqCst), "the backend outlived quit");
    assert!(app.service.current().is_none());
    // `close-vault` behind it finds nothing left to stop.
    app.session.close();
    assert_eq!(*app.decided.lock().unwrap(), [ApprovalLabel::Abandoned]);
    assert_eq!(app.written(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn releasing_the_turn_lock_denies_its_cards_and_ends_its_grant() {
    let mut app = app();
    let agent = app.open(&app.vault_a.clone());
    let turn = agent.begin_turn("conversation-1").unwrap();
    assert_eq!(
        agent.begin_turn("conversation-1").err(),
        Some(TurnError::Busy("conversation-1".to_owned()))
    );
    let grant = turn.grant().to_owned();
    let mut call = spawn(&agent, TASK, &grant);
    let card = app.card(&mut call).await;

    drop(turn);

    let result = tokio::time::timeout(Duration::from_secs(5), call).await;
    assert_eq!(refusal(&result.unwrap().unwrap()), denied_with(DENIED));
    assert_eq!(
        *app.failed.lock().unwrap(),
        [(
            card.tool_call_id,
            "PERMISSION_DENIED".to_owned(),
            CANCELLED.to_owned()
        )]
    );
    let late = spawn(&agent, TASK, &grant).await.unwrap();
    assert_eq!(refusal(&late), denied_with(NO_TURN));
    app.no_new_card();
    let next = agent.begin_turn("conversation-1").unwrap();
    assert_ne!(next.grant(), grant);
    assert_eq!(app.written(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_kills_the_backend_and_no_new_card_appears() {
    let mut app = app();
    let agent = app.open(&app.vault_a.clone());
    let turn = agent.begin_turn("conversation-1").unwrap();
    let other = agent.begin_turn("conversation-2").unwrap();
    let kill = |flag: &Arc<AtomicBool>| {
        let flag = Arc::clone(flag);
        Arc::new(move || flag.store(true, Ordering::SeqCst))
    };
    let (killed, spared, late) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
    let _backend = agent.track_backend("conversation-1", kill(&killed));
    let _other_backend = agent.track_backend("conversation-2", kill(&spared));
    let mut call = spawn(&agent, TASK, turn.grant());
    app.card(&mut call).await;

    agent.cancel_turn("conversation-1");

    assert!(
        killed.load(Ordering::SeqCst),
        "stop left the backend running"
    );
    assert!(!spared.load(Ordering::SeqCst), "stop killed another turn");
    let result = tokio::time::timeout(Duration::from_secs(5), call).await;
    assert_eq!(refusal(&result.unwrap().unwrap()), denied_with(DENIED));
    // The backend got its kill but answered one more write before it died: no card.
    let after = spawn(&agent, TASK, turn.grant()).await.unwrap();
    assert_eq!(refusal(&after), denied_with(NO_TURN));
    app.no_new_card();
    // A backend the turn registers after the stop is killed as it registers.
    let _late_backend = agent.track_backend("conversation-1", kill(&late));
    assert!(late.load(Ordering::SeqCst));
    // The other conversation still writes once allowed.
    let mut kept = spawn(&agent, TASK, other.grant());
    let card = app.card(&mut kept).await;
    agent.gate().resolve_approval(
        &card.tool_call_id,
        memry_desktop::agent::runtime::ApproveToolDecision::Allow,
    );
    assert_eq!(refusal(&kept.await.unwrap()), None);
    assert_eq!(app.written(), 1);
}

#[path = "agent_gate_wiring_host.rs"]
mod host;
