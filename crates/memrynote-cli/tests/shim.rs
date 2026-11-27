//! The terminal command shim, ported from `apps/desktop/src/main/cli/terminal-command.test.ts`.
//! Every case runs in its own temp dir; nothing touches a real PATH directory or `$HOME`.

use std::fs;
use std::path::{Path, PathBuf};

use memrynote_cli::shim::{
    self, Launcher, Platform, SHIM_MARKER, ShimError, ShimOptions, default_bin_dirs,
};
use tempfile::TempDir;

/// The host's PATH delimiter, which Electron used for every platform but win32.
const SEP: char = if cfg!(windows) { ';' } else { ':' };

fn options(platform: Platform, bin: &Path, target: PathBuf) -> ShimOptions {
    ShimOptions {
        platform,
        launcher: Launcher::Sidecar(target),
        path_env: bin.to_string_lossy().into_owned(),
        bin_dirs: vec![bin.to_path_buf()],
    }
}

fn unix_case(platform: Platform) -> (TempDir, PathBuf, ShimOptions) {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    let target = root
        .path()
        .join("Memrynote.app/Contents/MacOS/memrynote-cli");
    let options = options(platform, &bin, target);
    (root, bin, options)
}

fn not_owned(result: Result<shim::ShimStatus, ShimError>, path: &Path) {
    match result {
        Err(error @ ShimError::NotOwned(_)) => assert_eq!(
            error.to_string(),
            format!(
                "{} already exists and was not created by memrynote",
                path.display()
            )
        ),
        other => panic!("expected NotOwned for {}, got {other:?}", path.display()),
    }
}

#[test]
fn install_writes_a_sidecar_shim_on_path() {
    let (_root, bin, options) = unix_case(Platform::Darwin);
    let status = shim::install(&options).unwrap();

    assert!(status.installed);
    assert!(status.in_path);
    assert_eq!(status.path_hint, None);
    assert_eq!(status.shim_path, bin.join("memrynote"));
    assert_eq!(status.target_path, options.launcher.target());
    assert_eq!(
        fs::read_to_string(&status.shim_path).unwrap(),
        shim::render(Platform::Darwin, &options.launcher)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&status.shim_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }
}

#[test]
fn reinstall_replaces_an_owned_shim_with_a_moved_target() {
    let (root, _bin, mut options) = unix_case(Platform::Linux);
    let first = shim::install(&options).unwrap();
    assert!(shim::install(&options).unwrap().installed);

    options.launcher = Launcher::Sidecar(root.path().join("moved/memrynote-cli"));
    assert!(!shim::status(&options).unwrap().installed);
    let second = shim::install(&options).unwrap();

    assert!(second.installed);
    assert_eq!(second.shim_path, first.shim_path);
    assert_eq!(
        fs::read_to_string(&second.shim_path).unwrap(),
        shim::render(Platform::Linux, &options.launcher)
    );
}

#[test]
fn install_refuses_a_foreign_file_and_leaves_it() {
    let (_root, bin, options) = unix_case(Platform::Linux);
    fs::create_dir_all(&bin).unwrap();
    let path = bin.join("memrynote");
    fs::write(&path, "#!/bin/sh\necho not memry\n").unwrap();

    not_owned(shim::install(&options), &path);
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "#!/bin/sh\necho not memry\n"
    );
    assert!(!shim::status(&options).unwrap().installed);
}

#[test]
fn a_marker_mismatch_is_not_ours() {
    let (_root, bin, options) = unix_case(Platform::Darwin);
    fs::create_dir_all(&bin).unwrap();
    let path = bin.join("memrynote");
    let lookalike = "#!/bin/sh\n# Memry terminal shim\nexec /usr/bin/true \"$@\"\n";
    fs::write(&path, lookalike).unwrap();

    not_owned(shim::install(&options), &path);
    not_owned(shim::uninstall(&options), &path);
    assert!(shim::refresh(&options).is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), lookalike);
}

#[test]
fn an_outdated_owned_shim_is_not_installed() {
    let (_root, bin, options) = unix_case(Platform::Linux);
    fs::create_dir_all(&bin).unwrap();
    fs::write(
        bin.join("memrynote"),
        format!("#!/bin/sh\n# {SHIM_MARKER}\nexec \"/old/memrynote\" --cli \"$@\"\n"),
    )
    .unwrap();

    assert!(!shim::status(&options).unwrap().installed);
}

#[cfg(unix)]
#[test]
fn a_symlink_planted_at_the_shim_path_is_never_followed() {
    let (root, bin, options) = unix_case(Platform::Linux);
    fs::create_dir_all(&bin).unwrap();
    // The worst case: the link points at a file that holds the marker.
    let victim = root.path().join("victim");
    let victim_text = format!("# {SHIM_MARKER}\nprecious\n");
    fs::write(&victim, &victim_text).unwrap();
    let path = bin.join("memrynote");
    std::os::unix::fs::symlink(&victim, &path).unwrap();

    assert!(!shim::status(&options).unwrap().installed);
    not_owned(shim::install(&options), &path);
    not_owned(shim::uninstall(&options), &path);
    assert!(shim::refresh(&options).is_empty());
    assert!(
        fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(&victim).unwrap(), victim_text);
}

#[cfg(unix)]
#[test]
fn a_dangling_symlink_is_not_created_through() {
    let (root, bin, options) = unix_case(Platform::Darwin);
    fs::create_dir_all(&bin).unwrap();
    let elsewhere = root.path().join("elsewhere");
    let path = bin.join("memrynote");
    std::os::unix::fs::symlink(&elsewhere, &path).unwrap();

    not_owned(shim::install(&options), &path);
    assert!(!elsewhere.exists());
}

