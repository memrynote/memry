//! The agent MCP server's connections: what `stop` ends, the header read timeout, and the
//! answers of the routes and the MCP handshake that Electron's server gives.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use memry_desktop::agent::mcp::{
    CallContext, McpServer, ToolError, ToolRegistry, ToolReply, VaultToolHost,
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::agent_mcp::http::request;

struct Echo;

#[async_trait]
impl VaultToolHost for Echo {
    async fn call(&self, _: &str, args: Value, _: &CallContext) -> Result<ToolReply, ToolError> {
        Ok(ToolReply::new(args))
    }
}

async fn start() -> (McpServer, Arc<ToolRegistry>) {
    let registry = Arc::new(ToolRegistry::new(Arc::new(Echo)));
    let server = McpServer::start(registry.clone()).await.unwrap();
    (server, registry)
}

/// A connection that sent part of a request head and stopped.
async fn half_open(server: &McpServer) -> TcpStream {
    let authority = server.url().trim_start_matches("http://");
    let mut stream = TcpStream::connect(authority).await.unwrap();
    stream
        .write_all(format!("POST /mcp HTTP/1.1\r\nHost: {authority}\r\n").as_bytes())
        .await
        .unwrap();
    stream
}

/// Reads until the server closes the connection; a reset counts as closed.
async fn read_until_closed(stream: &mut TcpStream) {
    let mut rest = Vec::new();
    let _ = stream.read_to_end(&mut rest).await;
}

/// The review's probe: a client that never finishes its request head kept its connection, and
/// with it the registry, alive after `stop`.
#[tokio::test]
async fn stop_ends_a_connection_that_never_finished_its_request_head() {
    let (server, registry) = start().await;
    let mut stream = half_open(&server).await;
    // Connections are accepted in order, so this answer means the half-open one was accepted.
    let token = server.token();
    assert_eq!(
        request(server.url(), "GET", "/healthz", Some(&token), None)
            .await
            .0,
        200
    );
    server.stop().await;
    assert_eq!(Arc::strong_count(&registry), 1);
    read_until_closed(&mut stream).await;
}

/// Node's `headersTimeout`: a request head has 60 s to arrive.
#[tokio::test(start_paused = true)]
async fn a_request_head_that_never_arrives_is_dropped_after_a_minute() {
    let (server, _registry) = start().await;
    let started = tokio::time::Instant::now();
    let mut stream = half_open(&server).await;
    let closed = tokio::time::timeout(Duration::from_secs(3_600), read_until_closed(&mut stream));
    assert!(
        closed.await.is_ok(),
        "the connection was still open after an hour"
    );
    assert!(started.elapsed() >= Duration::from_secs(60));
    server.stop().await;
}

#[tokio::test]
async fn healthz_answers_get_only() {
    let (server, _registry) = start().await;
    let token = server.token();
    for method in ["POST", "PUT", "DELETE"] {
        assert_eq!(
            request(server.url(), method, "/healthz", Some(&token), None).await,
            (404, r#"{"error":"not_found"}"#.to_owned()),
            "{method}"
        );
    }
    server.stop().await;
}

/// Electron's `McpServer` declares `tools.listChanged`.
#[tokio::test]
async fn initialize_declares_the_tool_list_may_change() {
    let (server, _registry) = start().await;
    let token = server.token();
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "memry-test", "version": "1.0.0" }
        }
    })
    .to_string();
    let (status, reply) = request(server.url(), "POST", "/mcp", Some(&token), Some(&body)).await;
    assert_eq!(status, 200, "{reply}");
    assert!(reply.contains(r#""tools":{"listChanged":true}"#), "{reply}");
    server.stop().await;
}
