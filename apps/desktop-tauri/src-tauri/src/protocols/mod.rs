//! The `memry-file://` and `memry-html://` schemes. The decisions and the bytes come from
//! `memry_desktop::shell::file_service`, the same function the loopback media route calls; this
//! module only reads a request and writes a response.
//!
//! A scheme response is bytes in memory (the engine takes no stream), so one response is capped
//! at [`MAX_RESPONSE_BYTES`]. A player or the PDF viewer asks for ranges and reads the rest with
//! further requests; video and audio go through the loopback server, which streams.

use std::borrow::Cow;

use memry_desktop::paths::AppPaths;
use memry_desktop::session::Session;
use memry_desktop::shell::file_service::{Body, Roots, Served, read_range, serve_file, serve_html};
use memry_desktop::telemetry::main_warning::Level;
use tauri::http::{Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Wry};

use crate::shell::services::telemetry;

pub const FILE_SCHEME: &str = "memry-file";
pub const HTML_SCHEME: &str = "memry-html";

/// The most bytes one scheme response holds.
pub const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

const WINDOWS: bool = cfg!(windows);

/// The roots a URL may name right now.
pub fn roots(app: &AppHandle<Wry>) -> Roots {
    Roots {
        vault: app.state::<Session>().current().map(|open| open.path),
        app_data: app.state::<AppPaths>().data_dir.clone(),
    }
}

/// Registers both schemes on the builder.
pub fn register(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder
        .register_asynchronous_uri_scheme_protocol(FILE_SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(answer_file(&app, &request));
            });
        })
        .register_asynchronous_uri_scheme_protocol(HTML_SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(answer_html(&app, &request));
            });
        })
}

fn answer_file(app: &AppHandle<Wry>, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok());
    let served = serve_file(
        &request.uri().to_string(),
        range,
        &roots(app),
        WINDOWS,
        MAX_RESPONSE_BYTES,
    );
    respond(app, served)
}

fn answer_html(app: &AppHandle<Wry>, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let vault = app.state::<Session>().current().map(|open| open.path);
    let served = serve_html(
        &request.uri().to_string(),
        request.method() == Method::GET,
        vault.as_deref(),
        WINDOWS,
    );
    respond(app, served)
}

/// A [`Served`] as a response, reading the body from its file. A read that fails answers 404 and
/// leaves an error code (never a path) in telemetry.
fn respond(app: &AppHandle<Wry>, served: Served) -> Response<Cow<'static, [u8]>> {
    let Served {
        status,
        headers,
        body,
        mut failure,
    } = served;
    let (status, bytes) = match body {
        Body::Empty => (status, Vec::new()),
        Body::Bytes(bytes) => (status, bytes),
        Body::File {
            mut file,
            start,
            len,
        } => match read_range(&mut file, start, len) {
            Ok(bytes) => (status, bytes),
            Err(error) => {
                failure = Some(format!("{:?}", error.kind()));
                (404, Vec::new())
            }
        },
    };
    if let Some(code) = failure {
        tracing::warn!(scope = "MemryFile", code, "serve failed");
        if let Some(service) = telemetry(app) {
            service.track_main_log(
                Level::Warn,
                "MemryFile",
                "serve_failed",
                Some(&code),
                None,
                None,
            );
        }
    }
    let mut response =
        Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::NOT_FOUND));
    for (name, value) in headers {
        response = response.header(name, value);
    }
    response
        .body(Cow::Owned(bytes))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])))
}
