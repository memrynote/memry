use memry_desktop_tauri_lib::vault::fs as vfs;
use memry_desktop_tauri_lib::vault::paths;
use std::fs;

fn make_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();
    dir
}

#[tokio::test]
async fn atomic_write_creates_file() {
    let vault = make_vault();
    let abs = paths::resolve_in_vault(vault.path(), "notes/hello.md").unwrap();
    vfs::atomic_write(&abs, "# hello\n").await.unwrap();
    let read_back = fs::read_to_string(&abs).unwrap();
    assert_eq!(read_back, "# hello\n");
}

#[tokio::test]
async fn atomic_write_replaces_existing_file() {
    let vault = make_vault();
    let abs = paths::resolve_in_vault(vault.path(), "notes/hello.md").unwrap();
    vfs::atomic_write(&abs, "first").await.unwrap();
    vfs::atomic_write(&abs, "second").await.unwrap();
    let read_back = fs::read_to_string(&abs).unwrap();
    assert_eq!(read_back, "second");
}

#[tokio::test]
async fn atomic_write_creates_parent_dirs() {
    let vault = make_vault();
    let abs = paths::resolve_in_vault(vault.path(), "notes/sub/deep/foo.md").unwrap();
    vfs::atomic_write(&abs, "x").await.unwrap();
    assert!(abs.exists());
}

#[tokio::test]
async fn atomic_write_cleans_up_temp_on_failure() {
    let vault = make_vault();
    // Write a directory at the target path, then try to atomic-write a
    // file there. The rename must fail and leave no `.tmp.<hex>` files
    // in the parent.
    let target_dir = vault.path().join("notes").join("blocking");
    fs::create_dir_all(&target_dir).unwrap();

    let abs = vault.path().join("notes").join("blocking");
    let result = vfs::atomic_write(&abs, "x").await;
    assert!(result.is_err());

    let leftover: Vec<_> = fs::read_dir(vault.path().join("notes"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
        .collect();
    assert!(leftover.is_empty(), "temp file leaked: {leftover:?}");
}

#[tokio::test]
async fn safe_read_returns_none_for_missing() {
    let vault = make_vault();
    let abs = vault.path().join("notes").join("missing.md");
    let result = vfs::safe_read(&abs).await.unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn safe_read_returns_content_for_existing() {
    let vault = make_vault();
    let abs = vault.path().join("notes").join("hi.md");
    fs::write(&abs, "hi").unwrap();
    let result = vfs::safe_read(&abs).await.unwrap();
    assert_eq!(result.as_deref(), Some("hi"));
}

#[tokio::test]
async fn list_supported_files_skips_hidden_and_unsupported() {
    let vault = make_vault();
    fs::write(vault.path().join("notes/keep.md"), "k").unwrap();
    fs::write(vault.path().join("notes/.hidden.md"), "h").unwrap();
    fs::write(vault.path().join("notes/skip.exe"), "x").unwrap();
    fs::create_dir_all(vault.path().join(".memry")).unwrap();
    fs::write(vault.path().join(".memry/data.db"), "db").unwrap();
    let entries = vfs::list_supported_files(vault.path()).await.unwrap();
    let names: Vec<&str> = entries.iter().map(String::as_str).collect();
    assert!(names.contains(&"notes/keep.md"));
    assert!(!names.iter().any(|n| n.contains(".hidden")));
    assert!(!names.iter().any(|n| n.ends_with(".exe")));
    assert!(!names.iter().any(|n| n.starts_with(".memry")));
}

#[test]
fn content_hash_is_stable_for_same_content() {
    let h1 = vfs::content_hash("hello world");
    let h2 = vfs::content_hash("hello world");
    assert_eq!(h1, h2);
    assert_eq!(h1.len(), 64); // sha256 hex
}

#[test]
fn content_hash_differs_for_different_content() {
    assert_ne!(vfs::content_hash("a"), vfs::content_hash("b"));
}
