//! Every request of the capture server, in `server.ts:66-270`'s order. Routes match the exact
//! request target (a query string is `404`, as Node's `req.url` compares). Every response is
//! JSON with `Connection: close`, no CORS header and no OPTIONS handling.

use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderValue, Method, Request, Response, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio::time::{Instant, timeout_at};

use super::auth::{Asked, Denied, host_allowed, is_extension_origin, token_matches};
use super::pairing::CLAIM_WINDOW;
use super::{BODY_LIMIT, CaptureDeps, folders, ingest, schema};
use crate::session::OpenVault;
use crate::telemetry::diagnostics::Failure;
use crate::telemetry::service::Service;

pub(super) struct Shared {
    pub(super) deps: CaptureDeps,
    pub(super) port: u16,
    /// [`super::Limits::request`].
    pub(super) request_timeout: Duration,
}

type Reply = Result<Response<Body>, String>;

pub(super) async fn handle(shared: &Shared, request: Request<Body>) -> Response<Body> {
    match route(shared, request).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(scope = "Capture", "capture request failed: {error}");
            if let Some(telemetry) = &shared.deps.telemetry {
                let failure = Failure {
                    code: None,
                    message: error,
                    expected_condition: false,
                    expected_warning: false,
                };
                telemetry.track_main_error("capture_server", "capture_request", &failure);
            }
            reply(
                StatusCode::INTERNAL_SERVER_ERROR,
                &json!({ "error": "internal" }),
            )
        }
    }
}

async fn route(shared: &Shared, request: Request<Body>) -> Reply {
    let deadline = Instant::now() + shared.request_timeout;
    let asked = Asked::read(request.headers());
    // Before any route: a page whose DNS name was rebound to 127.0.0.1 sends its own name.
    if !host_allowed(asked.host.as_deref(), shared.port) {
        return Ok(error(StatusCode::FORBIDDEN, "host-not-allowed"));
    }
    let uri = request.uri();
    let target = match uri.scheme() {
        None => uri.path_and_query().map(|p| p.as_str().to_owned()),
        Some(_) => None,
    };
    let method = request.method().clone();
    match (method, target.as_deref()) {
        (Method::GET, Some("/ping")) => Ok(ping(shared, &asked)),
        (Method::POST, Some("/folders")) => list_folders(shared, &asked).await,
        (Method::POST, Some("/pair/claim")) => claim(shared, &asked).await,
        (Method::POST, Some("/pair/request")) => Ok(pair_request(shared, &asked)),
        (Method::POST, Some("/capture")) => {
            capture(shared, &asked, request.into_body(), deadline).await
        }
        (Method::POST, Some("/tags")) => tags(shared, &asked).await,
        (Method::POST, Some("/pair/revoke")) => revoke(shared, &asked).await,
        _ => Ok(error(StatusCode::NOT_FOUND, "not-found")),
    }
}

