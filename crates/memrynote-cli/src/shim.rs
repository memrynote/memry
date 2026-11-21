//! The `memrynote` terminal command: a port of `apps/desktop/src/main/cli/terminal-command.ts`.
//!
//! The shim is a small script in a PATH directory that runs the `memrynote-cli` sidecar. The
//! directories, the marker line and the safe-write rules are Electron's: a file is created with
//! `O_EXCL|O_NOFOLLOW`, and an existing file is overwritten or removed only when it is a regular
//! file that holds [`SHIM_MARKER`], so shims Electron installed stay ours and anything else at
//! that path stays the user's.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const COMMAND_NAME: &str = "memrynote";
/// The ownership marker. Electron wrote the same line, so its shims count as ours.
pub const SHIM_MARKER: &str = "Memry terminal command shim";
#[cfg(unix)]
const SHIM_MODE: u32 = 0o755;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Linux,
    Win32,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Darwin
        } else if cfg!(windows) {
            Self::Win32
        } else {
            Self::Linux
        }
    }

    /// Node's `process.platform` name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Darwin => "darwin",
            Self::Linux => "linux",
            Self::Win32 => "win32",
        }
    }

    fn command_filename(self) -> &'static str {
        match self {
            Self::Win32 => "memrynote.cmd",
            _ => COMMAND_NAME,
        }
    }
}

/// What the shim runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launcher {
    /// The `memrynote-cli` sidecar next to the app binary.
    Sidecar(PathBuf),
    /// A Linux AppImage. Its mount path changes on every run, so the shim runs the image itself
    /// with `--cli`, and `main.rs` dispatches to the CLI.
    AppImage(PathBuf),
}

impl Launcher {
    /// The AppImage when `APPIMAGE` is set, else the sidecar beside the current executable.
    pub fn current() -> io::Result<Self> {
        if cfg!(target_os = "linux")
            && let Some(image) = std::env::var_os("APPIMAGE").filter(|image| !image.is_empty())
        {
            return Ok(Self::AppImage(image.into()));
        }
        let exe = std::env::current_exe()?;
        let dir = exe.parent().unwrap_or(Path::new(""));
        let name = if cfg!(windows) {
            "memrynote-cli.exe"
        } else {
            "memrynote-cli"
        };
        Ok(Self::Sidecar(dir.join(name)))
    }

    pub fn target(&self) -> &Path {
        match self {
            Self::Sidecar(path) | Self::AppImage(path) => path,
        }
    }

