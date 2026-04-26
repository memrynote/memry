use memry_desktop_tauri_lib::vault::watcher::{self, VaultEvent, VaultEventKind};
use std::fs;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

fn make_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn detects_new_file_within_debounce_window() {
    let vault = make_vault();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = watcher::start(vault.path(), tx).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    fs::write(vault.path().join("notes/new.md"), "hello").unwrap();

    let event: VaultEvent = timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("timed out waiting for vault-changed")
        .expect("channel closed");

    assert!(event.relative_path.ends_with("new.md"));
    assert!(matches!(
        event.kind,
        VaultEventKind::Created | VaultEventKind::Modified
    ));

    drop(handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn debounces_rapid_writes_to_same_file() {
    let vault = make_vault();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = watcher::start(vault.path(), tx).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let path = vault.path().join("notes/burst.md");
    for i in 0..5 {
        fs::write(&path, format!("v{i}")).unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let mut count = 0;
    let mut total = Duration::from_millis(0);
    while total < Duration::from_secs(2) {
        match timeout(Duration::from_millis(400), rx.recv()).await {
            Ok(Some(_)) => count += 1,
            _ => break,
        }
        total += Duration::from_millis(400);
    }
    assert!(count >= 1, "should fire at least once");
    assert!(
        count <= 3,
        "debounce should coalesce rapid writes (got {count})"
    );

    drop(handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn ignores_dot_memry_writes() {
    let vault = make_vault();
    fs::create_dir_all(vault.path().join(".memry")).unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = watcher::start(vault.path(), tx).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    fs::write(vault.path().join(".memry/data.db"), "x").unwrap();

    let event = timeout(Duration::from_millis(500), rx.recv()).await;
    assert!(event.is_err(), "must not emit for .memry/ writes");

    drop(handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn detects_deletion() {
    let vault = make_vault();
    let path = vault.path().join("notes/del.md");
    fs::write(&path, "x").unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = watcher::start(vault.path(), tx).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    fs::remove_file(&path).unwrap();

    let mut saw_delete = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        match timeout(Duration::from_millis(300), rx.recv()).await {
            Ok(Some(ev)) if matches!(ev.kind, VaultEventKind::Deleted) => {
                saw_delete = true;
                break;
            }
            Ok(Some(_)) => continue,
            _ => break,
        }
    }
    assert!(saw_delete, "expected a Deleted event");

    drop(handle);
}