fn reply(status: StatusCode, body: &Value) -> Response<Body> {
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

fn error(status: StatusCode, code: &str) -> Response<Body> {
    reply(status, &json!({ "error": code }))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

/// `validateCaptureRequest` (`auth.ts:26-36`): header, then allowlisted origin, then the token.
/// The keychain is read only for a request that passed the first two.
async fn authorize(shared: &Shared, asked: &Asked) -> Result<Result<(), Denied>, String> {
    if !asked.has_capture_header() {
        return Ok(Err(Denied::MissingCaptureHeader));
    }
    if !shared.deps.pairing.is_allowed(asked.origin.as_deref()) {
        return Ok(Err(Denied::OriginNotAllowed));
    }
    let pairing = shared.deps.pairing.clone();
    let token = blocking(move || pairing.token())
        .await?
        .map_err(|e| e.to_string())?;
    if !token_matches(asked.bearer(), &token) {
        return Ok(Err(Denied::BadToken));
    }
    Ok(Ok(()))
}

fn denied(reason: Denied) -> Response<Body> {
    error(StatusCode::UNAUTHORIZED, reason.code())
}

/// The open vault, or `None` while none is open or one is being switched.
fn open_vault(shared: &Shared) -> Option<OpenVault> {
    let session = &shared.deps.session;
    if session.is_switching() {
        return None;
    }
    session.current()
}

fn vault_closed() -> Response<Body> {
    error(StatusCode::SERVICE_UNAVAILABLE, "vault-closed")
}

fn ping(shared: &Shared, asked: &Asked) -> Response<Body> {
    reply(
        StatusCode::OK,
        &json!({
            "app": "memry",
            "version": shared.deps.version,
            "paired": shared.deps.pairing.is_allowed(asked.origin.as_deref()),
            "capabilities": ["folders"],
        }),
    )
}

/// POST, not GET: Chrome omits `Origin` on an extension's GET (`server.ts:79-80`).
async fn list_folders(shared: &Shared, asked: &Asked) -> Reply {
    if let Err(reason) = authorize(shared, asked).await? {
        return Ok(denied(reason));
    }
    let Some(open) = open_vault(shared) else {
        return Ok(vault_closed());
    };
    let list = blocking(move || folders::list(&open))
        .await?
        .map_err(|e| e.to_string())?;
    Ok(reply(
        StatusCode::OK,
        &json!({
            "vaultId": list.vault_id,
            "vaultName": list.vault_name,
            "folders": list.folders,
        }),
    ))
}

async fn claim(shared: &Shared, asked: &Asked) -> Reply {
    let Some(origin) = asked.origin.clone() else {
        return Ok(error(StatusCode::BAD_REQUEST, "missing-origin"));
    };
    let pairing = shared.deps.pairing.clone();
    if pairing.take_denied(&origin) {
        return Ok(error(StatusCode::FORBIDDEN, "pair-denied"));
    }
    let claimed = blocking(move || pairing.claim(&origin))
        .await?
        .map_err(|e| e.to_string())?;
    Ok(match claimed {
        Some(token) => reply(
            StatusCode::OK,
            &json!({ "token": token.as_str(), "port": shared.port }),
        ),
        None => error(StatusCode::FORBIDDEN, "pairing-window-closed"),
    })
}

fn pair_request(shared: &Shared, asked: &Asked) -> Response<Body> {
    let Some(origin) = asked.origin.clone() else {
        return error(StatusCode::BAD_REQUEST, "missing-origin");
    };
    if !is_extension_origin(&origin) {
        return error(StatusCode::FORBIDDEN, "origin-not-allowed");
    }
    if !asked.has_capture_header() {
        return error(StatusCode::UNAUTHORIZED, "missing-capture-header");
    }
    let pairing = shared.deps.pairing.clone();
    if pairing.is_allowed(Some(&origin)) {
        pairing.open_window_for(Some(&origin), CLAIM_WINDOW);
        return reply(StatusCode::OK, &json!({ "status": "already-paired" }));
    }
    if pairing.begin_consent(&origin) {
        let consent = shared.deps.consent.clone();
        tokio::spawn(async move {
            let asked_origin = origin.clone();
            let allowed = tokio::task::spawn_blocking(move || consent(&asked_origin))
                .await
                .unwrap_or_else(|error| {
                    tracing::error!(scope = "Capture", "the pairing prompt failed: {error}");
                    false
                });
            pairing.finish_consent(&origin, allowed);
        });
    }
    reply(StatusCode::ACCEPTED, &json!({ "status": "pending" }))
}

/// Discards what is left of a refused body frame by frame, up to the limit and the request's
/// deadline, so the extension receives the answer instead of a reset connection
/// (`req.resume()`, `server.ts:170`) and no frame is kept.
async fn drain(mut body: Body, deadline: Instant) {
    let discard = async {
        let mut read = 0;
        while read <= BODY_LIMIT {
            match body.frame().await {
                Some(Ok(frame)) => read += frame.data_ref().map_or(0, |data| data.len()),
                _ => return,
            }
        }
    };
    // Past the deadline the refusal goes out anyway and the connection closes after it.
    let _ = timeout_at(deadline, discard).await;
}

async fn capture(shared: &Shared, asked: &Asked, body: Body, deadline: Instant) -> Reply {
    if let Err(reason) = authorize(shared, asked).await? {
        drain(body, deadline).await;
        return Ok(denied(reason));
    }
    // The app is on the vault picker or switching vaults: the extension keeps the capture
    // queued and tells the user to open a vault.
    let Some(open) = open_vault(shared) else {
        drain(body, deadline).await;
        return Ok(vault_closed());
    };
    let Ok(read) = timeout_at(deadline, axum::body::to_bytes(body, BODY_LIMIT)).await else {
        return Ok(error(StatusCode::REQUEST_TIMEOUT, "request-timeout"));
    };
    let Ok(bytes) = read else {
        return Ok(error(StatusCode::PAYLOAD_TOO_LARGE, "payload-too-large"));
    };
    // `Buffer.toString()` then `JSON.parse`: invalid UTF-8 becomes U+FFFD, not an error, and so
    // does a lone surrogate escape once the text reaches the vault.
    let text = String::from_utf8_lossy(&bytes);
    let parsed = serde_json::from_str::<Value>(&schema::to_well_formed(&text))
        .ok()
        .and_then(|value| schema::parse(&value));
    drop(text);
    drop(bytes);
    let Some(capture) = parsed else {
        return Ok(error(StatusCode::UNPROCESSABLE_ENTITY, "invalid-capture"));
    };
    let (folder, vault_id) = (capture.folder.clone(), capture.vault_id.clone());
    // Inbox first, always: the clip is safe before any routing is attempted.
    let item_id = ingest::ingest(
        open.clone(),
        shared.deps.store.clone(),
        shared.deps.hero.clone(),
        capture,
    )
    .await?;
    let filed_to = match folder {
        Some(folder) => {
            let filer = shared.deps.filer.clone();
            let id = item_id.clone();
            let routed = blocking(move || {
                folders::route(&open, filer.as_deref(), &id, &folder, vault_id.as_deref())
            })
            .await?;
            if let Some(reason) = routed.reason {
                tracing::info!(scope = "Capture", item_id, reason, "capture kept in inbox");
            }
            routed.filed_to
        }
        None => None,
    };
    if let Some(supervisor) = shared.deps.session.sync_supervisor() {
        supervisor.request_push();
    }
    // The extension bypasses the inbox commands, where `inbox_captured` is normally sent.
    if let Some(telemetry) = &shared.deps.telemetry {
        let mut event = Service::event("inbox_captured", "inbox", "captured");
        event.object_type = Some("inbox_clipper".to_owned());
        event.source = Some("browser_extension".to_owned());
        event.result = Some("success".to_owned());
        event.dimensions = Some([("capture_type".to_owned(), "clipper".to_owned())].into());
        telemetry.track_main_event(event);
    }
    Ok(reply(
        StatusCode::OK,
        &json!({ "itemId": item_id, "filedTo": filed_to }),
    ))
}

/// Tag names for the clipper's autocomplete, most used first. Same auth as `/capture`: the
/// list is vault content.
async fn tags(shared: &Shared, asked: &Asked) -> Reply {
    if let Err(reason) = authorize(shared, asked).await? {
        return Ok(denied(reason));
    }
    let Some(open) = open_vault(shared) else {
        return Ok(vault_closed());
    };
    let mut tags = blocking(move || crate::tags::all_with_counts(&open))
        .await?
        .map_err(|e| e.to_string())?;
    // `toSorted((a, b) => b.count - a.count)`: stable.
    tags.sort_by_key(|tag| std::cmp::Reverse(tag.count));
    let names: Vec<String> = tags.into_iter().map(|tag| tag.name).collect();
    Ok(reply(StatusCode::OK, &json!({ "tags": names })))
}

async fn revoke(shared: &Shared, asked: &Asked) -> Reply {
    if let Err(reason) = authorize(shared, asked).await? {
        return Ok(denied(reason));
    }
    let pairing = shared.deps.pairing.clone();
    blocking(move || pairing.unpair())
        .await?
        .map_err(|e| e.to_string())?;
    Ok(reply(StatusCode::OK, &json!({ "ok": true })))
}

#[cfg(test)]
mod tests;
