//! The local agent engine's guards (#3539, REVIEW-4455): the key never leaves through a probe or
//! an error body, a step's reply is capped, cancelling stops a run at every await, and the probe
//! caches share a running probe and expire.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier};
use std::time::Duration;

use axum::http::{Method, StatusCode};
use futures_util::StreamExt as _;
use memry_core::api::errors::SecureStoreError;
use memry_desktop::ai::local_agent::probe::{IMAGE_PROBE_DEGRADED_TTL, IMAGE_PROBE_TTL};
use memry_desktop::ai::local_agent::{
    AgentToolHost, BackendEvent, LocalAgent, LocalRunInput, ProviderSource, STEP_BYTE_BUDGET,
    ToolCall, ToolOutcome, ToolSpec,
};
use memry_desktop::ai::local_provider::probe::AgentToolsOffReason;
use memry_desktop::ai::local_provider::{
    AgentLocalProviderPreset, AgentLocalThinking, LocalProvider,
};
use serde_json::json;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::ai_local_agent::{
    Fixed, Host, PROMPT, agent, deepseek, image_host, provider, run, turn_requests, vision_server,
};
use crate::local_agent_server::{
    DEEPSEEK_MODEL, DeepSeek, DeepSeekTools, Fake, MODEL, answer, chunk, client, hold_open, models,
    probe_reply, raw_json, serve, sse, sse_head_and_first,
};

/// A fake key: no real provider ever issued it.
const KEY: &str = "test-guard-key-0123456789abcdef";
/// A run that should end at once is given this long before the test gives up on it.
const WATCHDOG: Duration = Duration::from_secs(30);

fn keyed(mut settings: LocalProvider) -> LocalProvider {
    settings.api_key = Some(Zeroizing::new(KEY.into()));
    settings
}

#[tokio::test]
async fn a_rejected_tool_probe_reports_the_provider_reason_without_the_key() {
    let server = DeepSeek {
        api_key: Some(KEY.into()),
        tools: DeepSeekTools::Reject,
        echo_auth: true,
        ..DeepSeek::default()
    };
    let fake = serve(move |request| server.handle(request)).await;
    let settings = keyed(provider(
        AgentLocalProviderPreset::Custom,
        &fake.base_url,
        DEEPSEEK_MODEL,
    ));
    let agent = agent(settings);

    let events = run(&agent, LocalRunInput::new(PROMPT), Some(Host::tags())).await;
    let Some(BackendEvent::ToolsUnavailable { reason, detail }) = events.first() else {
        panic!("the turn starts with the tools-off notice: {events:?}");
    };
    assert_eq!(*reason, AgentToolsOffReason::ToolsRejected);
    let detail = detail.as_deref().unwrap_or_default();
    assert!(detail.contains("(Bearer [key])"), "{detail}");
    assert!(!format!("{events:?}").contains(KEY));

    let probed = agent.probe_capabilities().await;
    let detail = probed.detail.unwrap_or_default();
    assert!(detail.contains("(Bearer [key])"), "{detail}");
    assert!(!detail.contains(KEY));
}

#[tokio::test]
async fn a_key_across_the_reason_clip_is_redacted_before_the_clip() {
    let filler = "a".repeat(490);
    let body = format!("{filler}{KEY}");
    let fake = serve(move |_| (StatusCode::BAD_REQUEST, "text/plain", body.clone())).await;
    let settings = keyed(provider(
        AgentLocalProviderPreset::Custom,
        &fake.base_url,
        MODEL,
    ));
    let events = run(&agent(settings), LocalRunInput::new(PROMPT), None).await;
    assert_eq!(
        events,
        [BackendEvent::Error {
            message: format!("Bad Request: {filler}[key]")
        }]
    );
}

