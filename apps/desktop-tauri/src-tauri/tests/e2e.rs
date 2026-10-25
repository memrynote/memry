#![cfg(feature = "e2e")]

use memry_desktop::e2e::E2eGate;
use memry_desktop::launch_env::LaunchEnv;
use memry_tauri::e2e::{self, commands};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
const LOCAL_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const LOCAL_ORIGIN: &str = "tauri://localhost";

#[tauri::command]
fn e2e_ping() -> String {
    "e2e".to_owned()
}

#[tauri::command]
fn typed_ping() -> String {
    "typed".to_owned()
}

fn gate(value: &str) -> E2eGate {
    let mut env = LaunchEnv::default();
    env.set("MEMRY_E2E", value);
    E2eGate::from_env(&env)
}

fn webview(gate: E2eGate) -> tauri::WebviewWindow<MockRuntime> {
    let app = mock_builder()
        .invoke_handler(e2e::dispatcher(
            gate,
            tauri::generate_handler![e2e_ping],
            tauri::generate_handler![typed_ping],
        ))
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .expect("window");
    std::mem::forget(app);
    window
}

fn call(
    webview: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
) -> Result<InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: LOCAL_ORIGIN.parse().expect("url"),
            body: InvokeBody::Json(serde_json::json!({})),
            headers: tauri::http::HeaderMap::new(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

fn json(response: InvokeResponseBody) -> String {
    let InvokeResponseBody::Json(json) = response else {
        panic!("expected a JSON response");
    };
    json
}

#[test]
fn closed_gate_rejects_every_e2e_command_with_e2e_disabled() {
    let window = webview(gate("0"));

    let error = call(&window, "e2e_ping").expect_err("gate is closed");

    assert_eq!(error["code"], "e2e_disabled");
    assert_eq!(error["kind"], "invalid");
}

#[test]
fn closed_gate_still_routes_other_commands() {
    let window = webview(gate(""));

    assert_eq!(json(call(&window, "typed_ping").unwrap()), "\"typed\"");
}

#[test]
fn open_gate_routes_by_prefix() {
    let window = webview(gate("1"));

    assert_eq!(json(call(&window, "e2e_ping").unwrap()), "\"e2e\"");
    assert_eq!(json(call(&window, "typed_ping").unwrap()), "\"typed\"");
}

#[test]
fn e2e_commands_use_prefix() {
    assert!(!commands::NAMES.is_empty());
    for name in commands::NAMES {
        assert!(
            name.starts_with(e2e::PREFIX),
            "{name} would be routed to the specta handler; name it e2e_<verb>_<noun>"
        );
    }
    let mut sorted = commands::NAMES.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        commands::NAMES.len(),
        "duplicate command name"
    );
}

#[test]
fn the_controller_registers_every_command_it_names() {
    // `handler()` is built from the same tokens as `NAMES`; building it must not panic.
    let _handler = commands::handler();
}
