use std::fs;

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
    let sources = detect_sources(temp.path(), temp.path());
    assert!(sources.obsidian_vaults.is_empty());
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
    let mut body =
        serde_json::json!({ "vaults": { "a": { "path": work } }, "pad": "" }).to_string();
    let pad = " ".repeat(OBSIDIAN_REGISTRY_CAP as usize);
    body.insert_str(body.len() - 1, &pad);
    let registry = registry_with(temp.path(), &body);
    assert!(read_obsidian_vaults(&registry).is_empty());

    let at_cap = format!(
        "{}{}",
        serde_json::json!({ "vaults": { "a": { "path": work } } }),
        " ".repeat(64)
    );
    assert_eq!(
        read_obsidian_vaults(&registry_with(temp.path(), &at_cap)).len(),
        1
    );
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
        detect_sources(temp.path(), temp.path())
            .installed_apps
            .is_empty()
    );
}

fn client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    crate::http::builder().no_proxy().build().unwrap()
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
    let (base, mut requests) = serve("200 OK").await;
    assert!(local_server_answers(&client(), &base).await);
    assert_eq!(requests.recv().await.unwrap(), "GET /v1/models HTTP/1.1");
}

#[tokio::test]
async fn an_error_status_or_closed_port_does_not_answer() {
    let (base, _requests) = serve("404 Not Found").await;
    assert!(!local_server_answers(&client(), &base).await);

    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", closed.local_addr().unwrap());
    drop(closed);
    assert!(!local_server_answers(&client(), &base).await);
}

#[tokio::test(start_paused = true)]
async fn a_server_that_never_answers_times_out() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    // Accepts and holds the connection without a reply; the probe's own deadline ends the wait.
    let held = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
        drop(socket);
    });
    assert!(!local_server_answers(&client(), &base).await);
    held.abort();
}
