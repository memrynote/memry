//! One tool call from arguments to MCP result: the per-tool path of Electron's `mcp/server.ts`
//! `createMcpServer` and `tools/write-tools.ts` `gateOrDeny`. The order is lookup, validation
//! (with defaults), the write gate for a write tool, the host, then the reply cut and rendering.
//! The built-in engine calls [`ToolRegistry::call`] in process, so both paths share it.

use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use rmcp::model::{CallToolResult, ContentBlock, JsonObject};
use serde_json::{Map, Value};

use super::errors::{ToolError, ToolErrorCode, error_text};
use super::reply_cap::{ReplyCap, cap_reply};
use super::schemas::{Catalog, ToolClass, ToolSpec, catalog};
use super::session::CallContext;

const NO_GATE: &str =
    "Write tools require an active memrynote Agent conversation with an approval gate.";
const NO_GRANT: &str = "Write tools require an in-flight memrynote Agent turn; no X-Memry-Turn \
                        capability was presented.";
const DENIED: &str = "User denied request.";

/// What a tool handler returns: the reply value (`Null` for a handler that returns nothing),
/// an image part the model can look at, and the cut its reply is held to.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolReply {
    pub value: Value,
    pub image: Option<ToolImage>,
    pub cap: Option<ReplyCap>,
}

impl ToolReply {
    pub fn new(value: Value) -> Self {
        Self {
            value,
            ..Self::default()
        }
    }
}

/// An MCP image part: base64 bytes and their MIME type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolImage {
    pub data: String,
    pub mime_type: String,
}

/// Runs a validated tool call against the vault: the Rust twin of Electron's `tools/handles.ts`.
#[async_trait]
pub trait VaultToolHost: Send + Sync {
    async fn call(
        &self,
        tool: &str,
        args: Value,
        ctx: &CallContext,
    ) -> Result<ToolReply, ToolError>;
}

/// A write call waiting on the user, as Electron's `GateContext`.
pub struct GateRequest<'a> {
    pub write_grant: &'a str,
    pub window: Option<&'a str>,
    pub tool: &'a str,
    pub args: &'a Value,
}

pub enum GateDecision {
    /// `args`, when given, are the user's edit and replace the parsed ones.
    Approved {
        args: Option<Value>,
    },
    Denied {
        reason: Option<String>,
    },
}

/// Decides a write call: verifies the turn capability and asks the user.
#[async_trait]
pub trait WriteGate: Send + Sync {
    async fn decide(&self, request: GateRequest<'_>) -> GateDecision;
}

pub struct ToolRegistry {
    catalog: &'static Catalog,
    host: Arc<dyn VaultToolHost>,
    gate: RwLock<Option<Arc<dyn WriteGate>>>,
}

impl ToolRegistry {
    pub fn new(host: Arc<dyn VaultToolHost>) -> Self {
        Self {
            catalog: catalog(),
            host,
            gate: RwLock::new(None),
        }
    }

    pub fn catalog(&self) -> &'static Catalog {
        self.catalog
    }

    /// Installs or removes the write gate (Electron's `setWriteGate`). Calls read it per call.
    pub fn set_write_gate(&self, gate: Option<Arc<dyn WriteGate>>) {
        *self
            .gate
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = gate;
    }

    /// Missing `arguments` count as `{}`, as Electron's `withToolArguments` does.
    pub async fn call(
        &self,
        name: &str,
        arguments: Option<JsonObject>,
        ctx: &CallContext,
    ) -> CallToolResult {
        let Some(spec) = self.catalog.get(name) else {
            return error_text(format!("MCP error -32602: Tool {name} not found"));
        };
        let args = match spec.parse(Value::Object(arguments.unwrap_or_default())) {
            Ok(args) => args,
            Err(issues) => {
                return error_text(format!(
                    "MCP error -32602: Input validation error: Invalid arguments for tool \
                     {name}: {issues}"
                ));
            }
        };
        let args = match spec.class {
            ToolClass::Read => args,
            ToolClass::Write => match self.approve(spec, args, ctx).await {
                Ok(args) => args,
                Err(error) => return error.to_result(),
            },
        };
        match self.host.call(name, args, ctx).await {
            Ok(reply) => render(reply),
            Err(error) => {
                match error.code {
                    ToolErrorCode::Internal => {
                        tracing::error!(scope = "AgentMcp", tool = name, "tool failed: {error}")
                    }
                    ToolErrorCode::PermissionDenied => {}
                    code => tracing::warn!(scope = "AgentMcp", tool = name, ?code, "tool failed"),
                }
                error.to_result()
            }
        }
    }

    /// The user's edit is held to the tool's input rules like the call itself; Electron runs it
    /// unchecked.
    async fn approve(
        &self,
        spec: &ToolSpec,
        args: Value,
        ctx: &CallContext,
    ) -> Result<Value, ToolError> {
        let tool = spec.name();
        let denied = |message: &str| ToolError::new(ToolErrorCode::PermissionDenied, message);
        let gate = self
            .gate
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(gate) = gate else {
            return Err(denied(NO_GATE));
        };
        let Some(write_grant) = ctx.write_grant.as_deref() else {
            return Err(denied(NO_GRANT));
        };
        let request = GateRequest {
            write_grant,
            window: ctx.window.as_deref(),
            tool,
            args: &args,
        };
        match gate.decide(request).await {
            GateDecision::Approved { args: None } => Ok(args),
            GateDecision::Approved { args: Some(edited) } => spec.parse(edited).map_err(|issues| {
                ToolError::new(
                    ToolErrorCode::Validation,
                    format!("The edited arguments are invalid: {issues}"),
                )
            }),
            GateDecision::Denied { reason } => Err(denied(reason.as_deref().unwrap_or(DENIED))),
        }
    }
}

/// The JSON text part, the image part when there is one, and `structuredContent`: an object as
/// it is, anything else as `{result}`.
fn render(reply: ToolReply) -> CallToolResult {
    let value = match &reply.cap {
        Some(cap) => cap_reply(reply.value, cap),
        None => reply.value,
    };
    let mut content = vec![ContentBlock::text(value.to_string())];
    if let Some(image) = reply.image {
        content.push(ContentBlock::image(image.data, image.mime_type));
    }
    let structured = match value {
        Value::Object(_) => value,
        other => Value::Object(Map::from_iter([("result".to_owned(), other)])),
    };
    let mut result = CallToolResult::success(content);
    result.structured_content = Some(structured);
    result
}
