//! One run of the engine: the AI SDK's `streamText` loop as `local-openai-compatible-backend.ts`
//! drove it (`run`, `mapAiSdkEvents`, `partToBackendEvent`). Each step sends the prompt and the
//! turn so far; a step that calls tools runs them on the host and the next step sends their
//! results, up to [`STEP_LIMIT`] steps. The last step runs without tools and asks for a handoff.

use std::sync::Arc;

use futures_util::{Stream, StreamExt as _, stream};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::error_body::http_error;
use super::images::{self, Assistant, CallRecord, Entry, ToolEntry, ToolOutput};
use super::ollama::{self, LineReader};
use super::openai::{self, ChunkReader};
use super::profile::{self, StepText};
use super::sse::{Frame, LineDecoder};
use super::{
    AgentToolHost, BackendEvent, HANDOFF_SYSTEM, Inner, LocalRunInput, Part, SCOPE,
    STEP_BUDGET_SYSTEM, STEP_BYTE_BUDGET, STEP_LIMIT, ToolCall, ToolError, ToolOutcome, ToolSpec,
    reasoning,
};
use crate::ai::local_provider::probe::{ToolChoice, ToolVerdict, describe};
use crate::ai::local_provider::{AgentLocalProviderPreset, LocalProvider};
use crate::ai::provider::AiProvider;
use crate::http::read_capped;

/// The largest error body read for the provider's reason.
const ERROR_BODY_CAP: usize = 64 * 1024;

pub(super) fn stream(
    inner: Arc<Inner>,
    input: LocalRunInput,
    host: Option<Arc<dyn AgentToolHost>>,
    cancel: CancellationToken,
) -> impl Stream<Item = BackendEvent> + Send + 'static {
    let turn = Turn {
        inner,
        input,
        host,
        cancel,
        state: State::Start,
        provider: None,
        model: String::new(),
        tools: None,
        history: Vec::new(),
        finished_steps: 0,
    };
    stream::unfold(turn, |mut turn| async move {
        let events = turn.advance().await?;
        Some((stream::iter(events), turn))
    })
    .flatten()
}

/// The tools of a turn whose probe passed.
struct Tools {
    host: Arc<dyn AgentToolHost>,
    specs: Vec<ToolSpec>,
    choice: ToolChoice,
}

enum Reader {
    OpenAi(ChunkReader),
    Ollama(LineReader),
}

struct Step {
    response: reqwest::Response,
    decoder: LineDecoder,
    reader: Reader,
    /// `None` on a step without tools: reply text is never searched for calls.
    text_calls: Option<StepText>,
    assistant: Assistant,
    /// Bytes of the reply so far, held to [`STEP_BYTE_BUDGET`].
    received: usize,
    /// Calls in arrival order; `Err` holds why a call cannot run.
    calls: Vec<(CallRecord, Result<(), String>)>,
}

enum State {
    Start,
    Send,
    Stream(Box<Step>),
    Tools(std::vec::IntoIter<(CallRecord, Result<(), String>)>),
    Finish,
    Done,
}

struct Turn {
    inner: Arc<Inner>,
    input: LocalRunInput,
    host: Option<Arc<dyn AgentToolHost>>,
    cancel: CancellationToken,
    state: State,
    provider: Option<LocalProvider>,
    model: String,
    tools: Option<Tools>,
    history: Vec<Entry>,
    finished_steps: usize,
}