    fn args(&self) -> &'static str {
        match self {
            Self::Sidecar(_) => "",
            Self::AppImage(_) => " --cli",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ShimOptions {
    pub platform: Platform,
    pub launcher: Launcher,
    /// The `PATH` the app sees, used to prefer a directory already on it.
    pub path_env: String,
    /// Candidate directories in preference order; never empty.
    pub bin_dirs: Vec<PathBuf>,
}

impl ShimOptions {
    pub fn current() -> io::Result<Self> {
        let platform = Platform::current();
        let home = std::env::home_dir().unwrap_or_default();
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        Ok(Self {
            platform,
            launcher: Launcher::current()?,
            path_env: std::env::var_os("PATH")
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
            bin_dirs: default_bin_dirs(platform, &home, &local_app_data),
        })
    }
}

/// `defaultBinDirs`: the candidate directories in preference order.
pub fn default_bin_dirs(platform: Platform, home: &Path, local_app_data: &Path) -> Vec<PathBuf> {
    match platform {
        Platform::Win32 => vec![local_app_data.join("Microsoft").join("WindowsApps")],
        Platform::Darwin => vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            home.join(".local").join("bin"),
        ],
        Platform::Linux => vec![
            home.join(".local").join("bin"),
            home.join("bin"),
            PathBuf::from("/usr/local/bin"),
        ],
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShimStatus {
    /// The file at `shim_path` equals the current template.
    pub installed: bool,
    pub platform: Platform,
    pub shim_path: PathBuf,
    pub bin_dir: PathBuf,
    pub target_path: PathBuf,
    pub in_path: bool,
    pub path_hint: Option<String>,
}

#[derive(Debug)]
pub enum ShimError {
    /// Something other than a memrynote shim is at the path.
    NotOwned(PathBuf),
    Io(io::Error),
}

impl fmt::Display for ShimError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotOwned(path) => write!(
                f,
                "{} already exists and was not created by memrynote",
                path.display()
            ),
            Self::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ShimError {}

impl From<io::Error> for ShimError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// `renderShim`.
pub fn render(platform: Platform, launcher: &Launcher) -> String {
    let target = launcher.target().to_string_lossy();
    let args = launcher.args();
    match platform {
        Platform::Win32 => {
            format!("@echo off\r\n@rem {SHIM_MARKER}\r\n\"{target}\"{args} %*\r\n")
        }
        Platform::Darwin | Platform::Linux => format!(
            "#!/bin/sh\n# {SHIM_MARKER}\nexec \"{}\"{args} \"$@\"\n",
            escape_double_quoted(&target)
        ),
    }
}

/// `escapeDoubleQuoted`: the characters `sh` still expands inside double quotes.
fn escape_double_quoted(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '"' | '\\' | '$' | '`') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

pub fn status(options: &ShimOptions) -> Result<ShimStatus, ShimError> {
    let bin_dir = choose_bin_dir(options);
    let shim_path = bin_dir.join(options.platform.command_filename());
    let in_path = path_contains_dir(&options.path_env, &bin_dir, options.platform);
    let expected = render(options.platform, &options.launcher);
    Ok(ShimStatus {
        installed: read_shim(&shim_path)?.as_deref() == Some(expected.as_str()),
        platform: options.platform,
        path_hint: (!in_path).then(|| {
            format!(
                "Add {} to PATH, then reopen your terminal.",
                bin_dir.display()
            )
        }),
        shim_path,
        bin_dir,
        target_path: options.launcher.target().to_path_buf(),
        in_path,
    })
}

pub fn install(options: &ShimOptions) -> Result<ShimStatus, ShimError> {
    let current = status(options)?;
    fs::create_dir_all(&current.bin_dir)?;
    write_owned(
        &current.shim_path,
        &render(options.platform, &options.launcher),
        options.platform,
    )?;
    status(options)
}

pub fn uninstall(options: &ShimOptions) -> Result<ShimStatus, ShimError> {
    remove_owned(&status(options)?.shim_path)?;
    status(options)
}

/// Rewrites every candidate path that holds a memrynote shim other than the current template,
/// with the same safe-write rules: a legacy Electron `--cli` shim, or a shim whose target moved.
/// Returns the paths it could not read or rewrite.
pub fn refresh(options: &ShimOptions) -> Vec<(PathBuf, ShimError)> {
    let expected = render(options.platform, &options.launcher);
    let mut failures = Vec::new();
    for dir in &options.bin_dirs {
        let path = dir.join(options.platform.command_filename());
        let outcome = match read_shim(&path) {
            Ok(Some(content)) if content.contains(SHIM_MARKER) && content != expected => {
                write_owned(&path, &expected, options.platform)
            }
            Ok(_) => Ok(()),
            Err(error) => Err(error.into()),
        };
        if let Err(error) = outcome {
            failures.push((path, error));
        }
    }
    failures
}

/// `chooseBinDir`: the first writable directory on PATH, else the first writable one, else the
/// first candidate.
fn choose_bin_dir(options: &ShimOptions) -> PathBuf {
    let writable: Vec<&PathBuf> = options
        .bin_dirs
        .iter()
        .filter(|dir| can_write_dir(dir))
        .collect();
    writable
        .iter()
        .find(|dir| path_contains_dir(&options.path_env, dir, options.platform))
        .or(writable.first())
        .map_or_else(|| options.bin_dirs[0].clone(), |dir| (*dir).clone())
}

fn path_contains_dir(path_env: &str, dir: &Path, platform: Platform) -> bool {
    // Electron splits on `;` for win32 and on the host's `path.delimiter` otherwise.
    let host = if cfg!(windows) { ';' } else { ':' };
    let (separator, normalize): (char, fn(&str) -> String) = match platform {
        Platform::Win32 => (';', str::to_lowercase),
        _ => (host, str::to_owned),
    };
    let expected = normalize(&dir.to_string_lossy());
    path_env
        .split(separator)
        .filter(|entry| !entry.is_empty())
        .any(|entry| normalize(entry) == expected)
}

/// `canWriteDir`: the directory is writable, or it is absent and its parent is.
fn can_write_dir(dir: &Path) -> bool {
    if dir.exists() {
        writable(dir)
    } else {
        writable(dir.parent().unwrap_or(dir))
    }
}

#[cfg(unix)]
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a valid NUL-terminated string that outlives the call.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

/// Node's `access(W_OK)` on Windows checks only the read-only attribute.
#[cfg(windows)]
fn writable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| !metadata.permissions().readonly())
}

/// Opens without following a symlink at `path`: `O_NOFOLLOW` on Unix. Windows has no such flag
/// in `std`, so a symlink or directory there is refused up front (Electron followed it).
fn open_no_follow(path: &Path, options: &mut OpenOptions) -> io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    if let Ok(metadata) = fs::symlink_metadata(path)
        && !metadata.is_file()
    {
        return Err(io::Error::from(io::ErrorKind::IsADirectory));
    }
    options.open(path)
}

