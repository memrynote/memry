//! The loopback MCP endpoint, the port of Electron's `agent/mcp/server.ts`: `127.0.0.1:0`, the
//! bearer checked before any routing (401 `{"error":"unauthorized"}`), `GET /healthz`
//! (`{"ok":true}`), `POST /mcp` as stateless streamable HTTP, and 404 `{"error":"not_found"}` for
//! anything else. Each MCP request gets its own handler over the shared [`ToolRegistry`].

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post_service};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::json;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::registry::ToolRegistry;
use super::session::{CallContext, Session};

/// How long [`McpServer::stop`] lets in-flight calls finish before ending them
/// (Electron's `STOP_GRACE_MS`).
pub const STOP_GRACE: Duration = Duration::from_millis(500);

/// A running server. [`McpServer::stop`] ends it; dropping it aborts the accept loop.
pub struct McpServer {
    url: String,
    session: Arc<Session>,
    shutdown: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl McpServer {
    /// Binds `127.0.0.1:0` and serves. Call inside a tokio runtime.
    pub async fn start(registry: Arc<ToolRegistry>) -> io::Result<Self> {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let session = Arc::new(Session::new());
        let shutdown = CancellationToken::new();
        let app = router(registry, session.clone(), shutdown.child_token());
        let signal = shutdown.clone();
        let task = tokio::spawn(async move {
            let serve = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move { signal.cancelled().await });
            if let Err(error) = serve.await {
                tracing::error!(scope = "AgentMcp", "the MCP server stopped: {error}");
            }
        });
        let url = format!("http://127.0.0.1:{port}");
        tracing::info!(scope = "AgentMcp", "listening on {url}");
        Ok(Self {
            url,
            session,
            shutdown,
            task: Some(task),
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

    /// Stops accepting and gives in-flight calls [`STOP_GRACE`]. The cancelled token also ends
    /// each in-flight MCP request inside rmcp, so their connections close; the abort is the
    /// backstop.
    pub async fn stop(mut self) {
        self.shutdown.cancel();
        let Some(mut task) = self.task.take() else {
            return;
        };
        if tokio::time::timeout(STOP_GRACE, &mut task).await.is_err() {
            tracing::warn!(
                scope = "AgentMcp",
                "MCP connections still open at stop; dropping them"
            );
            task.abort();
        }
        tracing::info!(scope = "AgentMcp", "MCP server stopped");
    }
}

impl Drop for McpServer {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            self.shutdown.cancel();
            task.abort();
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
            get(|| async { json_reply(StatusCode::OK, json!({ "ok": true })) }),
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
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
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
