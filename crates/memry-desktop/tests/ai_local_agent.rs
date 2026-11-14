//! The local agent engine against fake providers (#3539): the four recorded text tool-call
//! replies of Electron's `fixtures/text-tool-calls`, the DeepSeek fake, the step limit, tool
//! images, the Ollama request and the probe cache. Each test pins a behavior of
//! `local-openai-compatible-backend.ts` and its `__tests__`.

use std::sync::{Arc, Mutex};

use axum::http::{Method, StatusCode};
use futures_util::StreamExt as _;
use memry_core::api::errors::SecureStoreError;
use memry_desktop::ai::local_agent::images::TOOL_IMAGE_NOT_SENT;
use memry_desktop::ai::local_agent::{
    AgentToolHost, BackendEvent, LocalAgent, LocalReasoningEffort, LocalRunInput, ProviderSource,
    STEP_LIMIT, ToolCall, ToolImage, ToolOutcome, ToolSpec,
};
use memry_desktop::ai::local_provider::probe::AgentToolsOffReason;
use memry_desktop::ai::local_provider::{
    AgentLocalProviderPreset, AgentLocalThinking, LocalProvider,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::local_agent_server::{
    DEEPSEEK_MODEL, DEEPSEEK_REASONING, DEEPSEEK_REPLY, DeepSeek, DeepSeekTools, Fake, MODEL,
    NDJSON, Recorded, SSE, answer, chunk, client, json_reply, models, probe_reply, serve, sse,
};

pub(crate) const PROMPT: &str = "User: list my tags";

pub(crate) struct Fixed(pub(crate) LocalProvider);

impl ProviderSource for Fixed {
    fn read(&self) -> (LocalProvider, Option<SecureStoreError>) {
        (self.0.clone(), None)
    }
}

pub(crate) fn provider(
    preset: AgentLocalProviderPreset,
    base_url: &str,
    model: &str,
) -> LocalProvider {
    LocalProvider {
        preset,
        base_url: base_url.to_owned(),
        model: model.to_owned(),
        allow_non_loopback: false,
        thinking: AgentLocalThinking::Default,
        api_key: None,
    }
}

pub(crate) fn agent(provider: LocalProvider) -> LocalAgent {
    LocalAgent::new(Arc::new(Fixed(provider)), client())
}

/// The vault tools a turn offers; every call answers `outcome`.
pub(crate) struct Host {
    calls: Mutex<Vec<ToolCall>>,
    outcome: ToolOutcome,
}

impl Host {
    pub(crate) fn new(outcome: ToolOutcome) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            outcome,
        })
    }

    pub(crate) fn tags() -> Arc<Self> {
        Self::new(ToolOutcome::Ok {
            data: json!({ "tags": [] }),
            images: Vec::new(),
        })
    }

    fn calls(&self) -> Vec<ToolCall> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl AgentToolHost for Host {
    fn tool_specs(&self) -> Vec<ToolSpec> {
        ["vault_get_tags", "vault_view_file"]
            .into_iter()
            .map(|name| ToolSpec {
                name: name.to_owned(),
                description: format!("{name} tool"),
                input_schema: json!({ "type": "object", "properties": {} }),
            })
            .collect()
    }

    async fn call(&self, call: ToolCall) -> ToolOutcome {
        self.calls.lock().unwrap().push(call);
        self.outcome.clone()
    }
}

pub(crate) async fn run(
    agent: &LocalAgent,
    input: LocalRunInput,
    host: Option<Arc<Host>>,
) -> Vec<BackendEvent> {
    let host = host.map(|host| host as Arc<dyn AgentToolHost>);
    agent
        .run(input, host, CancellationToken::new())
        .collect()
        .await
}

