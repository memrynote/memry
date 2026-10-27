//! Which URLs the shell hands to the OS: port of `isAllowedExternalUrl`
//! (`apps/desktop/src/main/lib/external-url.ts`). Only web and mail schemes, so a link in a note
//! cannot launch `file:`, `smb:` or a custom protocol handler through the OS.

use std::io;
use std::path::Path;

use url::Url;

use super::file_open::{Resolution, resolve_under_root};

/// A URL longer than this is not a link a person clicked.
const MAX_URL_LEN: usize = 16 * 1024;

pub fn is_allowed_external_url(raw: &str) -> bool {
    raw.len() <= MAX_URL_LEN
        && Url::parse(raw).is_ok_and(|url| matches!(url.scheme(), "https" | "http" | "mailto"))
}

/// File types the OS runs when it "opens" them. A note's link or `shell_open_path` must never
/// start a program, so these are refused (revealing one in the file manager is fine).
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "app",
    "appimage",
    "appref-ms",
    "bat",
    "cmd",
    "com",
    "command",
    "cpl",
    "desktop",
    "exe",
    "hta",
    "jar",
    "js",
    "jse",
    "lnk",
    "msc",
    "msi",
    "pif",
    "ps1",
    "reg",
    "run",
    "scr",
    "sh",
    "terminal",
    "url",
    "vbe",
    "vbs",
    "workflow",
    "ws",
    "wsf",
    "wsh",
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

/// Where `rel` names under `root` for the OS to open or reveal. The empty path is the root itself,
/// which [`resolve_under_root`] does not take: a person may open or reveal their vault folder.
pub fn resolve_for_os(root: &Path, rel: &str) -> io::Result<Resolution> {
    if rel.is_empty() {
        return Ok(Resolution::Inside(root.canonicalize()?));
    }
    resolve_under_root(root, rel)
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
