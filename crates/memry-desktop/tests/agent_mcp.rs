//! The vault MCP server against Electron's contract (`packages/contracts/test-vectors/agent-mcp`)
//! and Electron's `agent/mcp/__tests__` cases: the catalogue, every example call, the write gate,
//! reply rendering and the cut, and the HTTP surface. `agent_mcp_client` drives the same server
//! with the official TypeScript client.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use memry_desktop::agent::mcp::{
    CallContext, GateDecision, GateRequest, McpServer, ReplyCap, ToolClass, ToolError,
    ToolErrorCode, ToolImage, ToolRegistry, ToolReply, VaultToolHost, WriteGate, catalog,
};
use rmcp::model::{CallToolResult, JsonObject};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

const TOOLS: &str = include_str!("../../../packages/contracts/test-vectors/agent-mcp/tools.json");
const EXAMPLES: &str =
    include_str!("../../../packages/contracts/test-vectors/agent-mcp/examples.json");

type Calls = Arc<Mutex<Vec<(String, Value, CallContext)>>>;

/// Records each call and answers with `reply`, or with `error` when one is set.
#[derive(Default)]
struct FakeHost {
    calls: Calls,
    reply: Mutex<ToolReply>,
    error: Mutex<Option<ToolError>>,
    /// When set, a call waits here after it is recorded.
    hold: Option<Arc<Notify>>,
}

#[async_trait]
impl VaultToolHost for FakeHost {
    async fn call(
        &self,
        tool: &str,
        args: Value,
        ctx: &CallContext,
    ) -> Result<ToolReply, ToolError> {
        self.calls
            .lock()
            .unwrap()
            .push((tool.to_owned(), args, ctx.clone()));
        if let Some(hold) = &self.hold {
            hold.notify_one();
            std::future::pending::<()>().await;
        }
        if let Some(error) = self.error.lock().unwrap().clone() {
            return Err(error);
        }
        Ok(self.reply.lock().unwrap().clone())
    }
}

/// Approves every call, with `edit` as the user's edited arguments when set, or denies.
struct FakeGate {
    decision: fn() -> GateDecision,
    seen: Mutex<Vec<(String, String, Option<String>)>>,
}

impl FakeGate {
    fn approving() -> Arc<Self> {
        Arc::new(Self {
            decision: || GateDecision::Approved { args: None },
            seen: Mutex::default(),
        })
    }
}

#[async_trait]
impl WriteGate for FakeGate {
    async fn decide(&self, request: GateRequest<'_>) -> GateDecision {
        self.seen.lock().unwrap().push((
            request.tool.to_owned(),
            request.write_grant.to_owned(),
            request.window.map(str::to_owned),
        ));
        (self.decision)()
    }
}

fn registry(host: Arc<FakeHost>) -> ToolRegistry {
    ToolRegistry::new(host)
}

fn turn() -> CallContext {
    CallContext {
        write_grant: Some("grant-1".into()),
        window: Some("main".into()),
    }
}

fn args(value: Value) -> Option<JsonObject> {
    match value {
        Value::Object(object) => Some(object),
        _ => None,
    }
}