#[tokio::test]
async fn a_json_escaped_key_across_the_reason_clip_is_redacted_after_parsing() {
    // `json_encode` writes `/` as `\/`, so the raw body never holds the key as stored.
    let key = "abc/def0123456789";
    // 485 + "Bearer " puts the clip at the key's eighth character.
    let filler = "a".repeat(485);
    let body = format!(r#"{{"error":"{filler}Bearer abc\/def0123456789"}}"#);
    let fake = serve(move |_| (StatusCode::BAD_REQUEST, "application/json", body.clone())).await;
    let mut settings = provider(AgentLocalProviderPreset::Custom, &fake.base_url, MODEL);
    settings.api_key = Some(Zeroizing::new(key.into()));
    let events = run(&agent(settings), LocalRunInput::new(PROMPT), None).await;
    assert_eq!(
        events,
        [BackendEvent::Error {
            message: format!("Bad Request: {filler}Bearer [key]")
        }]
    );
    assert!(!format!("{events:?}").contains("abc/"));
}

#[tokio::test]
async fn a_step_reply_over_the_byte_budget_ends_the_turn_with_an_error() {
    let piece = "x".repeat(1024 * 1024);
    let fake = serve(move |request| {
        if request.has_tool_message() {
            return answer("done", false);
        }
        let mut chunks = vec![chunk(
            json!({ "tool_calls": [{ "index": 0, "id": "call_1", "type": "function", "function": { "name": "vault_get_tags", "arguments": "" } }] }),
            None,
        )];
        for _ in 0..=STEP_BYTE_BUDGET / piece.len() {
            chunks.push(chunk(
                json!({ "tool_calls": [{ "index": 0, "function": { "arguments": piece } }] }),
                None,
            ));
        }
        chunks.push(chunk(json!({}), Some("tool_calls")));
        sse(&chunks)
    })
    .await;
    let events = run(
        &agent(provider(
            AgentLocalProviderPreset::Custom,
            &fake.base_url,
            MODEL,
        )),
        LocalRunInput::new(PROMPT),
        None,
    )
    .await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, BackendEvent::ToolUse { .. })),
        "no call is assembled from an over-budget step"
    );
    let Some(BackendEvent::Error { message }) = events.last() else {
        panic!("the turn ends with an error");
    };
    assert!(message.contains("MiB"), "{message}");
    assert_eq!(turn_requests(&fake).len(), 1);
}

#[tokio::test]
async fn cancelling_mid_stream_ends_the_run_and_closes_the_connection() {
    let first = chunk(json!({ "role": "assistant", "content": "hi" }), None);
    let held = hold_open(vec![sse_head_and_first(&first)]).await;
    let agent = agent(provider(
        AgentLocalProviderPreset::Custom,
        &held.base_url,
        MODEL,
    ));
    let cancel = CancellationToken::new();
    let mut events = std::pin::pin!(agent.run(LocalRunInput::new(PROMPT), None, cancel.clone()));
    assert_eq!(
        events.next().await,
        Some(BackendEvent::AssistantDelta { text: "hi".into() })
    );
    // The server holds the stream open, so the run waits on the next chunk when it is cancelled.
    let (next, ()) = tokio::time::timeout(WATCHDOG, async {
        tokio::join!(events.next(), async { cancel.cancel() })
    })
    .await
    .expect("a cancelled run stops waiting on the stream");
    assert_eq!(next, None);
    tokio::time::timeout(WATCHDOG, held.closed)
        .await
        .expect("the server sees the connection close")
        .expect("the server task ran");
}

#[tokio::test]
async fn cancelling_while_the_probe_runs_ends_the_run() {
    // The model list passes; the streaming check (a 120 s request timeout) is never answered.
    let models = json!({ "object": "list", "data": [{ "id": MODEL }] });
    let held = hold_open(vec![raw_json(&models)]).await;
    let agent = agent(provider(
        AgentLocalProviderPreset::Custom,
        &held.base_url,
        MODEL,
    ));
    let cancel = CancellationToken::new();
    let events = agent.run(
        LocalRunInput::new(PROMPT),
        Some(Host::tags() as Arc<dyn AgentToolHost>),
        cancel.clone(),
    );
    let arrived = held.arrived;
    let (events, ()) = tokio::time::timeout(WATCHDOG, async {
        tokio::join!(events.collect::<Vec<_>>(), async {
            arrived.await.expect("the probe's streaming check arrives");
            cancel.cancel();
        })
    })
    .await
    .expect("a cancelled run stops waiting on the probe");
    assert_eq!(events, []);
}

