//! The `memry-file://` and `memry-html://` schemes. The decisions and the bytes come from
//! `memry_desktop::shell::file_service`, the same function the loopback media route calls; this
//! module only reads a request and writes a response.
//!
//! A scheme response is bytes in memory (the engine takes no stream), so a range is capped at
//! [`MAX_RANGE_BYTES`] and a whole file at [`MAX_WHOLE_FILE_BYTES`]. The PDF viewer asks for ranges
//! and reads the rest with further requests; video and audio go through the loopback server,
//! which streams.

use std::borrow::Cow;

use memry_desktop::paths::AppPaths;
use memry_desktop::session::Session;
use memry_desktop::shell::file_service::{
    Caps, FileRequest, Roots, Served, Settled, serve_file, serve_html,
};
use memry_desktop::telemetry::main_warning::Level;
use tauri::http::{Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Wry};

use crate::shell::navigation_guard::{app_origins, page_origin};
use crate::shell::services::telemetry;

pub const FILE_SCHEME: &str = "memry-file";
pub const HTML_SCHEME: &str = "memry-html";

/// The most bytes one range of a scheme response holds. A client reads the rest with further ranges.
pub const MAX_RANGE_BYTES: u64 = 16 * 1024 * 1024;

/// The largest file a scheme answers whole (200). The engine takes the body as bytes in memory, so
/// a larger file asked for without a range gets 413, never a truncated 206; media goes through the
/// streaming loopback server instead.
pub const MAX_WHOLE_FILE_BYTES: u64 = 128 * 1024 * 1024;

const WINDOWS: bool = cfg!(windows);

/// The roots a URL may name right now.
pub fn roots(app: &AppHandle<Wry>) -> Roots {
    Roots {
        vault: app.state::<Session>().current().map(|open| open.path),
        app_data: app.state::<AppPaths>().data_dir.clone(),
        app_origins: app_origins(app),
        reply_origin: page_origin(app),
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
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let asked = FileRequest {
        range: header("range"),
        origin: header("origin"),
        fetch_dest: header("sec-fetch-dest"),
    };
    let caps = Caps {
        range_chunk: MAX_RANGE_BYTES,
        whole_file: MAX_WHOLE_FILE_BYTES,
    };
    let served = serve_file(
        &request.uri().to_string(),
        &asked,
        &roots(app),
        WINDOWS,
        caps,
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
    let Settled {
        status,
        headers,
        bytes,
        failure,
    } = served.settle();
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
