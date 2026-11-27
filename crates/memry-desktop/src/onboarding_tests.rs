use std::fs;
#[cfg(unix)]
use std::io::{self, Write};

use memry_test_kit::{on_small_stack, proptest_config};
use proptest::prelude::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

fn registry_with(dir: &Path, body: &str) -> PathBuf {
    let registry = dir.join("obsidian").join("obsidian.json");
    fs::create_dir_all(registry.parent().unwrap()).unwrap();
    fs::write(&registry, body).unwrap();
    registry
}

fn vault_dir(root: &Path, name: &str) -> String {
    let path = root.join(name);
    fs::create_dir_all(&path).unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn lists_existing_vaults_in_registry_order_named_by_folder() {
    let temp = tempfile::tempdir().unwrap();
    let work = vault_dir(temp.path(), "Work");
    let home = vault_dir(temp.path(), "Home Notes");
    let gone = temp.path().join("Deleted").to_string_lossy().into_owned();
    let body = serde_json::json!({
        "vaults": {
            "f00d": { "path": work, "ts": 1, "open": true },
            "beef": { "path": gone, "ts": 2 },
            "0a0a": { "path": format!("{home}/") },
            "c0de": { "ts": 3 },
            "d00d": { "path": 42 }
        }
    });
    let registry = registry_with(temp.path(), &body.to_string());

    let vaults = read_obsidian_vaults(&registry);

    assert_eq!(
        vaults,
        vec![
            OnboardingObsidianVault {
                name: "Work".into(),
                path: work
            },
            OnboardingObsidianVault {
                name: "Home Notes".into(),
                path: format!("{home}/")
            },
        ]
    );
}

#[test]
fn a_missing_registry_is_no_vaults() {
    let temp = tempfile::tempdir().unwrap();
    assert!(read_obsidian_vaults(&temp.path().join("obsidian.json")).is_empty());
    let sources = detect_sources(temp.path(), &[temp.path().join("Applications")]);
    assert!(sources.obsidian_vaults.is_empty());
    assert!(sources.installed_apps.is_empty());
}

#[test]
fn a_registry_electron_cannot_read_is_no_vaults() {
    let temp = tempfile::tempdir().unwrap();
    let work = vault_dir(temp.path(), "Work");
    // Each of these throws inside Electron's try (or parses to no `vaults`), so it lists nothing.
    for body in [
        "{not json".to_owned(),
        "null".to_owned(),
        "[1, 2]".to_owned(),
        r#"{"vaults": null}"#.to_owned(),
        r#"{"vaults": "abc"}"#.to_owned(),
        format!(r#"{{"vaults": {{"a": {{"path": {work:?}}}, "b": null}}}}"#),
        format!("\u{feff}{{\"vaults\": {{\"a\": {{\"path\": {work:?}}}}}}}"),
    ] {
        let registry = registry_with(temp.path(), &body);
        assert!(read_obsidian_vaults(&registry).is_empty(), "{body}");
    }
}

#[test]
fn an_array_of_vaults_reads_like_object_values() {
    let temp = tempfile::tempdir().unwrap();
    let work = vault_dir(temp.path(), "Work");
    let registry = registry_with(
        temp.path(),
        &serde_json::json!({ "vaults": [{ "path": work }, 7, "x"] }).to_string(),
    );
    assert_eq!(read_obsidian_vaults(&registry).len(), 1);
}

#[test]
fn registry_over_the_cap_is_refused_unparsed() {
    let temp = tempfile::tempdir().unwrap();
    let work = vault_dir(temp.path(), "Work");
    let json = serde_json::json!({ "vaults": { "a": { "path": work } } }).to_string();
    // Spaces after the document keep it valid JSON, so a read cut short anywhere still parses.
    let padded = |len: u64| format!("{json}{}", " ".repeat(len as usize - json.len()));

    let at_cap = registry_with(temp.path(), &padded(OBSIDIAN_REGISTRY_CAP));
    assert_eq!(read_obsidian_vaults(&at_cap).len(), 1);
    let over = registry_with(temp.path(), &padded(OBSIDIAN_REGISTRY_CAP + 1));
    assert!(read_obsidian_vaults(&over).is_empty());
}

/// A registry that never ends is refused once the read passes the cap, not read to its end.
#[cfg(unix)]
#[test]
fn the_registry_read_stops_past_the_cap() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("obsidian.json");
    let made = std::process::Command::new("mkfifo")
        .arg(&registry)
        .status()
        .unwrap();
    assert!(made.success());
    let fifo = registry.clone();
    let writer = std::thread::spawn(move || {
        let mut pipe = fs::OpenOptions::new().write(true).open(&fifo).unwrap();
        // Twice the cap: the write completes only when the reader takes all of it.
        pipe.write_all(&vec![b' '; 2 * OBSIDIAN_REGISTRY_CAP as usize])
    });

    assert!(read_obsidian_vaults(&registry).is_empty());
    let written = writer.join().unwrap().map_err(|error| error.kind());
    assert_eq!(written, Err(io::ErrorKind::BrokenPipe));
}

#[test]
fn deep_nesting_fails_closed_on_a_small_stack() {
    let temp = tempfile::tempdir().unwrap();
    let depth = 100_000;
    let body = format!(
        r#"{{"vaults": {{"a": {}{}}}}}"#,
        "[".repeat(depth),
        "]".repeat(depth)
    );
    let registry = registry_with(temp.path(), &body);
    let vaults = on_small_stack(move || read_obsidian_vaults(&registry));
    assert!(vaults.is_empty());
}

proptest! {
    #![proptest_config(proptest_config(64))]

    #[test]
    fn any_registry_bytes_read_without_panic(bytes in proptest::collection::vec(any::<u8>(), 0..512)) {
        let temp = tempfile::tempdir().unwrap();
        let registry = temp.path().join("obsidian.json");
        fs::write(&registry, &bytes).unwrap();
        let vaults = read_obsidian_vaults(&registry);
        // A vault is a path the file names, so there are never more vaults than bytes.
        prop_assert!(vaults.len() <= bytes.len());
    }
}

#[test]
fn installed_apps_follow_the_mac_apps_table() {
    let temp = tempfile::tempdir().unwrap();
    let system = temp.path().join("Applications");
    let user = temp.path().join("home").join("Applications");
    for bundle in [
        system.join("Notion.app"),
        user.join("NotePlan.app"),
        user.join("TickTick.app"),
        system.join("Obsidian.app"),
    ] {
        fs::create_dir_all(bundle).unwrap();
    }
    assert_eq!(
        installed_mac_apps(&[system, user]),
        vec!["notion", "noteplan", "ticktick"]
    );
}

#[cfg(not(target_os = "macos"))]
#[test]
fn installed_apps_are_mac_only() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("Applications").join("Notion.app")).unwrap();
    assert!(
        detect_sources(temp.path(), &[temp.path().join("Applications")])
            .installed_apps
            .is_empty()
    );
}

