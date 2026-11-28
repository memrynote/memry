//! Tool errors, the port of Electron's `agent/mcp/errors.ts`. A failed tool call answers an MCP
//! result with `isError` and one text part holding `{code, message, details}`, which is what the
//! agent reads to recover.

use rmcp::model::{CallToolResult, ContentBlock};
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ToolErrorCode {
    NotFound,
    PermissionDenied,
    Validation,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct ToolError {
    pub code: ToolErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

impl ToolError {
    pub fn new(code: ToolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: Map<String, Value>) -> Self {
        self.details = Some(details);
        self
    }

    /// The MCP result the client gets, as `toMcpToolErrorContent` builds it.
    pub fn to_result(&self) -> CallToolResult {
        error_text(serde_json::to_string(self).unwrap_or_default())
    }
}

/// An error result with one text part, the shape the TypeScript SDK sends for an error it raises
/// itself (`MCP error -32602: ...`) and for a tool error.
pub(crate) fn error_text(text: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text)])
}