/// A host whose call never returns; it records that it was entered and that it was dropped.
struct Stuck {
    entered: Notify,
    dropped: Arc<AtomicBool>,
}

struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl AgentToolHost for Stuck {
    fn tool_specs(&self) -> Vec<ToolSpec> {
        Host::tags().tool_specs()
    }

    async fn call(&self, _call: ToolCall) -> ToolOutcome {
        let _flag = DropFlag(self.dropped.clone());
        self.entered.notify_one();
        std::future::pending().await
    }
}

#[tokio::test]
async fn cancelling_during_a_tool_call_ends_the_run_and_drops_the_call() {
    let (_fake, agent) = deepseek(DeepSeek::default(), AgentLocalThinking::Default).await;
    let dropped = Arc::new(AtomicBool::new(false));
    let host = Arc::new(Stuck {
        entered: Notify::new(),
        dropped: dropped.clone(),
    });
    let cancel = CancellationToken::new();
    let stream = agent.run(
        LocalRunInput::new(PROMPT),
        Some(host.clone() as Arc<dyn AgentToolHost>),
        cancel.clone(),
    );
    let (events, ()) = tokio::time::timeout(WATCHDOG, async {
        tokio::join!(stream.collect::<Vec<_>>(), async {
            host.entered.notified().await;
            cancel.cancel();
        })
    })
    .await
    .expect("a cancelled run stops waiting on the host");
    assert!(
        matches!(events.last(), Some(BackendEvent::ToolUse { name, .. }) if name == "vault_get_tags"),
        "{events:?}"
    );
    assert!(dropped.load(Ordering::SeqCst), "the host call was dropped");
}

/// Reads wait for each other, so two turns reach the probe together.
struct Paired {
    provider: LocalProvider,
    barrier: Barrier,
}

impl ProviderSource for Paired {
    fn read(&self) -> (LocalProvider, Option<SecureStoreError>) {
        self.barrier.wait();
        (self.provider.clone(), None)
    }
}

async fn passing_probe() -> Fake {
    serve(|request| {
        if request.path.ends_with("/models") {
            return models(MODEL);
        }
        if request.is_stream() {
            answer("ok", false)
        } else {
            probe_reply(request)
        }
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_turns_starting_together_share_one_probe() {
    let fake = passing_probe().await;
    let source = Paired {
        provider: provider(AgentLocalProviderPreset::Custom, &fake.base_url, MODEL),
        barrier: Barrier::new(2),
    };
    let agent = LocalAgent::new(Arc::new(source), client());
    let (first, second) = tokio::join!(agent.turn_has_tools(true), agent.turn_has_tools(true));
    assert!(first && second);
    let probes = fake
        .requests()
        .iter()
        .filter(|r| r.method == Method::GET)
        .count();
    assert_eq!(probes, 1);
}

#[tokio::test]
async fn the_image_probe_answer_expires_after_its_ttl() {
    for (accepts, ttl) in [(false, IMAGE_PROBE_DEGRADED_TTL), (true, IMAGE_PROBE_TTL)] {
        let fake = vision_server(accepts).await;
        let agent = LocalAgent::new(
            Arc::new(Fixed(provider(
                AgentLocalProviderPreset::Custom,
                &fake.base_url,
                MODEL,
            ))),
            client(),
        );
        let image_probes = || {
            fake.requests()
                .iter()
                .filter(|r| !r.is_stream() && r.body["max_tokens"] == 1)
                .count()
        };
        let turn = || run(&agent, LocalRunInput::new(PROMPT), Some(image_host()));
        turn().await;
        turn().await;
        assert_eq!(image_probes(), 1, "accepts={accepts}: the answer is cached");
        // Time moves only between turns, so no request sees the jump.
        tokio::time::pause();
        tokio::time::advance(ttl - Duration::from_secs(1)).await;
        tokio::time::resume();
        turn().await;
        assert_eq!(image_probes(), 1, "accepts={accepts}: still fresh");
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::time::resume();
        turn().await;
        assert_eq!(image_probes(), 2, "accepts={accepts}: expired");
    }
}