#[test]
fn only_a_folder_with_memry_is_a_vault() {
    let temp = tempfile::tempdir().unwrap();
    assert!(!is_memry_vault(temp.path()));
    fs::create_dir(temp.path().join(".memry")).unwrap();
    assert!(is_memry_vault(temp.path()));
}

/// Electron's `existsSync` answers `false` for a folder it cannot look into (`EACCES`).
#[cfg(unix)]
#[test]
fn a_folder_that_cannot_be_looked_into_is_not_a_vault() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("Locked");
    fs::create_dir_all(folder.join(".memry")).unwrap();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o000)).unwrap();
    let locked = is_memry_vault(&folder);
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!locked);
}

fn install_crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// A server that answers each connection with `status`, and sends the request line it saw.
async fn serve(status: &'static str) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let (seen, requests) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 1024];
            let read = socket.read(&mut buffer).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buffer[..read]);
            let _ = seen.send(head.lines().next().unwrap_or_default().to_owned());
            let response = format!("HTTP/1.1 {status}\r\ncontent-length: 2\r\n\r\n{{}}");
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (base, requests)
}

#[tokio::test]
async fn a_server_that_lists_models_answers() {
    install_crypto();
    let (base, mut requests) = serve("200 OK").await;
    assert!(local_server_answers(&base).await);
    assert_eq!(requests.recv().await.unwrap(), "GET /v1/models HTTP/1.1");
}

#[tokio::test]
async fn an_error_status_or_closed_port_does_not_answer() {
    install_crypto();
    let (base, _requests) = serve("404 Not Found").await;
    assert!(!local_server_answers(&base).await);

    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", closed.local_addr().unwrap());
    drop(closed);
    assert!(!local_server_answers(&base).await);
}

#[tokio::test(start_paused = true)]
async fn a_server_that_never_answers_times_out() {
    install_crypto();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    // Accepts and holds the connection without a reply; the probe's own deadline ends the wait.
    let held = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
        drop(socket);
    });
    assert!(!local_server_answers(&base).await);
    held.abort();
}

const PROXY_CHILD: &str = "onboarding::tests::the_probe_child_asks_the_server_directly";
const PROBE_TARGET: &str = "MEMRY_TEST_PROBE_TARGET";

#[tokio::test]
async fn the_probe_ignores_a_configured_proxy() {
    let (base, _requests) = serve("200 OK").await;
    let (proxy, mut proxied) = serve("404 Not Found").await;
    let proxy = proxy.trim_end_matches("/v1").to_owned();
    // The proxy is set in a child process, so no other test of this binary goes through it.
    let status = tokio::task::spawn_blocking(move || {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", PROXY_CHILD, "--nocapture"])
            .env(PROBE_TARGET, &base)
            .env("HTTP_PROXY", &proxy)
            .env("http_proxy", &proxy)
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .status()
    })
    .await
    .unwrap()
    .unwrap();

    assert!(status.success(), "the child's probe failed: {status}");
    assert!(
        proxied.try_recv().is_err(),
        "the probe went through the proxy"
    );
}

#[tokio::test]
#[ignore = "the proxy test runs it in a child process with HTTP_PROXY set"]
async fn the_probe_child_asks_the_server_directly() {
    install_crypto();
    let base = std::env::var(PROBE_TARGET).unwrap();
    assert!(local_server_answers(&base).await);
}
