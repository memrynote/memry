//! The vault MCP server (Step 28, #3545), the port of Electron's `agent/mcp`: the loopback
//! endpoint external clients and the CLI backends call, the tool catalogue of
//! `packages/contracts/test-vectors/agent-mcp/tools.json`, and the call path every tool shares.
//! Tool handlers live behind [`VaultToolHost`]; writes pass the [`WriteGate`] first.

mod desktop_args;
pub mod errors;
mod refine;
pub mod registry;
pub mod reply_cap;
pub mod schemas;
pub mod server;
pub mod session;
mod zod;

pub use errors::{ToolError, ToolErrorCode};
pub use registry::{
    GateDecision, GateRequest, ToolImage, ToolRegistry, ToolReply, VaultToolHost, WriteGate,
};
pub use reply_cap::ReplyCap;
pub use schemas::{ToolClass, catalog};
pub use server::McpServer;
pub use session::CallContext;