impl Turn {
    /// The next events, or `None` once the turn is over. A cancelled turn ends without more
    /// events, as an aborted `streamText` did.
    async fn advance(&mut self) -> Option<Vec<BackendEvent>> {
        loop {
            if self.cancel.is_cancelled() {
                self.state = State::Done;
            }
            match std::mem::replace(&mut self.state, State::Done) {
                State::Done => return None,
                State::Start => {
                    let cancel = self.cancel.clone();
                    let leading = tokio::select! {
                        () = cancel.cancelled() => return None,
                        leading = self.start() => leading,
                    };
                    self.state = State::Send;
                    if !leading.is_empty() {
                        return Some(leading);
                    }
                }
                State::Send => match self.send().await {
                    Ok(step) => self.state = State::Stream(Box::new(step)),
                    Err(Some(message)) => return Some(vec![self.error(message)]),
                    Err(None) => return None,
                },
                State::Stream(mut step) => {
                    let chunk = tokio::select! {
                        () = self.cancel.cancelled() => return None,
                        chunk = step.response.chunk() => chunk,
                    };
                    let ended = matches!(chunk, Ok(None));
                    let frames = match chunk {
                        Ok(Some(bytes)) => {
                            step.received += bytes.len();
                            if step.received > STEP_BYTE_BUDGET {
                                let message = format!(
                                    "The provider's reply to one step is over {} MiB.",
                                    STEP_BYTE_BUDGET >> 20
                                );
                                return Some(vec![self.error(message)]);
                            }
                            step.decoder.push(&bytes)
                        }
                        Ok(None) => step.decoder.finish(),
                        Err(error) => return Some(vec![self.error(describe(&error))]),
                    };
                    let frames = match frames {
                        Ok(frames) => frames,
                        Err(error) => return Some(vec![self.error(error.to_string())]),
                    };
                    let mut events = Vec::new();
                    for frame in frames {
                        let parts = match (&mut step.reader, frame) {
                            (_, Frame::Done) => continue,
                            (Reader::OpenAi(reader), Frame::Data(data)) => reader.chunk(&data),
                            (Reader::Ollama(reader), Frame::Data(data)) => reader.line(&data),
                        };
                        self.apply(&mut step, parts, &mut events);
                    }
                    if ended {
                        self.end_step(*step, &mut events);
                    } else {
                        self.state = State::Stream(step);
                    }
                    if !events.is_empty() {
                        return Some(events);
                    }
                }
                State::Tools(mut calls) => {
                    let Some((call, ready)) = calls.next() else {
                        self.finished_steps += 1;
                        self.state = if self.finished_steps < STEP_LIMIT {
                            State::Send
                        } else {
                            State::Finish
                        };
                        continue;
                    };
                    let event = self.run_tool(call, ready).await?;
                    self.state = State::Tools(calls);
                    return Some(vec![event]);
                }
                State::Finish => {
                    let mut events = Vec::new();
                    if self.finished_steps >= STEP_LIMIT {
                        events.push(BackendEvent::StepLimit);
                    }
                    events.push(BackendEvent::MessageStop);
                    return Some(events);
                }
            }
        }
    }

    /// Reads the provider and decides the tools; a tools-off verdict is the turn's first event.
    async fn start(&mut self) -> Vec<BackendEvent> {
        let provider = self.inner.provider().await;
        self.model = self
            .input
            .model
            .clone()
            .filter(|model| !model.is_empty())
            .unwrap_or_else(|| provider.model.clone());
        let mut leading = Vec::new();
        if let Some(host) = self.host.clone().filter(|_| self.input.tools_enabled) {
            match self
                .inner
                .probes
                .for_run(&self.inner.client, &provider)
                .await
            {
                ToolVerdict::On(choice) => {
                    let specs = host.tool_specs();
                    self.tools = Some(Tools {
                        host,
                        specs,
                        choice,
                    });
                }
                ToolVerdict::Off { reason, detail } => {
                    leading.push(BackendEvent::ToolsUnavailable { reason, detail });
                }
                ToolVerdict::Unreachable | ToolVerdict::Transient => {}
            }
        }
        self.provider = Some(provider);
        leading
    }