fn text(events: &[BackendEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            BackendEvent::AssistantDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn reasoning(events: &[BackendEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            BackendEvent::ReasoningDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// The turn's own chat requests (the probes never carry the prompt).
pub(crate) fn turn_requests(fake: &Fake) -> Vec<Recorded> {
    fake.requests()
        .into_iter()
        .filter(|request| request.method == Method::POST && request.mentions(PROMPT))
        .collect()
}

fn system_text(request: &Recorded) -> String {
    request
        .messages()
        .iter()
        .filter(|m| m["role"] == "system")
        .map(|m| m["content"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `replayFetch` of `local-openai-compatible-text-calls.test.ts`: the probe passes natively, the
/// turn's first step replays the recording, the step after the tool result answers.
async fn replay(fixture: &'static str) -> Fake {
    let path = format!(
        "{}/tests/fixtures/local_agent/{fixture}",
        env!("CARGO_MANIFEST_DIR")
    );
    let recorded = std::fs::read_to_string(path).unwrap();
    let ollama = fixture.ends_with(".ndjson");
    serve(move |request| {
        if request.path.ends_with("/models") {
            return models(MODEL);
        }
        let chat_step = request.path.ends_with("/api/chat")
            || (request.is_stream() && request.body.get("tools").is_some());
        if !chat_step {
            return if request.is_stream() {
                answer("ok", false)
            } else {
                probe_reply(request)
            };
        }
        if request.has_tool_message() {
            return answer(DEEPSEEK_REPLY, ollama);
        }
        (
            StatusCode::OK,
            if ollama { NDJSON } else { SSE },
            recorded.clone(),
        )
    })
    .await
}

#[tokio::test]
async fn local_agent_runs_the_text_tool_call_of_each_recorded_server() {
    for (preset, fixture) in [
        (AgentLocalProviderPreset::LlamaCpp, "llama_cpp.sse"),
        (AgentLocalProviderPreset::LmStudio, "lm_studio.sse"),
        (AgentLocalProviderPreset::Custom, "custom.sse"),
        (AgentLocalProviderPreset::Ollama, "ollama.ndjson"),
    ] {
        let fake = replay(fixture).await;
        let host = Host::tags();
        let events = run(
            &agent(provider(preset, &fake.base_url, MODEL)),
            LocalRunInput::new(PROMPT),
            Some(host.clone()),
        )
        .await;

        let calls = host.calls();
        assert_eq!(calls.len(), 1, "{fixture}");
        assert_eq!(
            (calls[0].name.as_str(), &calls[0].input),
            ("vault_get_tags", &json!({})),
            "{fixture}"
        );
        let text = text(&events);
        assert!(!text.contains("tool_call"), "{fixture}: {text}");
        assert!(text.contains(DEEPSEEK_REPLY), "{fixture}: {text}");
        assert_eq!(events.last(), Some(&BackendEvent::MessageStop), "{fixture}");
        // The call goes back to the server as a structured call, not as reply text.
        let last = turn_requests(&fake).pop().unwrap();
        let assistant = last
            .messages()
            .into_iter()
            .find(|m| m["role"] == "assistant")
            .unwrap();
        assert_eq!(
            assistant["tool_calls"][0]["function"]["name"], "vault_get_tags",
            "{fixture}"
        );
    }
}

#[tokio::test]
async fn local_agent_a_quoted_call_of_an_unknown_tool_stays_text() {
    let quoted = "<tool_call>{\"name\": \"delete_everything\", \"arguments\": {}}</tool_call>";
    let fake = serve(move |request| {
        if request.path.ends_with("/models") {
            return models(MODEL);
        }
        if !request.is_stream() {
            return probe_reply(request);
        }
        sse(&[chunk(
            json!({ "role": "assistant", "content": quoted }),
            Some("stop"),
        )])
    })
    .await;
    let host = Host::tags();
    let events = run(
        &agent(provider(
            AgentLocalProviderPreset::Custom,
            &fake.base_url,
            MODEL,
        )),
        LocalRunInput::new(PROMPT),
        Some(host.clone()),
    )
    .await;
    assert_eq!(text(&events), quoted);
    assert!(host.calls().is_empty());
}

pub(crate) async fn deepseek(server: DeepSeek, thinking: AgentLocalThinking) -> (Fake, LocalAgent) {
    let fake = serve(move |request| server.handle(request)).await;
    let mut settings = provider(
        AgentLocalProviderPreset::Custom,
        &fake.base_url,
        DEEPSEEK_MODEL,
    );
    settings.thinking = thinking;
    (fake, agent(settings))
}

#[tokio::test]
async fn deepseek_reasoning_content_is_streamed_and_sent_back_without_tool_choice() {
    let (fake, agent) = deepseek(DeepSeek::default(), AgentLocalThinking::Default).await;
    let host = Host::tags();
    let events = run(&agent, LocalRunInput::new(PROMPT), Some(host.clone())).await;

    assert_eq!(
        reasoning(&events),
        format!("{DEEPSEEK_REASONING}{DEEPSEEK_REASONING}")
    );
    let others: Vec<&BackendEvent> = events
        .iter()
        .filter(|e| !matches!(e, BackendEvent::ReasoningDelta { .. }))
        .collect();
    assert_eq!(
        others,
        [
            &BackendEvent::ToolUse {
                tool_use_id: "call_1".into(),
                name: "vault_get_tags".into(),
                args: json!({})
            },
            &BackendEvent::ToolResult {
                tool_use_id: "call_1".into(),
                ok: true,
                data: Some(json!({ "ok": true, "data": { "tags": [] } })),
                error: None
            },
            &BackendEvent::AssistantDelta {
                text: DEEPSEEK_REPLY.into()
            },
            &BackendEvent::MessageStop,
        ]
    );
    // The probe's named tool_choice got HTTP 400 in thinking mode, so no turn request sends one.
    let turn = turn_requests(&fake);
    assert_eq!(turn.len(), 2);
    assert!(
        turn.iter()
            .all(|request| request.body.get("tool_choice").is_none())
    );
    let assistant = turn[1]
        .messages()
        .into_iter()
        .find(|m| m["role"] == "assistant")
        .unwrap();
    assert_eq!(assistant["reasoning_content"], DEEPSEEK_REASONING);
    assert!(
        fake.requests()
            .iter()
            .any(|r| r.status_rejected_named_choice())
    );
}

#[tokio::test]
async fn deepseek_without_function_calling_flags_the_turn_and_runs_no_tool() {
    let dsml = "<｜DSML｜function_calls>vault_get_tags</｜DSML｜function_calls>";
    let server = DeepSeek {
        tools: DeepSeekTools::Reject,
        reply: dsml.into(),
        ..DeepSeek::default()
    };
    let (fake, agent) = deepseek(server, AgentLocalThinking::Default).await;
    let host = Host::tags();
    let events = run(&agent, LocalRunInput::new(PROMPT), Some(host.clone())).await;

    assert!(matches!(
        &events[0],
        BackendEvent::ToolsUnavailable {
            reason: AgentToolsOffReason::ToolsRejected,
            ..
        }
    ));
    assert_eq!(text(&events), dsml);
    assert!(host.calls().is_empty());
    let turn = turn_requests(&fake);
    assert_eq!(turn.len(), 1);
    assert!(turn[0].body.get("tools").is_none());
}

#[tokio::test]
async fn deepseek_accepts_each_reasoning_pick_and_thinking_off_streams_no_reasoning() {
    for effort in [LocalReasoningEffort::High, LocalReasoningEffort::Max] {
        let (fake, agent) = deepseek(DeepSeek::default(), AgentLocalThinking::Default).await;
        let mut input = LocalRunInput::new(PROMPT);
        input.reasoning_effort = effort;
        let events = run(&agent, input, None).await;
        assert_eq!(text(&events), DEEPSEEK_REPLY);
        let sent = &turn_requests(&fake)[0].body;
        assert_eq!(sent["reasoning_effort"], json!(effort));
        assert!(sent.get("thinking").is_none());
    }
    let (fake, agent) = deepseek(DeepSeek::default(), AgentLocalThinking::Off).await;
    let events = run(&agent, LocalRunInput::new(PROMPT), None).await;
    assert_eq!(text(&events), DEEPSEEK_REPLY);
    assert_eq!(reasoning(&events), "");
    let sent = &turn_requests(&fake)[0].body;
    assert_eq!(sent["thinking"], json!({ "type": "disabled" }));
    assert!(sent.get("reasoning_effort").is_none());
}

#[tokio::test]
async fn the_step_limit_ends_a_tool_loop_with_a_tool_free_handoff_and_reasoning_kept() {
    let server = DeepSeek {
        tools: DeepSeekTools::Always,
        ..DeepSeek::default()
    };
    let (fake, agent) = deepseek(server, AgentLocalThinking::Default).await;
    let host = Host::tags();
    let events = run(&agent, LocalRunInput::new(PROMPT), Some(host.clone())).await;

    let turn = turn_requests(&fake);
    assert_eq!(turn.len(), STEP_LIMIT);
    assert_eq!(host.calls().len(), STEP_LIMIT - 1);
    assert!(system_text(&turn[0]).contains("24 model calls"));
    assert!(turn[STEP_LIMIT - 2].body.get("tools").is_some());
    let last = &turn[STEP_LIMIT - 1];
    assert!(last.body.get("tools").is_none());
    assert!(last.body.get("tool_choice").is_none());
    assert!(system_text(last).contains("tools are off"));
    assert!(system_text(last).contains("what is done, what is left"));
    // DeepSeek answered every step, so none dropped the reasoning of an earlier tool call.
    assert_eq!(text(&events), DEEPSEEK_REPLY);
    let kinds: Vec<&BackendEvent> = events.iter().rev().take(2).collect();
    assert_eq!(
        kinds,
        [&BackendEvent::MessageStop, &BackendEvent::StepLimit]
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| **e == BackendEvent::StepLimit)
            .count(),
        1
    );
}

#[tokio::test]
async fn a_turn_that_answers_before_the_cap_reports_no_limit() {
    let (fake, agent) = deepseek(DeepSeek::default(), AgentLocalThinking::Default).await;
    let events = run(&agent, LocalRunInput::new(PROMPT), Some(Host::tags())).await;
    assert!(
        turn_requests(&fake)
            .iter()
            .all(|request| request.body.get("tools").is_some())
    );
    assert!(!events.contains(&BackendEvent::StepLimit));
}

trait RejectedChoice {
    fn status_rejected_named_choice(&self) -> bool;
}

impl RejectedChoice for Recorded {
    /// The probe's first tool request: a named `tool_choice`, which thinking mode refuses.
    fn status_rejected_named_choice(&self) -> bool {
        self.body["tool_choice"]["function"]["name"] == "memry_probe_echo"
    }
}

pub(crate) const IMAGE: &str = "iVBORw0KGgo=";

/// A provider whose model calls `vault_view_file` once; `accepts_images` answers the one-token
/// image probe.
pub(crate) async fn vision_server(accepts_images: bool) -> Fake {
    serve(move |request| {
        if request.path.ends_with("/models") {
            return models(MODEL);
        }
        let image = request.body["messages"].to_string().contains("image_url");
        if !request.is_stream() && image && !request.mentions(PROMPT) {
            return if accepts_images {
                json_reply(StatusCode::OK, json!({ "choices": [{ "message": { "role": "assistant", "content": "ok" } }] }))
            } else {
                json_reply(StatusCode::BAD_REQUEST, json!({ "error": { "message": "image input is not supported" } }))
            };
        }
        if !request.is_stream() {
            return probe_reply(request);
        }
        if !request.mentions(PROMPT) {
            return answer("ok", false);
        }
        if request.has_tool_message() {
            return answer("It says hello.", false);
        }
        let call = json!({ "index": 0, "id": "call_1", "type": "function", "function": { "name": "vault_view_file", "arguments": "{}" } });
        sse(&[chunk(json!({ "tool_calls": [call] }), Some("tool_calls"))])
    })
    .await
}

/// A host whose every call returns one image.
pub(crate) fn image_host() -> Arc<Host> {
    Host::new(ToolOutcome::Ok {
        data: json!({ "id": "file-1", "width": 1, "height": 1 }),
        images: vec![ToolImage {
            data: IMAGE.into(),
            mime_type: "image/png".into(),
        }],
    })
}

async fn vision(accepts_images: bool) -> (Fake, Vec<BackendEvent>) {
    let fake = vision_server(accepts_images).await;
    let events = run(
        &agent(provider(
            AgentLocalProviderPreset::Custom,
            &fake.base_url,
            MODEL,
        )),
        LocalRunInput::new(PROMPT),
        Some(image_host()),
    )
    .await;
    (fake, events)
}

#[tokio::test]
async fn a_tool_image_goes_after_the_tool_result_to_a_model_that_takes_images() {
    let (fake, events) = vision(true).await;
    let continuation = turn_requests(&fake).pop().unwrap();
    let messages = continuation.messages();
    let tool = messages.iter().position(|m| m["role"] == "tool").unwrap();
    let content = messages[tool]["content"].as_str().unwrap();
    assert!(!content.contains(IMAGE));
    assert_eq!(
        serde_json::from_str::<Value>(content).unwrap(),
        json!({ "ok": true, "data": { "id": "file-1", "width": 1, "height": 1 } })
    );
    assert_eq!(
        messages[tool + 1],
        json!({ "role": "user", "content": [
            { "type": "text", "text": "Image returned by vault_view_file (call call_1):" },
            { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{IMAGE}") } },
        ] })
    );
    assert_eq!(text(&events), "It says hello.");
    let probes: Vec<Recorded> = fake
        .requests()
        .into_iter()
        .filter(|r| !r.is_stream() && r.body["max_tokens"] == 1)
        .collect();
    assert_eq!(probes.len(), 1, "the image probe asks for one token");
}

#[tokio::test]
async fn a_text_only_model_is_told_the_image_was_not_sent() {
    let (fake, events) = vision(false).await;
    let continuation = turn_requests(&fake).pop().unwrap();
    assert!(!continuation.body.to_string().contains(IMAGE));
    let tool = continuation
        .messages()
        .into_iter()
        .find(|m| m["role"] == "tool")
        .unwrap();
    assert!(
        tool["content"]
            .as_str()
            .unwrap()
            .ends_with(TOOL_IMAGE_NOT_SENT)
    );
    assert_eq!(text(&events), "It says hello.");
}

#[tokio::test]
async fn ollama_uses_the_native_api_with_num_ctx_and_no_reasoning_fields() {
    let fake = serve(|request| {
        if request.path.ends_with("/models") {
            return models(MODEL);
        }
        if request.path.ends_with("/api/chat") {
            return answer("ok", true);
        }
        if request.is_stream() {
            answer("ok", false)
        } else {
            probe_reply(request)
        }
    })
    .await;
    let mut settings = provider(AgentLocalProviderPreset::Ollama, &fake.base_url, MODEL);
    settings.thinking = AgentLocalThinking::Off;
    settings.api_key = Some(Zeroizing::new("sk-ollama-test".into()));
    let mut input = LocalRunInput::new(PROMPT);
    input.reasoning_effort = LocalReasoningEffort::Max;
    let events = run(&agent(settings), input, Some(Host::tags())).await;

    assert_eq!(text(&events), "ok");
    let turn = turn_requests(&fake);
    assert_eq!(turn.len(), 1);
    assert_eq!(turn[0].path, "/api/chat");
    assert_eq!(turn[0].auth.as_deref(), Some("Bearer sk-ollama-test"));
    let body = &turn[0].body;
    assert_eq!(body["options"], json!({ "num_ctx": 8192 }));
    assert_eq!(body["think"], json!(false));
    assert!(body.get("reasoning_effort").is_none() && body.get("thinking").is_none());
    assert_eq!(
        body["tools"][0]["function"]["parameters"]["required"],
        json!([])
    );
}

#[tokio::test]
async fn a_rejected_chat_request_is_an_error_event_without_the_key() {
    let server = DeepSeek {
        efforts: Vec::new(),
        echo_auth: true,
        ..DeepSeek::default()
    };
    let fake = serve(move |request| server.handle(request)).await;
    let mut settings = provider(
        AgentLocalProviderPreset::Custom,
        &fake.base_url,
        DEEPSEEK_MODEL,
    );
    settings.api_key = Some(Zeroizing::new("sk-echoed-test".into()));
    let mut input = LocalRunInput::new(PROMPT);
    input.reasoning_effort = LocalReasoningEffort::High;
    let events = run(&agent(settings), input, None).await;
    assert_eq!(
        events,
        [BackendEvent::Error {
            message: "reasoning_effort high is not supported (Bearer [key])".into()
        }]
    );
}

#[tokio::test]
async fn the_probe_runs_once_per_configuration_and_a_transient_error_keeps_tools_on() {
    let failing = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let fail = failing.clone();
    let fake = serve(move |request| {
        if request.path.ends_with("/models") {
            return models(MODEL);
        }
        if !request.is_stream() {
            if fail.load(std::sync::atomic::Ordering::SeqCst) {
                return json_reply(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({ "error": { "message": "busy" } }),
                );
            }
            return probe_reply(request);
        }
        if request.mentions(PROMPT) {
            answer("done", false)
        } else {
            answer("ok", false)
        }
    })
    .await;
    let agent = agent(provider(
        AgentLocalProviderPreset::Custom,
        &fake.base_url,
        MODEL,
    ));
    let probes = || {
        fake.requests()
            .iter()
            .filter(|r| r.method == Method::GET)
            .count()
    };

    // A 503 says nothing about tools: they stay on and nothing is cached.
    assert!(agent.turn_has_tools(true).await);
    let events = run(&agent, LocalRunInput::new(PROMPT), Some(Host::tags())).await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, BackendEvent::ToolsUnavailable { .. }))
    );
    assert_eq!(probes(), 1, "the run reused the probe its turn reserved");
    assert!(turn_requests(&fake)[0].body.get("tools").is_some());

    failing.store(false, std::sync::atomic::Ordering::SeqCst);
    assert!(agent.turn_has_tools(true).await);
    assert_eq!(probes(), 2, "a transient answer was not cached");
    run(&agent, LocalRunInput::new(PROMPT), Some(Host::tags())).await;
    assert!(agent.turn_has_tools(true).await);
    assert_eq!(probes(), 2, "a pass is cached");
    assert!(!agent.turn_has_tools(false).await);
    assert!(agent.probe_capabilities().await.tools_enabled);
    assert_eq!(probes(), 3, "the settings screen always probes live");
}

#[tokio::test]
async fn a_structured_completion_reads_the_fenced_object_and_a_cancelled_run_stays_silent() {
    #[derive(serde::Deserialize, Debug, PartialEq)]
    struct Title {
        title: String,
    }
    let fake = serve(|_| answer("```json\n{\"title\": \"Tags\"}\n```", false)).await;
    let agent = agent(provider(
        AgentLocalProviderPreset::Custom,
        &fake.base_url,
        MODEL,
    ));
    let title: Title = agent.complete_structured("Name it", None).await.unwrap();
    assert_eq!(
        title,
        Title {
            title: "Tags".into()
        }
    );
    assert_eq!(fake.requests()[0].body.get("tools"), None);

    let cancel = CancellationToken::new();
    cancel.cancel();
    let events: Vec<BackendEvent> = agent
        .run(LocalRunInput::new(PROMPT), None, cancel)
        .collect()
        .await;
    assert!(events.is_empty());
}
