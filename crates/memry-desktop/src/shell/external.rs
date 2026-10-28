//! Which URLs the shell hands to the OS: port of `isAllowedExternalUrl`
//! (`apps/desktop/src/main/lib/external-url.ts`). Only web and mail schemes, so a link in a note
//! cannot launch `file:`, `smb:` or a custom protocol handler through the OS.

use std::io;
use std::path::Path;

use url::Url;

use super::file_open::{Resolution, resolve_real_under_root};

/// A URL longer than this is not a link a person clicked.
const MAX_URL_LEN: usize = 16 * 1024;

pub fn is_allowed_external_url(raw: &str) -> bool {
    raw.len() <= MAX_URL_LEN
        && Url::parse(raw).is_ok_and(|url| matches!(url.scheme(), "https" | "http" | "mailto"))
}

/// File types the OS runs, installs or mounts when it "opens" them. A note's link or
/// `shell_open_path` must never start a program, so these are refused outright; [`os_action`]
/// reveals any other type off [`OPENABLE_EXTENSIONS`].
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "app",
    "appimage",
    "appinstaller",
    "application",
    "appref-ms",
    "appx",
    "appxbundle",
    "bat",
    "chm",
    "cmd",
    "com",
    "command",
    "cpl",
    "desktop",
    "diagcab",
    "exe",
    "fileloc",
    "hta",
    "img",
    "inetloc",
    "iso",
    "jar",
    "jnlp",
    "js",
    "jse",
    "library-ms",
    "lnk",
    "msc",
    "mpkg",
    "msi",
    "msix",
    "msixbundle",
    "msp",
    "pif",
    "pkg",
    "prefpane",
    "ps1",
    "py",
    "pyw",
    "reg",
    "run",
    "scf",
    "scr",
    "sct",
    "search-ms",
    "searchconnector-ms",
    "settingcontent-ms",
    "sh",
    "terminal",
    "url",
    "vbe",
    "vbs",
    "vhd",
    "vhdx",
    "webloc",
    "workflow",
    "ws",
    "wsc",
    "wsf",
    "wsh",
    "xll",
];

/// Whether opening `path` would run a program: an executable extension (Windows ignores trailing
/// dots and spaces, so `a.exe.` counts), or any folder inside a macOS `.app` bundle.
pub fn is_executable_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split(['/', '\\']).collect();
    let last = segments.len() - 1;
    segments.iter().enumerate().any(|(index, segment)| {
        let name = segment.trim_end_matches(['.', ' ']).to_ascii_lowercase();
        name.rsplit_once('.').is_some_and(|(_, ext)| {
            if index == last {
                EXECUTABLE_EXTENSIONS.contains(&ext)
            } else {
                ext == "app"
            }
        })
    })
}

/// The documents, media and archives a vault holds, which the OS opens in their app. Stricter
/// than Electron, which opened any type: HTML, SVG and XML (a browser runs their script),
/// macro-enabled Office files, fonts (an installer), disk images and source files are revealed.
const OPENABLE_EXTENSIONS: &[&str] = &[
    // Documents.
    "csv", "doc", "docx", "epub", "json", "key", "log", "markdown", "md", "numbers", "odg", "odp",
    "ods", "odt", "pages", "pdf", "ppt", "pptx", "rtf", "tsv", "txt", "xls", "xlsx",
    // Images.
    "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "psd", "tif", "tiff", "webp",
    // Audio and video.
    "3gp", "aac", "aif", "aiff", "avi", "flac", "m4a", "m4v", "mid", "midi", "mkv", "mov", "mp3",
    "mp4", "mpeg", "mpg", "oga", "ogg", "ogv", "opus", "wav", "webm", "wma", "wmv",
    // Archives.
    "7z", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip", "zst",
];

/// What the shell does with a file it was asked to open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsAction {
    /// Opened in its app.
    Open,
    /// Shown in the file manager, where the person can open it deliberately.
    Reveal,
    /// A program, never handed to the OS.
    Refuse,
}

/// What to do with `real`, the canonical path the OS is handed. Read once more here, so a link
/// swapped in since the path resolved is refused.
pub fn os_action(real: &Path) -> io::Result<OsAction> {
    let meta = std::fs::symlink_metadata(real)?;
    if meta.file_type().is_symlink() || is_executable_path(&real.to_string_lossy()) {
        return Ok(OsAction::Refuse);
    }
    let name = real
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    let name = name.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    let extension = name
        .rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .map(|(_, ext)| ext);
    Ok(match extension {
        Some(ext) if OPENABLE_EXTENSIONS.contains(&ext) => OsAction::Open,
        Some(_) => OsAction::Reveal,
        None if meta.is_dir() => OsAction::Open,
        // `open` on macOS runs an extensionless file with an exec bit in Terminal.
        None if is_unix_executable(&meta) => OsAction::Refuse,
        None => OsAction::Reveal,
    })
}