#[test]
fn uninstall_removes_only_our_shim() {
    let (_root, bin, options) = unix_case(Platform::Linux);
    shim::install(&options).unwrap();

    let status = shim::uninstall(&options).unwrap();
    assert!(!status.installed);
    assert!(!bin.join("memrynote").exists());
    // Nothing there: still fine.
    assert!(!shim::uninstall(&options).unwrap().installed);

    fs::write(bin.join("memrynote"), "#!/bin/sh\necho mine\n").unwrap();
    not_owned(shim::uninstall(&options), &bin.join("memrynote"));
    assert_eq!(
        fs::read_to_string(bin.join("memrynote")).unwrap(),
        "#!/bin/sh\necho mine\n"
    );
}

#[test]
fn refresh_rewrites_legacy_electron_shims_and_skips_the_rest() {
    let root = tempfile::tempdir().unwrap();
    let legacy_dir = root.path().join("legacy");
    let foreign_dir = root.path().join("foreign");
    let empty_dir = root.path().join("empty");
    for dir in [&legacy_dir, &foreign_dir] {
        fs::create_dir_all(dir).unwrap();
    }
    let legacy = format!(
        "#!/bin/sh\n# {SHIM_MARKER}\nexec \"/opt/MemryNote/memrynote\" --ozone-platform=headless --disable-gpu --cli \"$@\"\n"
    );
    fs::write(legacy_dir.join("memrynote"), &legacy).unwrap();
    fs::write(foreign_dir.join("memrynote"), "#!/bin/sh\necho other\n").unwrap();
    let options = ShimOptions {
        platform: Platform::Linux,
        launcher: Launcher::Sidecar(root.path().join("app/memrynote-cli")),
        path_env: String::new(),
        bin_dirs: vec![legacy_dir.clone(), foreign_dir.clone(), empty_dir.clone()],
    };

    assert!(shim::refresh(&options).is_empty());
    assert_eq!(
        fs::read_to_string(legacy_dir.join("memrynote")).unwrap(),
        shim::render(Platform::Linux, &options.launcher)
    );
    assert_eq!(
        fs::read_to_string(foreign_dir.join("memrynote")).unwrap(),
        "#!/bin/sh\necho other\n"
    );
    assert!(!empty_dir.exists());
}

#[test]
fn templates_match_the_design() {
    let unix = Launcher::Sidecar(PathBuf::from(
        "/Applications/MemryNote.app/Contents/MacOS/memrynote-cli",
    ));
    assert_eq!(
        shim::render(Platform::Darwin, &unix),
        "#!/bin/sh\n# Memry terminal command shim\nexec \"/Applications/MemryNote.app/Contents/MacOS/memrynote-cli\" \"$@\"\n"
    );
    assert_eq!(
        shim::render(Platform::Linux, &unix),
        shim::render(Platform::Darwin, &unix),
        "the sidecar needs no Electron headless switches"
    );
    let sidecar = Launcher::Sidecar(PathBuf::from(
        r"C:\Users\a\AppData\Local\MemryNote\current\memrynote-cli.exe",
    ));
    assert_eq!(
        shim::render(Platform::Win32, &sidecar),
        "@echo off\r\n@rem Memry terminal command shim\r\n\"C:\\Users\\a\\AppData\\Local\\MemryNote\\current\\memrynote-cli.exe\" %*\r\n"
    );
    let image = Launcher::AppImage(PathBuf::from("/home/a/Apps/Memry$`\"\\.AppImage"));
    assert_eq!(
        shim::render(Platform::Linux, &image),
        "#!/bin/sh\n# Memry terminal command shim\nexec \"/home/a/Apps/Memry\\$\\`\\\"\\\\.AppImage\" --cli \"$@\"\n"
    );
}

#[test]
fn windows_shim_is_a_cmd_file_in_windows_apps() {
    let root = tempfile::tempdir().unwrap();
    let dirs = default_bin_dirs(Platform::Win32, &root.path().join("home"), root.path());
    let windows_apps = root.path().join("Microsoft").join("WindowsApps");
    assert_eq!(dirs, vec![windows_apps.clone()]);
    let mut options = options(
        Platform::Win32,
        &windows_apps,
        root.path().join("memrynote-cli.exe"),
    );
    options.path_env = windows_apps.to_string_lossy().to_uppercase();

    let status = shim::install(&options).unwrap();
    assert!(status.installed);
    assert!(status.in_path, "PATH compares case-insensitively on win32");
    assert_eq!(status.shim_path, windows_apps.join("memrynote.cmd"));
}

#[test]
fn prefers_a_writable_dir_on_path_and_hints_otherwise() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let on_path = root.path().join("on-path");
    let mut options = ShimOptions {
        platform: Platform::Linux,
        launcher: Launcher::Sidecar(root.path().join("memrynote-cli")),
        path_env: format!("/nowhere{SEP}{SEP}{}", on_path.display()),
        bin_dirs: vec![first.clone(), on_path.clone()],
    };
    assert_eq!(shim::status(&options).unwrap().bin_dir, on_path);

    options.path_env = String::new();
    let status = shim::status(&options).unwrap();
    assert_eq!(status.bin_dir, first);
    assert!(!status.in_path);
    assert_eq!(
        status.path_hint,
        Some(format!(
            "Add {} to PATH, then reopen your terminal.",
            first.display()
        ))
    );
}
