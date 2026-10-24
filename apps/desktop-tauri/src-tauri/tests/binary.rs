use memry_tauri::binary;
use memry_tauri::commands::error::CommandError;
use memry_tauri::registry::dispatcher;
use serde::Deserialize;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody, Request, Response};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[derive(Deserialize)]
struct Meta {
    tag: String,
}

#[tauri::command]
fn binary_echo(request: Request<'_>) -> Result<Response, CommandError> {
    let meta: Meta = binary::meta(&request)?;
    let body = binary::raw_body(&request)?;
    Ok(binary::response([meta.tag.as_bytes(), b":", body].concat()))
}

#[tauri::command]
fn typed_ping() -> String {
    "typed".to_owned()
}

fn invoke(
    webview: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
    body: InvokeBody,
    meta: Option<&str>,
) -> Result<InvokeResponseBody, serde_json::Value> {
    let mut headers = tauri::http::HeaderMap::new();
    if let Some(meta) = meta {
        headers.insert(binary::META_HEADER, meta.parse().expect("ascii header"));
    }
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body,
            headers,
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

fn app_webview() -> tauri::WebviewWindow<MockRuntime> {
    let app = mock_builder()
        .invoke_handler(dispatcher(
            &["binary_echo"],
            tauri::generate_handler![binary_echo],
            tauri::generate_handler![typed_ping],
        ))
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .expect("window");
    // The app must outlive the window handle.
    std::mem::forget(app);
    window
}

#[test]
fn binary_command_round_trips_raw_bytes_and_metadata_through_the_dispatcher() {
    let window = app_webview();

    let response = invoke(
        &window,
        "binary_echo",
        InvokeBody::Raw(vec![1, 2, 3]),
        Some(r#"{"tag":"caf\u00e9"}"#),
    )
    .expect("binary command succeeds");

    let InvokeResponseBody::Raw(bytes) = response else {
        panic!("expected a raw response");
    };
    let mut expected = "caf\u{e9}:".as_bytes().to_vec();
    expected.extend([1, 2, 3]);
    assert_eq!(bytes, expected);
}

#[test]
fn binary_command_rejects_a_missing_header_with_a_command_error() {
    let window = app_webview();

    let error = invoke(&window, "binary_echo", InvokeBody::Raw(vec![9]), None)
        .expect_err("no metadata header");

    assert_eq!(error["code"], "binary_meta_missing");
    assert_eq!(error["kind"], "invalid");
}

#[test]
fn typed_commands_still_reach_their_own_handler() {
    let window = app_webview();

    let response = invoke(
        &window,
        "typed_ping",
        InvokeBody::Json(serde_json::json!({})),
        None,
    )
    .expect("typed command succeeds");

    let InvokeResponseBody::Json(json) = response else {
        panic!("expected a JSON response");
    };
    assert_eq!(json, "\"typed\"");
}