#[cfg(unix)]
fn is_unix_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_unix_executable(_: &std::fs::Metadata) -> bool {
    false
}

/// Where `rel` names under `root` for the OS to open or reveal. The empty path is the root itself,
/// which [`resolve_real_under_root`] does not take: a person may open or reveal their vault
/// folder. The path is the canonical one, with no link left in it, root included, so swapping a
/// link after this check cannot point the OS somewhere else.
pub fn resolve_for_os(root: &Path, rel: &str) -> io::Result<Resolution> {
    if rel.is_empty() {
        return Ok(Resolution::Inside(root.canonicalize()?));
    }
    resolve_real_under_root(root, rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_web_and_mail() {
        assert!(is_allowed_external_url("https://example.com"));
        assert!(is_allowed_external_url("http://example.com"));
        assert!(is_allowed_external_url("mailto:hi@memrynote.com"));
        assert!(is_allowed_external_url("HTTPS://EXAMPLE.COM/a?b=c#d"));
    }

    #[test]
    fn blocks_everything_else() {
        for url in [
            "file:///etc/passwd",
            "smb://host/share",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "memry-file://local/Users/kaan/vault/file.png",
            "vscode://open",
            "",
            "not a url",
            "//example.com",
        ] {
            assert!(!is_allowed_external_url(url), "{url}");
        }
    }

    #[test]
    fn refuses_an_oversize_url() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert!(!is_allowed_external_url(&long));
    }

    #[test]
    fn refuses_a_path_the_os_would_run() {
        for path in [
            "/v/a.command",
            "/v/a.EXE",
            "C:\\v\\a.lnk",
            "/v/a.bat",
            "/v/a.cmd",
            "/v/a.ps1",
            "/v/a.js",
            "/v/a.sh",
            "/v/Tool.app",
            "/v/Tool.app/Contents/MacOS/tool",
            "C:\\v\\a.exe.",
            "C:\\v\\a.exe ",
            // Types a double click runs or installs, on each OS.
            "C:\\v\\a.hta",
            "C:\\v\\Tool.application",
            "C:\\v\\a.settingcontent-ms",
            "C:\\v\\a.chm",
            "C:\\v\\a.scf",
            "C:\\v\\a.msp",
            "C:\\v\\a.jnlp",
            "/v/a.fileloc",
            "/v/a.webloc",
            "/v/a.inetloc",
            "C:\\v\\Link.URL",
            "C:\\v\\a.pif",
            "C:\\v\\a.cpl",
            "C:\\v\\a.msc",
            "C:\\v\\a.reg",
            "C:\\v\\a.wsf",
            "C:\\v\\a.jse",
            "C:\\v\\a.vbe",
            "C:\\v\\a.wsh",
            "C:\\v\\a.appref-ms",
            "/v/a.terminal",
            "/v/Flow.workflow",
            "/v/a.desktop",
            "/v/Tool.AppImage",
            "/v/installer.run",
        ] {
            assert!(is_executable_path(path), "{path}");
        }
        for path in [
            "/v/a.pdf",
            "/v/a.txt",
            "/v/report.shx",
            "/v/js",
            "/v/a.app.pdf",
            "/v/folder.exe/readme.txt",
            "",
        ] {
            assert!(!is_executable_path(path), "{path}");
        }
    }

    #[test]
    fn refuses_the_types_the_deny_list_missed() {
        for path in [
            "C:\\v\\a.py",
            "C:\\v\\a.pyw",
            "C:\\v\\a.iso",
            "C:\\v\\a.img",
            "C:\\v\\a.vhd",
            "C:\\v\\a.vhdx",
            "C:\\v\\a.msix",
            "C:\\v\\a.msixbundle",
            "C:\\v\\a.appx",
            "C:\\v\\a.appxbundle",
            "C:\\v\\a.appinstaller",
            "/v/a.pkg",
            "/v/a.mpkg",
            "/v/Pane.prefPane",
            "C:\\v\\a.wsc",
            "C:\\v\\a.sct",
            "C:\\v\\a.diagcab",
            "C:\\v\\a.library-ms",
            "C:\\v\\a.search-ms",
            "C:\\v\\a.searchconnector-ms",
            "C:\\v\\a.xll",
        ] {
            assert!(is_executable_path(path), "{path}");
        }
    }

    fn action_of(dir: &Path, name: &str) -> OsAction {
        os_action(&dir.join(name)).unwrap()
    }

    #[test]
    fn opens_documents_media_and_archives_and_reveals_anything_else() {
        let dir = tempfile::tempdir().unwrap();
        let names = [
            "a.pdf",
            "a.PDF",
            "a.md",
            "a.txt",
            "a.docx",
            "a.xlsx",
            "a.png",
            "a.HEIC",
            "a.mp3",
            "a.mov",
            "a.zip",
            "a.tar.gz",
            "a.html",
            "a.svg",
            "a.xml",
            "a.docm",
            "a.ttf",
            "a.dmg",
            "a.rs",
            "a.unknown",
            "README",
            ".hidden",
        ];
        for name in names {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        for name in [
            "a.pdf", "a.PDF", "a.md", "a.txt", "a.docx", "a.xlsx", "a.png", "a.HEIC", "a.mp3",
            "a.mov", "a.zip", "a.tar.gz",
        ] {
            assert_eq!(action_of(dir.path(), name), OsAction::Open, "{name}");
        }
        // Script runs in a browser, macros, font installers, disk images, source and the unknown.
        for name in [
            "a.html",
            "a.svg",
            "a.xml",
            "a.docm",
            "a.ttf",
            "a.dmg",
            "a.rs",
            "a.unknown",
            "README",
            ".hidden",
        ] {
            assert_eq!(action_of(dir.path(), name), OsAction::Reveal, "{name}");
        }
    }

    #[test]
    fn refuses_a_program_whatever_it_is_named() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.exe", "a.py", "a.sh"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
            assert_eq!(action_of(dir.path(), name), OsAction::Refuse, "{name}");
        }
        std::fs::create_dir_all(dir.path().join("Tool.app/Contents")).unwrap();
        std::fs::write(dir.path().join("Tool.app/Contents/notes.pdf"), b"x").unwrap();
        assert_eq!(action_of(dir.path(), "Tool.app"), OsAction::Refuse);
        assert_eq!(
            action_of(dir.path(), "Tool.app/Contents/notes.pdf"),
            OsAction::Refuse
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_an_extensionless_file_with_an_exec_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        for name in ["tool", ".tool"] {
            let path = dir.path().join(name);
            std::fs::write(&path, b"#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o744)).unwrap();
            assert_eq!(action_of(dir.path(), name), OsAction::Refuse, "{name}");
        }
        // A document keeps opening when a copy from a FAT volume or a zip left the bit on.
        let pdf = dir.path().join("a.pdf");
        std::fs::write(&pdf, b"%PDF").unwrap();
        std::fs::set_permissions(&pdf, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(action_of(dir.path(), "a.pdf"), OsAction::Open);
    }

    #[test]
    fn opens_a_plain_folder_and_reveals_a_bundle() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["Folder", "Report.pages", "Saver.saver"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        assert_eq!(action_of(dir.path(), "Folder"), OsAction::Open);
        assert_eq!(action_of(dir.path(), "Report.pages"), OsAction::Open);
        assert_eq!(action_of(dir.path(), "Saver.saver"), OsAction::Reveal);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_link_swapped_in_after_the_path_resolved() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tool.sh"), b"x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("tool.sh"), dir.path().join("a.pdf")).unwrap();
        assert_eq!(action_of(dir.path(), "a.pdf"), OsAction::Refuse);
    }

    #[cfg(unix)]
    #[test]
    fn hands_the_os_the_real_path_not_one_through_a_linked_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap().join("vault");
        std::fs::create_dir_all(real.join("attachments")).unwrap();
        std::fs::write(real.join("attachments/a.pdf"), b"%PDF").unwrap();
        let linked = dir.path().join("linked");
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        assert_eq!(
            resolve_for_os(&linked, "attachments/a.pdf").unwrap(),
            Resolution::Inside(real.join("attachments/a.pdf"))
        );
    }

    #[test]
    fn the_empty_path_is_the_root_itself_and_a_link_out_is_still_outside() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(
            resolve_for_os(&root, "").unwrap(),
            Resolution::Inside(root.clone())
        );
        assert_eq!(resolve_for_os(&root, "..").unwrap(), Resolution::Outside);
    }
}
