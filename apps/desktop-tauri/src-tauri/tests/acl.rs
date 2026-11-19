//! The app-command ACL: the permissions in `permissions/` name exactly the registered commands,
//! and Tauri's own IPC check, on the ACL that `tauri-build` resolves from this crate's
//! capabilities, lets the main window call every command, the sticky window exactly its own
//! commands, and refuses every other window.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use memry_tauri::registry;
use serde_json::Value;
use specta_typescript::Typescript;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::utils::config::CapabilityEntry;
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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
fn only_main_sticky_and_e2e_builds_get_capabilities_with_app_commands() {
    let set = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect();
    let enabled = strings(&read_json("tauri.conf.json")["app"]["security"]["capabilities"]);
    assert_eq!(enabled, set(&["main", "sticky"]));
    let main = read_json("capabilities/main.json");
    assert_eq!(strings(&main["windows"]), set(&["main"]));
    assert!(strings(&main["permissions"]).contains("app-all"));
    let sticky = read_json("capabilities/sticky.json");
    assert_eq!(strings(&sticky["windows"]), set(&["sticky"]));
    assert_eq!(
        strings(&sticky["permissions"]),
        set(&[
            "core:default",
            "core:window:allow-start-dragging",
            "boot",
            "sticky"
        ])
    );
    assert_eq!(permissions()["sticky"], set(&STICKY));

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

/// App commands the tables expect a window without `app-all` to be refused.
const APP_SAMPLE: [&str; 4] = ["app_info", "log_write", "account_get_info", "crdt_open_doc"];

/// The `sticky` permission: what the sticky renderer calls besides `boot`.
const STICKY: [&str; 10] = [
    "flush_done",
    "flush_ready",
    "settings_get_ai",
    "settings_get_path",
    "sticky_delete_draft",
    "sticky_get_session",
    "sticky_list_drafts",
    "sticky_resize",
    "sticky_save_draft",
    "sticky_tuck",
];

/// Labels no capability names in either config.
const NO_CAPABILITY: [&str; 5] = [
    "preboot",
    "pdf-print-1",
    "sticky-tab",
    "quick-capture",
    "unknown",
];

/// Each window label with the commands it must reach and the commands it must be refused.
fn table(e2e: bool) -> Vec<(&'static str, Vec<String>, Vec<String>)> {
    let permissions = permissions();
    let app_all: Vec<String> = permissions["app-all"].iter().cloned().collect();
    let e2e_all: Vec<String> = permissions["e2e-all"].iter().cloned().collect();
    let names = |names: &[&str]| {
        names
            .iter()
            .map(|name| (*name).to_owned())
            .collect::<Vec<_>>()
    };
    let none_of_them = [names(&APP_SAMPLE), names(&["e2e_app_info"])].concat();
    // The sticky reaches exactly `boot` + `sticky` of the app commands and is refused the rest.
    let sticky: BTreeSet<String> = permissions["boot"]
        .iter()
        .cloned()
        .chain(names(&STICKY))
        .collect();
    let sticky_reaches: Vec<String> = sticky.iter().cloned().collect();
    let sticky_refused: Vec<String> = app_all
        .iter()
        .filter(|command| !sticky.contains(*command))
        .cloned()
        .collect();
    let mut rows = if e2e {
        let everything = [app_all, e2e_all.clone()].concat();
        vec![
            ("main", everything.clone(), names(&["not_a_command"])),
            ("e2e-1", everything, names(&["not_a_command"])),
            // `startup-recovery.e2e.ts` drives the startup-error window through `e2e_*` calls.
            ("startup-error", e2e_all.clone(), names(&APP_SAMPLE)),
            // `sticky.e2e.ts` calls `e2e_*` with the sticky window selected.
            ("sticky", [sticky_reaches, e2e_all].concat(), sticky_refused),
        ]
    } else {
        vec![
            (
                "main",
                app_all,
                names(&["e2e_app_info", "e2e_vault_write_outside", "not_a_command"]),
            ),
            ("startup-error", Vec::new(), none_of_them.clone()),
            ("e2e-1", Vec::new(), none_of_them.clone()),
            (
                "sticky",
                sticky_reaches,
                [sticky_refused, names(&["e2e_app_info"])].concat(),
            ),
        ]
    };
    for label in NO_CAPABILITY {
        rows.push((label, Vec::new(), none_of_them.clone()));
    }
    rows
}

/// The inline capabilities of `tauri.e2e.conf.json`, without the `wdio` plugin permissions: the
/// plugin, and so its ACL manifest, exists only in an `e2e` build, and they grant no app command.
fn e2e_capabilities() -> Vec<String> {
    read_json("tauri.e2e.conf.json")["app"]["security"]["capabilities"]
        .as_array()
        .expect("e2e capabilities")
        .iter()
        .filter(|capability| capability.is_object())
        .map(|capability| {
            let mut capability = capability.clone();
            capability["permissions"]
                .as_array_mut()
                .expect("permissions")
                .retain(|permission| !permission.as_str().is_some_and(|p| p.starts_with("wdio")));
            capability.to_string()
        })
        .collect()
}

/// Checks every row of the table on the resolved ACL. The e2e config's capabilities are added at
/// run time unless the build already has them (`--features e2e` with the e2e `TAURI_CONFIG`, as
/// `pnpm build:e2e` passes); such a build checks the e2e table in both tests.
fn check_table(e2e: bool) {
    let app = app();
    let built_in = app.config().app.security.capabilities.iter().any(
        |entry| matches!(entry, CapabilityEntry::Inlined(capability) if capability.identifier == "e2e"),
    );
    if e2e && !built_in {
        for capability in e2e_capabilities() {
            app.add_capability(capability).expect("e2e capability");
        }
    }
    let refused = |result: Result<(), String>| result.is_err_and(|e| e.contains("not allowed"));
    for (label, reaches, refuses) in table(e2e || built_in) {
        let window = window(&app, label);
        for command in &reaches {
            assert_eq!(
                call(&window, command),
                Ok(()),
                "{label} must reach {command}"
            );
        }
        for command in &refuses {
            assert!(
                refused(call(&window, command)),
                "{label} must not reach {command}"
            );
        }
    }
}

#[test]
fn each_window_reaches_only_its_commands_in_a_release_build() {
    check_table(false);
}

#[test]
fn each_window_reaches_only_its_commands_in_an_e2e_build() {
    check_table(true);
}