/// The error `open_no_follow` gives for a symlink (`ELOOP`) or, on Windows, any non-file.
fn is_not_a_file(error: &io::Error) -> bool {
    #[cfg(unix)]
    return error.raw_os_error() == Some(libc::ELOOP);
    #[cfg(windows)]
    return error.kind() == io::ErrorKind::IsADirectory;
}

/// `readShimFile`: the file's text, or `None` when there is no regular file at `path`.
fn read_shim(path: &Path) -> io::Result<Option<String>> {
    let mut file = match open_no_follow(path, OpenOptions::new().read(true)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound || is_not_a_file(&error) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    if !file.metadata()?.is_file() {
        return Ok(None);
    }
    read_text(&mut file).map(Some)
}

fn read_text(file: &mut File) -> io::Result<String> {
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// `writeOwnedShim`: create with `O_EXCL`, or overwrite a regular file that holds the marker.
fn write_owned(path: &Path, content: &str, platform: Platform) -> Result<(), ShimError> {
    let not_owned = || ShimError::NotOwned(path.to_path_buf());
    let mut create = OpenOptions::new();
    create.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut create, SHIM_MODE);
    let mut file = match open_no_follow(path, &mut create) {
        Ok(file) => file,
        Err(error) if is_not_a_file(&error) => return Err(not_owned()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let mut file = open_no_follow(path, OpenOptions::new().read(true).write(true))
                .map_err(|error| {
                    if is_not_a_file(&error) {
                        not_owned()
                    } else {
                        ShimError::Io(error)
                    }
                })?;
            if !file.metadata()?.is_file() || !read_text(&mut file)?.contains(SHIM_MARKER) {
                return Err(not_owned());
            }
            file.set_len(0)?;
            file.seek(SeekFrom::Start(0))?;
            file
        }
        Err(error) => return Err(error.into()),
    };
    file.write_all(content.as_bytes())?;
    #[cfg(unix)]
    if platform != Platform::Win32 {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(SHIM_MODE))?;
    }
    #[cfg(windows)]
    let _ = platform;
    Ok(())
}

/// `removeOwnedShim`: absent is fine; anything that is not our shim stays.
fn remove_owned(path: &Path) -> Result<(), ShimError> {
    match read_shim(path)? {
        Some(content) if content.contains(SHIM_MARKER) => Ok(fs::remove_file(path)?),
        Some(_) => Err(ShimError::NotOwned(path.to_path_buf())),
        None => match fs::symlink_metadata(path) {
            Ok(_) => Err(ShimError::NotOwned(path.to_path_buf())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        },
    }
}
