//! What an Electron NSIS install directory holds, and how two paths compare the way Windows
//! compares them.

use std::path::{Component, Path, Prefix};

/// The top-level files of the Electron builds that name their exe `Memrynote.exe`: `v2026-06-10`
/// on (Electron 39 to `v2026-07-10.x`, Electron 43 from `v2026-07-17`; read from the NSIS
/// `app-64.7z` of `v2026-07-10.3` and `v2026-10-25`), plus the NSIS uninstaller, the
/// `debug.log` Chromium may write beside the exe and the `.old-update` copy of the exe. Earlier
/// builds named the exe `memry.exe` (`v2026.4.28`) or `Memry.exe` (`v2026-05-06` to
/// `v2026-05-16`); their installs fail the anchor check and stay (`not_electron`). Lowercase.
const TOP_FILES: &[&str] = &[
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
    "memrynote.exe.old-update",
    "resources.pak",
    "snapshot_blob.bin",
    UNINSTALLER,
    "v8_context_snapshot.bin",
    "vk_swiftshader.dll",
    "vk_swiftshader_icd.json",
    "vulkan-1.dll",
];
/// `resources\` of the same builds. `app.asar.unpacked` and `node_modules` are taken whole: a
/// link deeper down is removed as a link, never followed (`std::fs::remove_dir_all`).
const RESOURCES_FILES: &[&str] = &["app-config", "app-update.yml", "app.asar", "elevate.exe"];
const RESOURCES_DIRS: &[&str] = &["app.asar.unpacked", "node_modules"];

/// The NSIS uninstaller, lowercase. Builds write it as `Uninstall Memrynote.exe`; Windows file
/// names compare without case.
pub const UNINSTALLER: &str = "uninstall memrynote.exe";

/// Which directory of the install an entry sits in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Top,
    Resources,
    /// `locales\`: Chromium's `.pak` files only.
    Locales,
}

/// The level a top-level directory opens, or `None` when an install has no such directory.
pub fn subdir(name: &str) -> Option<Level> {
    match name.to_lowercase().as_str() {
        "resources" => Some(Level::Resources),
        "locales" => Some(Level::Locales),
        _ => None,
    }
}

/// An entry an Electron install has at `level`, so it may be removed with it.
pub fn allowed(level: Level, name: &str, is_dir: bool) -> bool {
    let name = name.to_lowercase();
    match (level, is_dir) {
        (Level::Top, false) => TOP_FILES.contains(&name.as_str()),
        (Level::Top, true) => subdir(&name).is_some(),
        (Level::Resources, false) => RESOURCES_FILES.contains(&name.as_str()),
        (Level::Resources, true) => RESOURCES_DIRS.contains(&name.as_str()),
        (Level::Locales, false) => name.ends_with(".pak"),
        (Level::Locales, true) => false,
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
