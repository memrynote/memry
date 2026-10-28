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
/// `shell_open_path` must never start a program, so [`os_action`] shows these in the file manager
/// and never opens them, whatever else is true of them.
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
    "theme",
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
/// dots and spaces, so `a.exe.` counts here, and only here), or any folder inside a macOS `.app`
/// bundle.
fn is_executable_path(path: &str) -> bool {
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
/// than Electron, which opened any type. Revealed instead: HTML, SVG and XML (a browser runs their
/// script); legacy Office (`doc`, `xls`, `ppt`), macro-enabled Office and RTF, which can carry
/// macros or OLE objects their app runs (a vault file has no mark of the web to hold them back);
/// fonts (an installer); disk images; source files.
const OPENABLE_EXTENSIONS: &[&str] = &[
    // Documents.
    "csv", "docx", "epub", "json", "key", "log", "markdown", "md", "numbers", "odg", "odp", "ods",
    "odt", "pages", "pdf", "pptx", "tsv", "txt", "xlsx", // Images.
    "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "psd", "tif", "tiff",
    "webp", // Audio and video.
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
    Reveal(RevealRule),
    /// A link swapped in for the file since its path resolved: the OS would follow it.
    Refuse,
}

/// Why a file is shown instead of opened, for the log (which never carries the path).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevealRule {
    /// A type the OS runs, installs or mounts.
    Program,
    /// An exec bit on macOS or Linux: `open` runs such a file in Terminal, whatever its name.
    ExecBit,
    /// A name that is not UTF-8, so its type cannot be matched.
    NameNotUtf8,
    /// Not on [`OPENABLE_EXTENSIONS`].
    NotListed,
}

impl RevealRule {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Program => "program",
            Self::ExecBit => "exec_bit",
            Self::NameNotUtf8 => "name_not_utf8",
            Self::NotListed => "not_listed",
        }
    }
}

