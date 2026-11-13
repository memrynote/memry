//! Pre-release smoke check of the built-in agent engine against a real OpenAI-compatible provider
//! (FB-016), the Rust port of `apps/desktop/scripts/smoke-local-provider.ts`. It runs the app's
//! own probe and engine, so the requests match the shipped build.
//!
//! ```text
//! MEMRY_SMOKE_BASE_URL=https://api.deepseek.com/v1 MEMRY_SMOKE_MODEL=deepseek-v4-flash \
//! MEMRY_SMOKE_API_KEY=... cargo run -p memry-desktop --example smoke_local_provider
//! ```
//!
//! Prints PASS or FAIL per check and exits 1 when any check fails, 2 when the variables are
//! missing. The key is replaced by `[key]` on every line printed; no logger is installed, so
//! nothing else is written.

use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt as _;
use memry_core::api::errors::SecureStoreError;
use memry_desktop::ai::catalog::ProbeClient;
use memry_desktop::ai::local_agent::{
    AgentToolHost, BackendEvent, LocalAgent, LocalReasoningEffort, LocalRunInput, ProviderSource,
    ToolCall, ToolOutcome, ToolSpec,
};
use memry_desktop::ai::local_provider::probe::{self, ToolChoice, ToolVerdict};
use memry_desktop::ai::local_provider::{
    AgentLocalProviderPreset, AgentLocalThinking, LocalProvider,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

struct Smoke {
    base_url: String,
    model: String,
    key: Option<String>,
    failed: usize,
}

impl Smoke {
    fn say(&self, line: &str) {
        let line = match self.key.as_deref() {
            Some(key) => line.replace(key, "[key]"),
            None => line.to_owned(),
        };
        println!("{line}");
    }

    fn report(&mut self, name: &str, outcome: Result<String, String>) {
        let line = match outcome {
            Ok(detail) if detail.is_empty() => format!("PASS  {name}"),
            Ok(detail) => format!("PASS  {name}: {detail}"),
            Err(problem) => {
                self.failed += 1;
                format!("FAIL  {name}: {problem}")
            }
        };
        self.say(&line);
    }

    fn provider(&self, thinking: AgentLocalThinking) -> LocalProvider {
        LocalProvider {
            preset: AgentLocalProviderPreset::Custom,
            base_url: self.base_url.clone(),
            model: self.model.clone(),
            allow_non_loopback: true,
            thinking,
            api_key: self.key.clone().map(Zeroizing::new),
        }
    }

    async fn turn(
        &self,
        prompt: &str,
        tools: bool,
        thinking: AgentLocalThinking,
        effort: LocalReasoningEffort,
    ) -> Turn {
        let agent = LocalAgent::new(Arc::new(Source(self.provider(thinking))), client());
        let host = Arc::new(TagsHost::default());
        let mut input = LocalRunInput::new(prompt);
        input.model = Some(self.model.clone());
        input.tools_enabled = tools;
        input.reasoning_effort = effort;
        let tool_host = tools.then(|| host.clone() as Arc<dyn AgentToolHost>);
        let events: Vec<BackendEvent> = agent
            .run(input, tool_host, CancellationToken::new())
            .collect()
            .await;
        let calls = host
            .calls
            .lock()
            .map(|calls| calls.clone())
            .unwrap_or_default();
        Turn { events, calls }
    }
}

struct Turn {
    events: Vec<BackendEvent>,
    calls: Vec<String>,
}

impl Turn {
    fn text(&self, reasoning: bool) -> String {
        self.events
            .iter()
            .filter_map(|event| match event {
                BackendEvent::AssistantDelta { text } if !reasoning => Some(text.as_str()),
                BackendEvent::ReasoningDelta { text, .. } if reasoning => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn error(&self) -> Option<String> {
        self.events.iter().find_map(|event| match event {
            BackendEvent::Error { message } => Some(message.clone()),
            _ => None,
        })
    }
}

struct Source(LocalProvider);

impl ProviderSource for Source {
    fn read(&self) -> (LocalProvider, Option<SecureStoreError>) {
        (self.0.clone(), None)
    }
}

/// `vault_get_tags`, answering one tag.
#[derive(Default)]
struct TagsHost {
    calls: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl AgentToolHost for TagsHost {
    fn tool_specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "vault_get_tags".to_owned(),
            description: "List the tags of the vault with their note counts.".to_owned(),
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        }]
    }

    async fn call(&self, call: ToolCall) -> ToolOutcome {
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(call.name);
        }
        ToolOutcome::Ok {
            data: json!({ "tags": [{ "name": "memry-smoke", "count": 1 }] }),
            images: Vec::new(),
        }
    }
}

fn client() -> ProbeClient {
    let _ = rustls::crypto::ring::default_provider().install_default();
    ProbeClient::new(memry_desktop::http::builder())
}

#[tokio::main]
async fn main() -> ExitCode {
    let var = |name| {
        std::env::var(name)
            .ok()
            .filter(|value: &String| !value.is_empty())
    };
    let (Some(base_url), Some(model)) = (var("MEMRY_SMOKE_BASE_URL"), var("MEMRY_SMOKE_MODEL"))
    else {
        eprintln!(
            "Set MEMRY_SMOKE_BASE_URL and MEMRY_SMOKE_MODEL (and MEMRY_SMOKE_API_KEY if the provider needs one)."
        );
        return ExitCode::from(2);
    };
    let mut smoke = Smoke {
        base_url,
        model,
        key: var("MEMRY_SMOKE_API_KEY"),
        failed: 0,
    };
    smoke.say(&format!(
        "Smoke check: model {} at {}",
        smoke.model, smoke.base_url
    ));

    let run = probe::probe(&client(), &smoke.provider(AgentLocalThinking::Default)).await;
    let outcome = match run.tools {
        ToolVerdict::On(choice) => {
            let choice = if choice == ToolChoice::Omit {
                "omit"
            } else {
                "auto"
            };
            Ok(format!("tools on, tool_choice {choice}"))
        }
        other => Err(run
            .result
            .detail
            .unwrap_or_else(|| format!("tools {other:?}"))),
    };
    smoke.report("probe", outcome);

    let prompt = "User: Call the vault_get_tags tool once, then tell me how many tags I have.";
    let tool_turn = smoke
        .turn(
            prompt,
            true,
            AgentLocalThinking::Default,
            LocalReasoningEffort::Default,
        )
        .await;
    let outcome = if let Some(error) = tool_turn.error() {
        Err(error)
    } else if tool_turn
        .events
        .iter()
        .any(|e| matches!(e, BackendEvent::ToolsUnavailable { .. }))
    {
        Err("tools were turned off".to_owned())
    } else if !tool_turn.calls.iter().any(|name| name == "vault_get_tags") {
        Err("the model did not call vault_get_tags".to_owned())
    } else if tool_turn.text(false).trim().is_empty() {
        Err("no answer after the tool result".to_owned())
    } else {
        Ok(format!("tools called: {}", tool_turn.calls.join(", ")))
    };
    smoke.report("tool round trip", outcome);

    let reasoning = tool_turn.text(true);
    let outcome = if reasoning.trim().is_empty() {
        Err("the tool turn streamed no reasoning".to_owned())
    } else {
        Ok(format!(
            "{} characters of reasoning, kept through the tool loop",
            reasoning.chars().count()
        ))
    };
    smoke.report("reasoning", outcome);

    for (name, thinking, effort) in [
        (
            "reasoning_effort high",
            AgentLocalThinking::Default,
            LocalReasoningEffort::High,
        ),
        (
            "reasoning_effort max",
            AgentLocalThinking::Default,
            LocalReasoningEffort::Max,
        ),
        (
            "thinking disabled",
            AgentLocalThinking::Off,
            LocalReasoningEffort::Default,
        ),
    ] {
        let turn = smoke
            .turn("User: Reply with ok.", false, thinking, effort)
            .await;
        let outcome = match turn.error() {
            Some(error) => Err(error),
            None if turn.text(false).trim().is_empty() => Err("empty answer".to_owned()),
            None => Ok(String::new()),
        };
        smoke.report(&format!("accepts {name}"), outcome);
    }

    if smoke.failed == 0 {
        smoke.say("All checks passed.");
        ExitCode::SUCCESS
    } else {
        smoke.say(&format!("{} check(s) failed.", smoke.failed));
        ExitCode::FAILURE
    }
}
