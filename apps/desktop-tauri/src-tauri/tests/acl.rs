//! The app-command ACL: the permissions in `permissions/` name exactly the registered commands,
//! and Tauri's own IPC check, on the ACL that `tauri-build` resolves from this crate's
//! capabilities, lets the main window call every command and refuses every other window.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use memry_tauri::registry;
use serde_json::Value;
use specta_typescript::Typescript;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(windows)]
const LOCAL_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const LOCAL_ORIGIN: &str = "tauri://localhost";

fn src_tauri(path: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(path)
}

fn read_json(path: &str) -> Value {
    let path = src_tauri(path);
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn strings(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .expect("an array")
        .iter()
        .map(|item| item.as_str().expect("a string").to_owned())
        .collect()
}

/// Every permission of `permissions/`, by identifier, with the commands it allows.
fn permissions() -> BTreeMap<String, BTreeSet<String>> {
    let mut found = BTreeMap::new();
    for entry in fs::read_dir(src_tauri("permissions")).expect("permissions/") {
        let name = entry.expect("dir entry").file_name();
        let name = name.to_str().expect("utf-8 file name");
        assert!(name.ends_with(".json"), "permissions/{name}: only JSON");
        for permission in read_json(&format!("permissions/{name}"))["permission"]
            .as_array()
            .expect("[[permission]]")
        {
            let id = permission["identifier"].as_str().expect("identifier");
            let allowed = strings(&permission["commands"]["allow"]);
            assert!(found.insert(id.to_owned(), allowed).is_none(), "{id} twice");
        }
    }
    found
}

/// The names in the `e2e_commands!` call of `src/e2e/commands.rs`, read from the source because
/// `e2e::commands::NAMES` exists only in an `e2e` build.
fn e2e_names() -> BTreeSet<String> {
    let source = fs::read_to_string(src_tauri("src/e2e/commands.rs")).expect("e2e commands");
    let (_, call) = source
        .split_once("\ne2e_commands! {")
        .expect("e2e_commands! call");
    call.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|token| token.starts_with("e2e_"))
        .map(str::to_owned)
        .collect()
}

#[test]
fn app_all_is_the_registered_command_list() {
    let dir = tempfile::tempdir().expect("temp dir");
    let bindings = dir.path().join("bindings.ts");
    registry::builder()
        .export(Typescript::default(), &bindings)
        .expect("export bindings");
    let fresh = registry::app_all_permission(&fs::read_to_string(&bindings).expect("bindings"))
        .expect("app-all");
    let fresh: Value = serde_json::from_str(&fresh).expect("app-all JSON");
    assert_eq!(
        read_json("permissions/app-all.json"),
        fresh,
        "permissions/app-all.json is stale: run `pnpm ipc:generate`"
    );
    let app_all = &permissions()["app-all"];
    for binary in memry_tauri::binary::COMMANDS {
        assert!(app_all.contains(*binary), "{binary} missing from app-all");
    }
}

#[test]
fn every_permission_names_a_registered_command() {
    let permissions = permissions();
    let app_all = &permissions["app-all"];
    let e2e = e2e_names();
    assert!(!e2e.is_empty());
    assert_eq!(permissions["e2e-all"], e2e, "permissions/e2e.json");
    #[cfg(feature = "e2e")]
    assert_eq!(
        e2e,
        memry_tauri::e2e::commands::NAMES
            .iter()
            .map(|name| (*name).to_owned())
            .collect::<BTreeSet<_>>()
    );
    for (id, commands) in &permissions {
        for command in commands {
            let registered = if id == "e2e-all" {
                e2e.contains(command)
            } else {
                app_all.contains(command)
            };
            assert!(
                registered,
                "permission {id} names {command}, which is not registered"
            );
        }
    }
}

#[test]
fn only_the_main_window_and_e2e_builds_get_capabilities_with_app_commands() {
    let enabled = strings(&read_json("tauri.conf.json")["app"]["security"]["capabilities"]);
    assert_eq!(enabled, BTreeSet::from(["main".to_owned()]));
    let main = read_json("capabilities/main.json");
    assert_eq!(
        strings(&main["windows"]),
        BTreeSet::from(["main".to_owned()])
    );
    assert!(strings(&main["permissions"]).contains("app-all"));

    let e2e = read_json("tauri.e2e.conf.json");
    let granted: BTreeSet<String> = e2e["app"]["security"]["capabilities"]
        .as_array()
        .expect("e2e capabilities")
        .iter()
        .filter(|capability| capability.is_object())
        .flat_map(|capability| strings(&capability["permissions"]))
        .collect();
    assert!(granted.contains("e2e-all") && granted.contains("app-all"));
}

/// An app on the ACL `tauri-build` resolved for this crate, whose handler answers every command,
/// so a refusal can only come from the ACL.
fn app() -> App<MockRuntime> {
    mock_builder()
        .invoke_handler(|invoke| {
            invoke.resolver.resolve(());
            true
        })
        .build(tauri::generate_context!(test = true))
        .expect("mock app")
}

fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .build()
        .expect("window")
}

fn call(window: &WebviewWindow<MockRuntime>, command: &str) -> Result<(), String> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: LOCAL_ORIGIN.parse().expect("url"),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(drop)
    .map_err(|error| error.to_string())
}

#[test]
fn the_main_window_may_call_every_app_command() {
    let app = app();
    let main = window(&app, "main");
    for command in &permissions()["app-all"] {
        assert_eq!(call(&main, command), Ok(()), "{command}");
    }
}

#[test]
fn other_windows_and_e2e_commands_are_refused() {
    let app = app();
    let main = window(&app, "main");
    let refused = |result: Result<(), String>| result.is_err_and(|e| e.contains("not allowed"));
    for command in ["e2e_app_info", "e2e_vault_write_outside", "not_a_command"] {
        assert!(refused(call(&main, command)), "main: {command}");
    }
    for label in [
        "preboot",
        "startup-error",
        "pdf-print-1",
        "sticky",
        "sticky-tab",
        "quick-capture",
        "e2e-1",
        "unknown",
    ] {
        let other = window(&app, label);
        for command in ["app_info", "log_write", "account_get_info", "crdt_open_doc"] {
            assert!(refused(call(&other, command)), "{label}: {command}");
        }
    }
}
