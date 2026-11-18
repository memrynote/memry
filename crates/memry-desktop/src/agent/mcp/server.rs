//! The loopback MCP endpoint, the port of Electron's `agent/mcp/server.ts`: `127.0.0.1:0`, the
//! bearer checked before any routing (401 `{"error":"unauthorized"}`), `GET /healthz`
//! (`{"ok":true}`), `POST /mcp` as stateless streamable HTTP, and 404 `{"error":"not_found"}` for
//! anything else. Each MCP request gets its own handler over the shared [`ToolRegistry`].

use std::io;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post_service};
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::registry::ToolRegistry;
use super::session::{CallContext, Session};

/// How long [`McpServer::stop`] lets in-flight calls finish before ending them
/// (Electron's `STOP_GRACE_MS`).
pub const STOP_GRACE: Duration = Duration::from_millis(500);

/// How long a connection has to send a whole request head (Node's `headersTimeout` default), so
/// a client that stops mid-head does not hold its connection open.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// A running server. [`McpServer::stop`] ends it; dropping it drops every connection.
pub struct McpServer {
    url: String,
    session: Arc<Session>,
    /// Stops the accept loop and asks each connection to close after its in-flight request.
    shutdown: CancellationToken,
    /// Drops every connection still open.
    abort: CancellationToken,
    /// The accept loop and one task per connection.
    tasks: TaskTracker,
}

impl McpServer {
    /// Binds `127.0.0.1:0` and serves. Call inside a tokio runtime.
    pub async fn start(registry: Arc<ToolRegistry>) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let session = Arc::new(Session::new());
        let shutdown = CancellationToken::new();
        let abort = CancellationToken::new();
        let tasks = TaskTracker::new();
        let app = router(registry, session.clone(), shutdown.child_token());
        let connections = Connections {
            app,
            shutdown: shutdown.clone(),
            abort: abort.clone(),
            tasks: tasks.clone(),
        };
        tasks.spawn(connections.accept(listener));
        let url = format!("http://127.0.0.1:{port}");
        tracing::info!(scope = "AgentMcp", "listening on {url}");
        Ok(Self {
            url,
            session,
            shutdown,
            abort,
            tasks,
        })
    }

    /// The base URL; clients post to `<url>/mcp`.
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn token(&self) -> String {
        self.session.token()
    }

    /// Mints a new bearer; the previous one is refused from the next request on.
    pub fn rotate_token(&self) -> String {
        self.session.rotate()
    }

    /// Stops accepting, gives in-flight calls [`STOP_GRACE`], then drops every connection still
    /// open, a half-sent request among them. The cancelled token also ends each in-flight MCP
    /// request inside rmcp. Returns once every connection task has ended.
    pub async fn stop(self) {
        self.shutdown.cancel();
        self.tasks.close();
        if tokio::time::timeout(STOP_GRACE, self.tasks.wait())
            .await
            .is_err()
        {
            tracing::warn!(
                scope = "AgentMcp",
                "MCP connections still open at stop; dropping them"
            );
            self.abort.cancel();
            self.tasks.wait().await;
        }
        tracing::info!(scope = "AgentMcp", "MCP server stopped");
    }
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
        self.abort.cancel();
    }
}

/// What the accept loop hands each connection. A `TaskTracker` cannot abort its tasks, so each
/// connection task ends itself on `abort`.
#[derive(Clone)]
struct Connections {
    app: Router,
    shutdown: CancellationToken,
    abort: CancellationToken,
    tasks: TaskTracker,
}

impl Connections {
    async fn accept(self, listener: TcpListener) {
        loop {
            let accepted = tokio::select! {
                () = self.shutdown.cancelled() => return,
                accepted = listener.accept() => accepted,
            };
            match accepted {
                Ok((stream, _)) => {
                    self.tasks.spawn(self.clone().serve(stream));
                }
                // Out of file descriptors and the like: retrying at once would spin.
                Err(error) => {
                    tracing::warn!(scope = "AgentMcp", "accept failed: {error}");
                    tokio::select! {
                        () = self.shutdown.cancelled() => return,
                        () = tokio::time::sleep(Duration::from_secs(1)) => {}
                    }
                }
            }
        }
    }

    async fn serve(self, stream: TcpStream) {
        let mut builder = http1::Builder::new();
        builder
            .timer(TokioTimer::new())
            .header_read_timeout(HEADER_READ_TIMEOUT);
        let connection =
            builder.serve_connection(TokioIo::new(stream), TowerToHyperService::new(self.app));
        let mut connection = std::pin::pin!(connection);
        let result = tokio::select! {
            result = connection.as_mut() => result,
            () = self.shutdown.cancelled() => {
                connection.as_mut().graceful_shutdown();
                tokio::select! {
                    result = connection.as_mut() => result,
                    () = self.abort.cancelled() => return,
                }
            }
        };
        if let Err(error) = result {
            tracing::debug!(scope = "AgentMcp", "connection ended: {error}");
        }
    }
}

fn router(registry: Arc<ToolRegistry>, session: Arc<Session>, stop: CancellationToken) -> Router {
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(false)
        .with_cancellation_token(stop);
    let mcp = StreamableHttpService::new(
        move || {
            Ok(Handler {
                registry: registry.clone(),
            })
        },
        Arc::new(LocalSessionManager::default()),
        config,
    );
    Router::new()
        .route(
            "/healthz",
            get(|| async { json_reply(StatusCode::OK, json!({ "ok": true })) }).fallback(not_found),
        )
        .route("/mcp", post_service(mcp).fallback(not_found))
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(session, require_bearer))
}

async fn require_bearer(
    State(session): State<Arc<Session>>,
    request: Request,
    next: Next,
) -> Response {
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if !session.verify(bearer) {
        return json_reply(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
    }
    next.run(request).await
}

async fn not_found() -> Response {
    json_reply(StatusCode::NOT_FOUND, json!({ "error": "not_found" }))
}

fn json_reply(status: StatusCode, body: serde_json::Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

#[derive(Clone)]
struct Handler {
    registry: Arc<ToolRegistry>,
}

impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .build(),
        )
        .with_server_info(Implementation::new("memry-vault", "1.0.0"))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let tools = self
            .registry
            .catalog()
            .tools()
            .map(|spec| spec.tool.clone())
            .collect();
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let ctx = context
            .extensions
            .get::<axum::http::request::Parts>()
            .map(|parts| CallContext::from_headers(&parts.headers))
            .unwrap_or_default();
        Ok(self
            .registry
            .call(&request.name, request.arguments, &ctx)
            .await
            .into())
    }
}