    /// Sends the next step. `Err(None)`: cancelled.
    async fn send(&mut self) -> Result<Step, Option<String>> {
        let Some(provider) = self.provider.clone() else {
            return Err(Some("the local provider was not read".to_owned()));
        };
        let base = provider
            .endpoint()
            .map_err(|error| Some(error.to_string()))?;
        let handoff = self.tools.is_some() && self.finished_steps == STEP_LIMIT - 1;
        let (system, tools) = match &self.tools {
            Some(_) if handoff => (Some(HANDOFF_SYSTEM), None),
            Some(tools) => (Some(STEP_BUDGET_SYSTEM), Some(tools)),
            None => (None, None),
        };
        let accepts_images = self.tools.is_some()
            && images::has_tool_images(&self.history)
            && tokio::select! {
                () = self.cancel.cancelled() => return Err(None),
                accepts = self.inner.probes.accepts_images(&self.inner.client, &provider, &self.model) => accepts,
            };
        let messages = images::messages(system, &self.input.prompt, &self.history, accepts_images);
        let specs = tools.map(|tools| tools.specs.as_slice());
        let choice = tools.and_then(|tools| profile::tool_choice(tools.choice));
        let ollama = provider.preset == AgentLocalProviderPreset::Ollama;
        let (url, body, reader) = if ollama {
            let body = ollama::request_body(&self.model, &messages, specs, choice);
            (
                ollama::chat_url(base),
                body,
                Reader::Ollama(LineReader::default()),
            )
        } else {
            let reasoning =
                reasoning::openai_fields(self.input.reasoning_effort, provider.thinking);
            let body = openai::request_body(&self.model, &messages, specs, choice, reasoning);
            let url = format!("{base}/chat/completions");
            (url, body, Reader::OpenAi(ChunkReader::default()))
        };
        let headers = AiProvider::Custom
            .auth_headers(provider.key())
            .map_err(|error| Some(error.to_string()))?;
        let request = self
            .inner
            .client
            .http()
            .post(url)
            .headers(headers)
            .json(&body);
        let response = tokio::select! {
            () = self.cancel.cancelled() => return Err(None),
            response = request.send() => response.map_err(|error| Some(describe(&error)))?,
        };
        let status = response.status();
        if !status.is_success() {
            let body = tokio::select! {
                () = self.cancel.cancelled() => return Err(None),
                body = read_capped(response, ERROR_BODY_CAP) => body.unwrap_or_default(),
            };
            let body = provider.redact(String::from_utf8_lossy(&body).into_owned());
            return Err(Some(http_error(status, &body, &provider)));
        }
        let decoder = if ollama {
            LineDecoder::ndjson()
        } else {
            LineDecoder::sse()
        };
        let text_calls =
            tools.map(|tools| StepText::new(tools.specs.iter().map(|spec| spec.name.clone())));
        Ok(Step {
            response,
            decoder,
            reader,
            text_calls: if handoff {
                Some(StepText::new(Vec::new()))
            } else {
                text_calls
            },
            assistant: Assistant::default(),
            received: 0,
            calls: Vec::new(),
        })
    }

    fn apply(&self, step: &mut Step, parts: Vec<Part>, events: &mut Vec<BackendEvent>) {
        for part in parts {
            match part {
                Part::Text(text) => {
                    let pieces = match &mut step.text_calls {
                        Some(text_calls) => text_calls.push(&text),
                        None => vec![text],
                    };
                    for piece in pieces.into_iter().filter(|piece| !piece.is_empty()) {
                        step.assistant.text.push_str(&piece);
                        events.push(BackendEvent::AssistantDelta { text: piece });
                    }
                }
                Part::ReasoningStart => {
                    self.end_text(step, events);
                    events.push(BackendEvent::ReasoningDelta {
                        text: String::new(),
                        starts_block: true,
                    });
                }
                Part::Reasoning(text) => {
                    step.assistant.reasoning.push_str(&text);
                    events.push(BackendEvent::ReasoningDelta {
                        text,
                        starts_block: false,
                    });
                }
                Part::Call { id, name, input } => self.add_call(step, id, name, &input, events),
                Part::Error(message) => events.push(BackendEvent::Error {
                    message: self.redact(message),
                }),
            }
        }
    }

    /// `text-end`: held text is released, then the calls found in the text.
    fn end_text(&self, step: &mut Step, events: &mut Vec<BackendEvent>) {
        let Some(text_calls) = &mut step.text_calls else {
            return;
        };
        for piece in text_calls
            .end()
            .into_iter()
            .filter(|piece| !piece.is_empty())
        {
            step.assistant.text.push_str(&piece);
            events.push(BackendEvent::AssistantDelta { text: piece });
        }
        for call in text_calls.take_calls() {
            let id = uuid::Uuid::new_v4().to_string();
            self.add_call(step, id, call.tool_name, &call.input, events);
        }
    }

    /// Records a call and reports it. Arguments that are not JSON, or a tool this step did not
    /// offer, fail the call without reaching the host (the AI SDK's `tool-error`).
    fn add_call(
        &self,
        step: &mut Step,
        id: String,
        name: String,
        input: &str,
        events: &mut Vec<BackendEvent>,
    ) {
        let parsed = if input.trim().is_empty() {
            Ok(json!({}))
        } else {
            serde_json::from_str::<Value>(input)
        };
        // The handoff step offers no tools.
        let offered: Vec<&str> = match &self.tools {
            Some(tools) if self.finished_steps < STEP_LIMIT - 1 => {
                tools.specs.iter().map(|spec| spec.name.as_str()).collect()
            }
            _ => Vec::new(),
        };
        let (input, ready) = match parsed {
            Ok(input) if offered.contains(&name.as_str()) => (input, Ok(())),
            Ok(input) => (
                input,
                Err(format!(
                    "Model tried to call unavailable tool '{name}'. Available tools: {}.",
                    offered.join(", ")
                )),
            ),
            Err(error) => (
                Value::String(input.to_owned()),
                Err(format!("Invalid input for tool {name}: {error}")),
            ),
        };
        events.push(BackendEvent::ToolUse {
            tool_use_id: id.clone(),
            name: name.clone(),
            args: input.clone(),
        });
        step.calls.push((CallRecord { id, name, input }, ready));
    }

