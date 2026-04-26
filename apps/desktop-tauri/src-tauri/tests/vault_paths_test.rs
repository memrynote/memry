use memry_desktop_tauri_lib::vault::paths;
use std::fs;
use std::os::unix::fs as unix_fs;

fn make_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();
    fs::create_dir_all(dir.path().join("journal")).unwrap();
    dir
}

#[test]
fn rejects_dotdot_escape() {
    let vault = make_vault();
    let bad = "../outside.md";
    let err = paths::resolve_in_vault(vault.path(), bad).unwrap_err();
    assert!(matches!(
        err,
        memry_desktop_tauri_lib::error::AppError::PathEscape(_)
    ));
}

#[test]
fn rejects_absolute_outside_vault() {
    let vault = make_vault();
    let bad = "/etc/passwd";
    let err = paths::resolve_in_vault(vault.path(), bad).unwrap_err();
    assert!(matches!(
        err,
        memry_desktop_tauri_lib::error::AppError::PathEscape(_)
    ));
}

#[test]
fn allows_normal_relative_path() {
    let vault = make_vault();
    let ok = paths::resolve_in_vault(vault.path(), "notes/hello.md").unwrap();
    assert!(ok.starts_with(vault.path()));
    assert!(ok.ends_with("notes/hello.md"));
}

#[test]
fn rejects_symlink_escape() {
    let vault = make_vault();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.md");
    fs::write(&secret, "secret").unwrap();
    let link_path = vault.path().join("notes").join("link.md");
    unix_fs::symlink(&secret, &link_path).unwrap();
    let err = paths::resolve_in_vault(vault.path(), "notes/link.md").unwrap_err();
    assert!(matches!(
        err,
        memry_desktop_tauri_lib::error::AppError::PathEscape(_)
    ));
}

#[test]
fn rejects_hidden_dot_memry_directory() {
    let vault = make_vault();
    let err = paths::resolve_in_vault(vault.path(), ".memry/data.db").unwrap_err();
    assert!(matches!(
        err,
        memry_desktop_tauri_lib::error::AppError::PathEscape(_)
    ));
}

#[test]
fn rejects_unsupported_extension() {
    let vault = make_vault();
    let err = paths::resolve_supported(vault.path(), "notes/hello.exe").unwrap_err();
    assert!(matches!(
        err,
        memry_desktop_tauri_lib::error::AppError::Validation(_)
    ));
}

#[test]
fn allows_supported_extensions() {
    let vault = make_vault();
    for ext in [
        "md", "png", "jpg", "jpeg", "gif", "webp", "pdf", "mp3", "mp4", "wav", "mov",
    ] {
        let rel = format!("notes/hello.{ext}");
        paths::resolve_supported(vault.path(), &rel)
            .unwrap_or_else(|e| panic!("{ext} should be supported: {e}"));
    }
}

#[test]
fn to_relative_path_normalizes_separators() {
    let vault = make_vault();
    let abs = vault.path().join("notes").join("foo.md");
    let rel = paths::to_relative_path(vault.path(), &abs).unwrap();
    assert_eq!(rel, "notes/foo.md");
}

#[test]
fn to_relative_path_rejects_outside_vault() {
    let vault = make_vault();
    let outside = std::path::PathBuf::from("/etc/passwd");
    assert!(paths::to_relative_path(vault.path(), &outside).is_none());
}
