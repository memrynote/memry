//! What an Electron NSIS install directory holds, and how two paths compare the way Windows
//! compares them.

use std::path::{Component, Path, Prefix};

/// Every top-level entry of the shipped Electron Windows builds (Electron 39 at `v2026.4.28` and
/// Electron 43 from `v2026-07-17`, read from their `-win.zip` and NSIS `app-64.7z`), plus the
/// NSIS uninstaller and the `debug.log` Chromium may write next to the exe. Lowercase.
const FILES: &[&str] = &[
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "d3dcompiler_47.dll",
    "debug.log",
    "dxcompiler.dll",
    "dxil.dll",
    "ffmpeg.dll",
    "icudtl.dat",
    "libegl.dll",
    "libglesv2.dll",
    "license.electron.txt",
    "licenses.chromium.html",
    "memrynote.exe",
    "resources.pak",
    "snapshot_blob.bin",
    UNINSTALLER,
    "v8_context_snapshot.bin",
    "vk_swiftshader.dll",
    "vk_swiftshader_icd.json",
    "vulkan-1.dll",
];
const DIRS: &[&str] = &["locales", "resources"];

/// The NSIS uninstaller, lowercase. Builds write it as `Uninstall Memrynote.exe`; Windows file
/// names compare without case.
pub const UNINSTALLER: &str = "uninstall memrynote.exe";

/// One top-level entry of the directory may be removed with it.
pub fn allowed_entry(name: &str, is_dir: bool) -> bool {
    let name = name.to_lowercase();
    if is_dir {
        DIRS.contains(&name.as_str())
    } else {
        FILES.contains(&name.as_str())
    }
}

/// The path as Windows compares it: lowercase components, the drive written one way whether the
/// path is verbatim (`\\?\C:\`) or not. `None` for a path that cannot be compared safely: a
/// network share, a device path, or one that climbs with `..`.
pub fn components(path: &Path) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => {
                    out.push(format!("{}:", char::from(drive).to_ascii_lowercase()));
                }
                Prefix::Verbatim(_)
                | Prefix::UNC(..)
                | Prefix::VerbatimUNC(..)
                | Prefix::DeviceNS(_) => return None,
            },
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => return None,
            Component::Normal(part) => out.push(part.to_string_lossy().to_lowercase()),
        }
    }
    Some(out)
}

/// `inner` is `outer` or lies below it.
pub fn within(inner: &[String], outer: &[String]) -> bool {
    inner.len() >= outer.len() && inner[..outer.len()] == *outer
}

/// The path without its verbatim prefix, as a shortcut or a registry value writes it.
pub fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_owned(),
        _ => text.into_owned(),
    }
}

/// Largest shortcut read. A `.lnk` is a few KiB.
const MAX_LINK_BYTES: u64 = 64 * 1024;

/// How many shortcuts in `dir` name a path inside `target`: a taskbar pin keeps its own
/// shortcut, which goes stale once the directory is gone. A shortcut stores its target as text
/// (UTF-16 or the ANSI code page), so the count searches for `target` in both, ignoring ASCII
/// case. Best effort, for the log and the report.
pub fn count_links_into(dir: &Path, target: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let needle = format!(
        "{}{}",
        target.trim_end_matches(['\\', '/']),
        std::path::MAIN_SEPARATOR
    )
    .to_ascii_lowercase();
    // Lowercased byte by byte like the haystack, so a non-ASCII unit transforms the same way.
    let wide = needle
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<u8>>()
        .to_ascii_lowercase();
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
        })
        .filter_map(|entry| super::super::read_capped(&entry.path(), MAX_LINK_BYTES))
        .filter(|bytes| {
            let lower = bytes.to_ascii_lowercase();
            contains(&lower, needle.as_bytes()) || contains(&lower, &wide)
        })
        .count()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}