fn text(result: &CallToolResult) -> String {
    let value = serde_json::to_value(result).unwrap();
    value["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn is_error(result: &CallToolResult) -> bool {
    result.is_error == Some(true)
}

#[test]
fn the_catalogue_is_electrons_tools_list() {
    let file: Value = serde_json::from_str(TOOLS).unwrap();
    let expected = file["tools"].as_array().unwrap();
    let listed: Vec<_> = catalog().tools().collect();
    assert_eq!(listed.len(), expected.len());
    for (spec, entry) in listed.iter().zip(expected) {
        let tool = serde_json::to_value(&spec.tool).unwrap();
        assert_eq!(tool["name"], entry["name"]);
        assert_eq!(tool["description"], entry["description"]);
        assert_eq!(
            tool["inputSchema"], entry["inputSchema"],
            "{}",
            entry["name"]
        );
        let class = if spec.class == ToolClass::Read {
            "read"
        } else {
            "write"
        };
        assert_eq!(class, entry["class"]);
    }
    let reads = listed
        .iter()
        .filter(|spec| spec.class == ToolClass::Read)
        .count();
    assert_eq!((reads, listed.len() - reads), (22, 53));
}

/// Every example of `examples.json` runs its handler, and every invalid variant is refused before
/// the handler (and before the gate), with the SDK's error frame. A variant that breaks only zod
/// refinements gets the SDK's whole text.
#[tokio::test]
async fn every_example_call_gets_electrons_verdict() {
    let file: Value = serde_json::from_str(EXAMPLES).unwrap();
    let host = Arc::new(FakeHost::default());
    let registry = registry(host.clone());
    registry.set_write_gate(Some(FakeGate::approving()));
    let cases = file["tools"].as_array().unwrap();
    assert!(cases.len() > 300);
    for case in cases {
        let tool = case["tool"].as_str().unwrap();
        host.calls.lock().unwrap().clear();
        let result = registry
            .call(tool, args(case["arguments"].clone()), &turn())
            .await;
        let ran = host.calls.lock().unwrap().len() == 1;
        let label = format!("{tool} ({})", case["variant"]);
        if case["valid"] == json!(true) {
            assert!(ran && !is_error(&result), "{label}: {}", text(&result));
        } else {
            assert!(!ran && is_error(&result), "{label} ran");
            let frame = format!(
                "MCP error -32602: Input validation error: Invalid arguments for tool {tool}: "
            );
            assert!(case["errorText"].as_str().unwrap().starts_with(&frame));
            assert!(
                text(&result).starts_with(&frame),
                "{label}: {}",
                text(&result)
            );
            let issues = case["issues"].as_array().unwrap();
            if issues.iter().all(|issue| issue["code"] == "custom") {
                assert_eq!(
                    text(&result),
                    case["errorText"].as_str().unwrap(),
                    "{label}"
                );
            }
        }
    }
}

#[tokio::test]
async fn missing_arguments_count_as_an_empty_object() {
    let host = Arc::new(FakeHost::default());
    let result = registry(host.clone())
        .call("vault_get_tags", None, &CallContext::default())
        .await;
    assert!(!is_error(&result), "{}", text(&result));
    assert_eq!(host.calls.lock().unwrap()[0].1, json!({}));
}

#[tokio::test]
async fn schema_defaults_are_filled_as_zod_fills_them() {
    let host = Arc::new(FakeHost::default());
    let registry = registry(host.clone());
    registry.set_write_gate(Some(FakeGate::approving()));
    let call = json!({ "project_id": "p-1", "name": "Done-ish" });
    let result = registry
        .call("vault_create_status", args(call), &turn())
        .await;
    assert!(!is_error(&result), "{}", text(&result));
    let (_, received, _) = host.calls.lock().unwrap()[0].clone();
    assert_eq!(received["color"], "#6b7280");
    assert_eq!(received["is_done"], false);
}

#[tokio::test]
async fn an_unknown_tool_gets_the_sdk_error() {
    let result = registry(Arc::default())
        .call("vault_nope", None, &turn())
        .await;
    assert!(is_error(&result));
    assert_eq!(text(&result), "MCP error -32602: Tool vault_nope not found");
}

mod gate {
    use super::*;

    const TOOL: &str = "vault_delete_note";

    fn call() -> Option<JsonObject> {
        args(json!({ "id": "note-1" }))
    }

    async fn refused(registry: &ToolRegistry, ctx: &CallContext) -> Value {
        let result = registry.call(TOOL, call(), ctx).await;
        assert!(is_error(&result));
        serde_json::from_str(&text(&result)).unwrap()
    }

    #[tokio::test]
    async fn a_write_without_a_gate_is_refused() {
        let host = Arc::new(FakeHost::default());
        let reply = refused(&registry(host.clone()), &turn()).await;
        assert_eq!(
            reply,
            json!({ "code": "PERMISSION_DENIED", "message": "Write tools require an active memrynote Agent conversation with an approval gate." })
        );
        assert!(host.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_write_without_a_turn_capability_never_reaches_the_gate() {
        let host = Arc::new(FakeHost::default());
        let registry = registry(host.clone());
        let gate = FakeGate::approving();
        registry.set_write_gate(Some(gate.clone()));
        let reply = refused(&registry, &CallContext::default()).await;
        assert_eq!(reply["code"], "PERMISSION_DENIED");
        assert_eq!(
            reply["message"],
            "Write tools require an in-flight memrynote Agent turn; no X-Memry-Turn capability was presented."
        );
        assert!(gate.seen.lock().unwrap().is_empty());
        assert!(host.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_denial_carries_its_reason_or_the_default() {
        let host = Arc::new(FakeHost::default());
        let registry = registry(host.clone());
        registry.set_write_gate(Some(Arc::new(FakeGate {
            decision: || GateDecision::Denied { reason: None },
            seen: Mutex::default(),
        })));
        assert_eq!(
            refused(&registry, &turn()).await["message"],
            "User denied request."
        );
        registry.set_write_gate(Some(Arc::new(FakeGate {
            decision: || GateDecision::Denied {
                reason: Some("Approval expired".into()),
            },
            seen: Mutex::default(),
        })));
        assert_eq!(
            refused(&registry, &turn()).await["message"],
            "Approval expired"
        );
        assert!(host.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_gate_sees_the_turn_and_window_and_edited_arguments_replace_the_parsed_ones() {
        let host = Arc::new(FakeHost::default());
        let registry = registry(host.clone());
        let gate = Arc::new(FakeGate {
            decision: || GateDecision::Approved {
                args: Some(json!({ "id": "note-2" })),
            },
            seen: Mutex::default(),
        });
        registry.set_write_gate(Some(gate.clone()));
        let result = registry.call(TOOL, call(), &turn()).await;
        assert!(!is_error(&result), "{}", text(&result));
        assert_eq!(
            gate.seen.lock().unwrap()[0],
            (
                TOOL.to_owned(),
                "grant-1".to_owned(),
                Some("main".to_owned())
            )
        );
        assert_eq!(host.calls.lock().unwrap()[0].1, json!({ "id": "note-2" }));
    }

    /// The user's edit goes through the same validation as the call; Electron runs it unchecked.
    #[tokio::test]
    async fn an_edit_that_breaks_the_input_rules_is_refused() {
        let host = Arc::new(FakeHost::default());
        let registry = registry(host.clone());
        registry.set_write_gate(Some(Arc::new(FakeGate {
            decision: || GateDecision::Approved {
                args: Some(json!({ "id": "note-1", "memry_unknown_key": true })),
            },
            seen: Mutex::default(),
        })));
        let reply = refused(&registry, &turn()).await;
        assert_eq!(reply["code"], "VALIDATION");
        assert!(host.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_read_needs_no_gate_and_no_capability() {
        let host = Arc::new(FakeHost::default());
        let call = args(json!({ "id": "note-1" }));
        let result = registry(host.clone())
            .call("vault_read_note", call, &CallContext::default())
            .await;
        assert!(!is_error(&result), "{}", text(&result));
    }
}

mod replies {
    use super::*;

    async fn reply_for(reply: ToolReply) -> Value {
        let host = Arc::new(FakeHost {
            reply: Mutex::new(reply),
            ..FakeHost::default()
        });
        let call = args(json!({ "id": "note-1" }));
        let result = registry(host)
            .call("vault_read_note", call, &CallContext::default())
            .await;
        serde_json::to_value(result).unwrap()
    }

    #[tokio::test]
    async fn an_object_is_the_structured_content_and_the_text() {
        let reply = reply_for(ToolReply::new(json!({ "id": "note-1", "title": "T" }))).await;
        assert_eq!(
            reply["content"],
            json!([{ "type": "text", "text": "{\"id\":\"note-1\",\"title\":\"T\"}" }])
        );
        assert_eq!(
            reply["structuredContent"],
            json!({ "id": "note-1", "title": "T" })
        );
        assert!(reply.get("isError").is_none_or(|flag| flag == false));
    }

    #[tokio::test]
    async fn anything_else_is_wrapped_as_result_and_nothing_replies_null() {
        let list = reply_for(ToolReply::new(json!([1, 2]))).await;
        assert_eq!(list["structuredContent"], json!({ "result": [1, 2] }));
        let nothing = reply_for(ToolReply::new(Value::Null)).await;
        assert_eq!(nothing["content"][0]["text"], "null");
        assert_eq!(nothing["structuredContent"], json!({ "result": null }));
    }

    #[tokio::test]
    async fn an_image_follows_the_text_part() {
        let image = ToolImage {
            data: "aGk=".into(),
            mime_type: "image/png".into(),
        };
        let reply = ToolReply {
            image: Some(image),
            ..ToolReply::new(json!({ "id": "f" }))
        };
        let reply = reply_for(reply).await;
        assert_eq!(
            reply["content"][1],
            json!({ "type": "image", "data": "aGk=", "mimeType": "image/png" })
        );
    }

    #[tokio::test]
    async fn a_host_error_is_the_tool_error_shape() {
        let error = ToolError::new(ToolErrorCode::NotFound, "Note not found: x");
        let host = Arc::new(FakeHost {
            error: Mutex::new(Some(error)),
            ..FakeHost::default()
        });
        let call = args(json!({ "id": "x" }));
        let result = registry(host)
            .call("vault_read_note", call, &CallContext::default())
            .await;
        assert!(is_error(&result));
        assert_eq!(
            text(&result),
            r#"{"code":"NOT_FOUND","message":"Note not found: x"}"#
        );
    }

    #[tokio::test]
    async fn a_capped_reply_is_cut_after_rendering_input() {
        let cap = ReplyCap {
            max_bytes: 2_000,
            advice: "Ask for less.".into(),
        };
        let reply = ToolReply {
            cap: Some(cap),
            ..ToolReply::new(json!({ "body": "x".repeat(10_000) }))
        };
        let reply = reply_for(reply).await;
        assert_eq!(reply["structuredContent"]["truncated"], true);
        assert!(reply["content"][0]["text"].as_str().unwrap().len() <= 2_000);
    }
}

pub(crate) mod http {
    use super::*;

    /// One HTTP/1.1 exchange with `Connection: close`: the status and the body.
    pub(crate) async fn request(
        url: &str,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: Option<&str>,
    ) -> (u16, String) {
        let authority = url.trim_start_matches("http://");
        let mut stream = tokio::net::TcpStream::connect(authority).await.unwrap();
        let mut head =
            format!("{method} {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n");
        if let Some(bearer) = bearer {
            head.push_str(&format!("Authorization: Bearer {bearer}\r\n"));
        }
        let body = body.unwrap_or_default();
        head.push_str(&format!(
            "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ));
        stream.write_all(head.as_bytes()).await.unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        let status = raw[9..12].parse().unwrap();
        let body = raw
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_owned())
            .unwrap_or_default();
        (status, body)
    }

    async fn server() -> McpServer {
        McpServer::start(Arc::new(registry(Arc::default())))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn binds_the_loopback_on_a_random_port() {
        let server = server().await;
        assert!(server.url().starts_with("http://127.0.0.1:"));
        assert_ne!(server.url(), "http://127.0.0.1:0");
        server.stop().await;
    }

    #[tokio::test]
    async fn the_bearer_is_checked_before_routing() {
        let server = server().await;
        let unauthorized = (401, r#"{"error":"unauthorized"}"#.to_owned());
        for path in ["/healthz", "/mcp", "/nope"] {
            assert_eq!(
                request(server.url(), "GET", path, None, None).await,
                unauthorized
            );
            let wrong = "0".repeat(64);
            assert_eq!(
                request(server.url(), "POST", path, Some(&wrong), None).await,
                unauthorized
            );
        }
        server.stop().await;
    }

    #[tokio::test]
    async fn healthz_answers_and_anything_else_is_not_found() {
        let server = server().await;
        let token = server.token();
        let not_found = (404, r#"{"error":"not_found"}"#.to_owned());
        assert_eq!(
            request(server.url(), "GET", "/healthz", Some(&token), None).await,
            (200, r#"{"ok":true}"#.to_owned())
        );
        assert_eq!(
            request(server.url(), "GET", "/mcp", Some(&token), None).await,
            not_found
        );
        assert_eq!(
            request(server.url(), "DELETE", "/mcp", Some(&token), None).await,
            not_found
        );
        assert_eq!(
            request(server.url(), "GET", "/other", Some(&token), None).await,
            not_found
        );
        server.stop().await;
    }

    #[tokio::test]
    async fn rotation_refuses_the_previous_bearer() {
        let server = server().await;
        let old = server.token();
        let new = server.rotate_token();
        assert_eq!(
            request(server.url(), "GET", "/healthz", Some(&old), None)
                .await
                .0,
            401
        );
        assert_eq!(
            request(server.url(), "GET", "/healthz", Some(&new), None)
                .await
                .0,
            200
        );
        server.stop().await;
    }

    /// Electron's "stops while a tool call is still in flight": a handler that never settles
    /// cannot hold `stop` past its grace.
    #[tokio::test]
    async fn stop_ends_a_call_that_never_settles() {
        let hold = Arc::new(Notify::new());
        let host = Arc::new(FakeHost {
            hold: Some(hold.clone()),
            ..FakeHost::default()
        });
        let server = McpServer::start(Arc::new(registry(host))).await.unwrap();
        let (url, token) = (server.url().to_owned(), server.token());
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "vault_read_note", "arguments": { "id": "n" } }
        })
        .to_string();
        let in_flight =
            tokio::spawn(
                async move { request(&url, "POST", "/mcp", Some(&token), Some(&body)).await },
            );
        hold.notified().await;
        server.stop().await;
        let (status, _) = in_flight.await.unwrap();
        assert_eq!(status, 200);
    }
}