/// What to do with `target`: the exact path the opener is handed, so the decision reads the bytes
/// the OS will. `is_root` is the vault or the app data directory itself, which a person may always
/// open. Only the last component is read again here: a link swapped in for the file itself is
/// refused; the folders above it come canonical from [`resolve_for_os`].
pub fn os_action(target: &Path, is_root: bool) -> io::Result<OsAction> {
    let meta = std::fs::symlink_metadata(target)?;
    if meta.file_type().is_symlink() {
        return Ok(OsAction::Refuse);
    }
    if is_root && meta.is_dir() {
        return Ok(OsAction::Open);
    }
    if is_executable_path(&target.to_string_lossy()) {
        return Ok(OsAction::Reveal(RevealRule::Program));
    }
    if is_unix_executable(&meta) {
        return Ok(OsAction::Reveal(RevealRule::ExecBit));
    }
    let Some(name) = target.file_name() else {
        return Ok(OsAction::Reveal(RevealRule::NotListed));
    };
    let Some(name) = name.to_str() else {
        return Ok(OsAction::Reveal(RevealRule::NameNotUtf8));
    };
    let name = name.to_ascii_lowercase();
    let extension = name
        .rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .map(|(_, ext)| ext);
    Ok(match extension {
        Some(ext) if OPENABLE_EXTENSIONS.contains(&ext) => OsAction::Open,
        None if meta.is_dir() => OsAction::Open,
        _ => OsAction::Reveal(RevealRule::NotListed),
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
            "C:\\v\\a.theme",
        ] {
            assert!(is_executable_path(path), "{path}");
        }
    }

    fn action_of(dir: &Path, name: &str) -> OsAction {
        os_action(&dir.join(name), false).unwrap()
    }

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"x").unwrap();
    }

    #[cfg(unix)]
    fn touch_executable(dir: &Path, name: &str) {
        use std::os::unix::fs::PermissionsExt;
        touch(dir, name);
        std::fs::set_permissions(dir.join(name), std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn opens_documents_media_and_archives_and_reveals_anything_else() {
        let dir = tempfile::tempdir().unwrap();
        let opened = [
            "a.pdf", "a.PDF", "a.md", "a.txt", "a.docx", "a.xlsx", "a.pptx", "a.png", "a.HEIC",
            "a.mp3", "a.mov", "a.zip", "a.tar.gz",
        ];
        // Script a browser runs, macros or OLE objects their app runs, font installers, disk
        // images, source, the unknown and a name with no extension.
        let revealed = [
            "a.html",
            "a.svg",
            "a.xml",
            "a.docm",
            "a.doc",
            "a.xls",
            "a.ppt",
            "a.rtf",
            "a.ttf",
            "a.dmg",
            "a.rs",
            "a.unknown",
            "README",
            ".hidden",
        ];
        for name in opened.iter().chain(&revealed) {
            touch(dir.path(), name);
        }
        for name in opened {
            assert_eq!(action_of(dir.path(), name), OsAction::Open, "{name}");
        }
        for name in revealed {
            assert_eq!(
                action_of(dir.path(), name),
                OsAction::Reveal(RevealRule::NotListed),
                "{name}"
            );
        }
    }

    // The opener gets these exact bytes, and macOS decides by the whole name: `a.pdf.` is not a
    // PDF to it. Windows drops trailing dots and spaces, which only the deny-list allows for.
    #[test]
    fn decides_on_the_exact_name_the_opener_gets() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.pdf.", "a.pdf ", "a.zip.."] {
            touch(dir.path(), name);
            assert_eq!(
                action_of(dir.path(), name),
                OsAction::Reveal(RevealRule::NotListed),
                "{name:?}"
            );
        }
    }

    #[test]
    fn reveals_a_program_whatever_it_is_named() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.exe", "a.py", "a.sh", "a.exe."] {
            touch(dir.path(), name);
            assert_eq!(
                action_of(dir.path(), name),
                OsAction::Reveal(RevealRule::Program),
                "{name:?}"
            );
        }
        std::fs::create_dir_all(dir.path().join("Tool.app/Contents")).unwrap();
        touch(dir.path(), "Tool.app/Contents/notes.pdf");
        for name in ["Tool.app", "Tool.app/Contents/notes.pdf"] {
            assert_eq!(
                action_of(dir.path(), name),
                OsAction::Reveal(RevealRule::Program),
                "{name}"
            );
        }
    }

    // `open` runs an executable file in Terminal on macOS whatever its name says, and a desktop
    // may run one on Linux: the exec bit is decisive, the extension is not.
    #[cfg(unix)]
    #[test]
    fn never_opens_a_file_with_an_exec_bit() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["tool", ".tool", "a.pdf", "a.pdf.", "a.pdf ", "a.zip.."] {
            touch_executable(dir.path(), name);
            assert_eq!(
                action_of(dir.path(), name),
                OsAction::Reveal(RevealRule::ExecBit),
                "{name:?}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reveals_a_name_that_is_not_utf8() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let name = std::ffi::OsStr::from_bytes(b"a\xff.pdf");
        std::fs::write(dir.path().join(name), b"x").unwrap();
        assert_eq!(
            os_action(&dir.path().join(name), false).unwrap(),
            OsAction::Reveal(RevealRule::NameNotUtf8)
        );
    }

    #[test]
    fn opens_a_plain_folder_and_reveals_a_bundle() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["Folder", "Report.pages", "Saver.saver", "notes.2024"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        assert_eq!(action_of(dir.path(), "Folder"), OsAction::Open);
        assert_eq!(action_of(dir.path(), "Report.pages"), OsAction::Open);
        for name in ["Saver.saver", "notes.2024"] {
            assert_eq!(
                action_of(dir.path(), name),
                OsAction::Reveal(RevealRule::NotListed),
                "{name}"
            );
        }
    }

    #[test]
    fn always_opens_a_root_itself_even_with_a_dot_in_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("My.Vault");
        std::fs::create_dir(&vault).unwrap();
        assert_eq!(os_action(&vault, true).unwrap(), OsAction::Open);
    }

    // Every type the vault indexes as a file opens in its app, except SVG, whose script a
    // browser (its default app) would run.
    #[test]
    fn opens_every_vault_file_type_but_svg() {
        for (extension, _, _) in crate::vault::file_types::TABLE {
            assert_eq!(
                OPENABLE_EXTENSIONS.contains(extension),
                *extension != "svg",
                "{extension}"
            );
        }
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
