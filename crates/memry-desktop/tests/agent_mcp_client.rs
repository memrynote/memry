//! The black-box contract test: the official TypeScript MCP client
//! (`tests/agent-mcp-client/mcp-client.mjs`, `@modelcontextprotocol/sdk` 1.32.2) against the Rust
//! server over a fake host. It needs `node` and `pnpm install --filter @memry/agent-mcp-client`,
//! so it is ignored by default and rust-ci runs it on Linux with `--run-ignored only`.

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use memry_desktop::agent::mcp::{
    CallContext, GateDecision, GateRequest, McpServer, ToolError, ToolRegistry, ToolReply,
    VaultToolHost, WriteGate,
};
use serde_json::{Value, json};

#[derive(Default)]
struct FakeHost {
    calls: Mutex<Vec<(String, Value)>>,
    reply: Mutex<ToolReply>,
}

#[async_trait]
impl VaultToolHost for FakeHost {
    async fn call(&self, tool: &str, args: Value, _: &CallContext) -> Result<ToolReply, ToolError> {
        self.calls.lock().unwrap().push((tool.to_owned(), args));
        Ok(self.reply.lock().unwrap().clone())
    }
}

#[derive(Default)]
struct FakeGate {
    seen: Mutex<Vec<(String, String, Option<String>)>>,
}

#[async_trait]
impl WriteGate for FakeGate {
    async fn decide(&self, request: GateRequest<'_>) -> GateDecision {
        let seen = (
            request.tool.into(),
            request.write_grant.into(),
            request.window.map(Into::into),
        );
        self.seen.lock().unwrap().push(seen);
        GateDecision::Approved { args: None }
    }
}

const TOOLS: &str = include_str!("../../../packages/contracts/test-vectors/agent-mcp/tools.json");

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs node and the @memry/agent-mcp-client package installed; rust-ci runs it"]
async fn the_official_client_sees_electrons_server() {
    let reply = ToolReply::new(json!({ "id": "note-1", "title": "Relaunch" }));
    let host = Arc::new(FakeHost {
        reply: Mutex::new(reply),
        ..FakeHost::default()
    });
    let registry = Arc::new(ToolRegistry::new(host.clone()));
    let gate = Arc::new(FakeGate::default());
    registry.set_write_gate(Some(gate.clone()));
    let server = McpServer::start(registry).await.unwrap();
    let old = server.token();
    let token = server.rotate_token();

    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/agent-mcp-client/mcp-client.mjs");
    let url = server.url().to_owned();
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .arg(script)
            .args([&url, &token, &old, "grant-1"])
            .output()
            .expect("node runs")
    })
    .await
    .unwrap();
    server.stop().await;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let out: Value = serde_json::from_slice(&output.stdout).unwrap();

    assert_eq!(
        out["serverInfo"],
        json!({ "name": "memry-vault", "version": "1.0.0" })
    );
    let expected: Value = serde_json::from_str(TOOLS).unwrap();
    let expected = expected["tools"].as_array().unwrap();
    let listed = out["tools"].as_array().unwrap();
    assert_eq!(listed.len(), expected.len());
    for (tool, entry) in listed.iter().zip(expected) {
        assert_eq!(tool["name"], entry["name"]);
        assert_eq!(tool["description"], entry["description"]);
        assert_eq!(tool["inputSchema"], entry["inputSchema"]);
    }

    assert_eq!(
        out["read"]["structuredContent"],
        json!({ "id": "note-1", "title": "Relaunch" })
    );
    assert_eq!(
        out["read"]["content"][0]["text"],
        r#"{"id":"note-1","title":"Relaunch"}"#
    );
    assert_ne!(
        out["noArguments"]["isError"], true,
        "{}",
        out["noArguments"]
    );
    let invalid = out["invalid"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(out["invalid"]["isError"], true);
    assert!(invalid.starts_with(
        "MCP error -32602: Input validation error: Invalid arguments for tool vault_search_notes: "
    ));

    let refused: Value = serde_json::from_str(
        out["writeWithoutTurn"]["content"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(out["writeWithoutTurn"]["isError"], true);
    assert_eq!(refused["code"], "PERMISSION_DENIED");
    assert_ne!(
        out["writeInTurn"]["isError"], true,
        "{}",
        out["writeInTurn"]
    );
    assert_eq!(
        gate.seen.lock().unwrap().as_slice(),
        [(
            "vault_delete_note".to_owned(),
            "grant-1".to_owned(),
            Some("main".to_owned())
        )]
    );

    let calls = host.calls.lock().unwrap();
    let tools: Vec<_> = calls
        .iter()
        .map(|(tool, args)| (tool.as_str(), args.clone()))
        .collect();
    assert_eq!(
        tools,
        [
            ("vault_read_note", json!({ "id": "note-1" })),
            ("vault_get_tags", json!({})),
            ("vault_delete_note", json!({ "id": "note-1" })),
        ]
    );
    for refusal in [&out["badBearer"], &out["rotatedOut"]] {
        assert!(
            refusal
                .as_str()
                .unwrap()
                .ends_with(r#"{"error":"unauthorized"}"#),
            "{refusal}"
        );
    }
}