    fn end_step(&mut self, mut step: Step, events: &mut Vec<BackendEvent>) {
        let parts = match &mut step.reader {
            Reader::OpenAi(reader) => reader.end(),
            Reader::Ollama(_) => Vec::new(),
        };
        self.end_text(&mut step, events);
        self.apply(&mut step, parts, events);
        step.assistant.calls = step.calls.iter().map(|(call, _)| call.clone()).collect();
        self.history.push(Entry::Assistant(step.assistant));
        self.state = if step.calls.is_empty() {
            self.finished_steps += 1;
            State::Finish
        } else {
            State::Tools(step.calls.into_iter())
        };
    }

    /// Runs one call on the host (`None`: cancelled) and records its result for the next step.
    async fn run_tool(
        &mut self,
        call: CallRecord,
        ready: Result<(), String>,
    ) -> Option<BackendEvent> {
        let (event, output) = match (ready, self.tools.as_ref()) {
            (Ok(()), Some(tools)) => {
                let request = ToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    input: call.input.clone(),
                };
                let outcome = tokio::select! {
                    () = self.cancel.cancelled() => return None,
                    outcome = tools.host.call(request) => outcome,
                };
                tool_result(&call.id, outcome)
            }
            (ready, _) => {
                let message = ready.err().unwrap_or_else(|| {
                    format!("Model tried to call unavailable tool '{}'.", call.name)
                });
                (
                    BackendEvent::ToolResult {
                        tool_use_id: call.id.clone(),
                        ok: false,
                        data: None,
                        error: Some(ToolError {
                            code: "TOOL_ERROR".to_owned(),
                            message: message.clone(),
                        }),
                    },
                    ToolOutput::ErrorText(message),
                )
            }
        };
        self.history.push(Entry::Tool(ToolEntry {
            call_id: call.id,
            tool_name: call.name,
            output,
        }));
        Some(event)
    }

    /// An error ends the turn: the AI SDK reports a failed provider call as a stream part and
    /// the run exits 1.
    fn error(&mut self, message: String) -> BackendEvent {
        self.state = State::Done;
        tracing::warn!(scope = SCOPE, model = %self.model, "local agent step failed: {}", self.redact(message.clone()));
        BackendEvent::Error {
            message: self.redact(message),
        }
    }

    /// A provider may echo the authorization header in its error body.
    fn redact(&self, message: String) -> String {
        match &self.provider {
            Some(provider) => provider.redact(message),
            None => message,
        }
    }
}

/// The event and the model's copy of a host result (`toolModelOutput` of `tool-bridge.ts`).
fn tool_result(call_id: &str, outcome: ToolOutcome) -> (BackendEvent, ToolOutput) {
    match outcome {
        ToolOutcome::Ok { data, images } => {
            let result = json!({ "ok": true, "data": data });
            let mut shown = result.clone();
            if !images.is_empty() {
                shown["images"] = images
                    .iter()
                    .map(|image| json!({ "type": "image", "data": image.data, "mimeType": image.mime_type }))
                    .collect();
            }
            let output = if images.is_empty() {
                ToolOutput::Json(result)
            } else {
                ToolOutput::WithImages {
                    text: result.to_string(),
                    images,
                }
            };
            let event = BackendEvent::ToolResult {
                tool_use_id: call_id.to_owned(),
                ok: true,
                data: Some(shown),
                error: None,
            };
            (event, output)
        }
        ToolOutcome::Err(error) => {
            let result = json!({ "ok": false, "error": error });
            let event = BackendEvent::ToolResult {
                tool_use_id: call_id.to_owned(),
                ok: false,
                data: Some(result.clone()),
                error: Some(error),
            };
            (event, ToolOutput::Json(result))
        }
    }
}
