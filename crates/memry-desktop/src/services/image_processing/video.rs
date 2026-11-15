//! Video thumbnails through an ffmpeg the user installed (`operations.ts:186-238`). No ffmpeg is
//! bundled: without one a video gets no thumbnail and the caller shows its placeholder.
//!
//! The file is untrusted. ffmpeg runs without a shell, with the path as one argument behind the
//! `file:` protocol (so a name like `-y`, `concat:` or `http://` is never an option or a URL),
//! reads only `file` and `pipe` (an `.mp4` holding an HLS playlist cannot fetch the network), and
//! is killed when it passes its time limit or prints more than a frame can hold.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use super::encode::THUMBNAIL_EDGE;

/// `which ffmpeg` had 3 s (`operations.ts:230`); a `PATH` entry on a hung network mount gets the same.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);
/// `execFile`'s `timeout: 10_000` (`operations.ts:212`).
pub(super) const RUN_TIMEOUT: Duration = Duration::from_secs(10);
/// One 200 px PNG frame is far below this; more is not a frame.
const MAX_FRAME_BYTES: u64 = 16 * 1024 * 1024;

const EXECUTABLE: &str = if cfg!(windows) {
    "ffmpeg.exe"
} else {
    "ffmpeg"
};

/// A GUI launch on macOS gets a short `PATH` that leaves out Homebrew.
const EXTRA_DIRS: &[&str] = if cfg!(target_os = "macos") {
    &["/opt/homebrew/bin", "/usr/local/bin"]
} else {
    &[]
};

pub(super) struct Ffmpeg {
    dirs: Vec<PathBuf>,
    run_timeout: Duration,
    /// The lookup runs once per service, as Electron caches it per process.
    found: OnceLock<Option<PathBuf>>,
}

impl Ffmpeg {
    /// Looks for ffmpeg in `dirs`, in order.
    pub(super) fn new(dirs: Vec<PathBuf>, run_timeout: Duration) -> Self {
        Self {
            dirs,
            run_timeout,
            found: OnceLock::new(),
        }
    }

    fn locate(&self) -> Option<&Path> {
        self.found
            .get_or_init(|| {
                let dirs = self.dirs.clone();
                let (tx, rx) = mpsc::channel();
                thread::spawn(move || {
                    let found = dirs
                        .into_iter()
                        .map(|dir| dir.join(EXECUTABLE))
                        .find(|candidate| candidate.is_file());
                    tx.send(found)
                });
                let found = rx.recv_timeout(LOOKUP_TIMEOUT).ok().flatten();
                if found.is_none() {
                    tracing::debug!("ffmpeg not found, skipping video thumbnails");
                }
                found
            })
            .as_deref()
    }

    /// The frame at 1 s, scaled into 200x200, as PNG bytes. None when ffmpeg is absent, fails,
    /// prints nothing (a video under 1 s) or passes its time limit.
    pub(super) fn frame_png(&self, video: &Path) -> Option<Vec<u8>> {
        let ffmpeg = self.locate()?;
        if !video.is_absolute() {
            tracing::warn!("video thumbnail needs an absolute path");
            return None;
        }
        let mut input = OsString::from("file:");
        input.push(video);
        let scale =
            format!("scale={THUMBNAIL_EDGE}:{THUMBNAIL_EDGE}:force_original_aspect_ratio=decrease");
        let mut command = Command::new(ffmpeg);
        command
            .args(["-nostdin", "-hide_banner", "-loglevel", "error"])
            .args(["-protocol_whitelist", "file,pipe", "-i"])
            .arg(input)
            .args(["-ss", "1", "-vframes", "1", "-vf", &scale])
            .args(["-f", "image2pipe", "-vcodec", "png", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let child = command
            .spawn()
            .inspect_err(|error| tracing::warn!(%error, "ffmpeg did not start"))
            .ok()?;
        run(child, self.run_timeout)
    }
}

/// The stdout of `child` once it exits successfully within `timeout`; otherwise it is killed.
fn run(mut child: Child, timeout: Duration) -> Option<Vec<u8>> {
    let deadline = Instant::now() + timeout;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut frame = Vec::new();
        let read = (&mut stdout)
            .take(MAX_FRAME_BYTES + 1)
            .read_to_end(&mut frame);
        let _ = tx.send(read.map(|_| frame));
    });
    let frame = match rx.recv_timeout(timeout) {
        Ok(Ok(frame)) if frame.len() as u64 <= MAX_FRAME_BYTES => frame,
        outcome => {
            let reason = match outcome {
                Err(_) => "timed out",
                Ok(Ok(_)) => "printed more than a frame",
                Ok(Err(_)) => "output unreadable",
            };
            return kill(child, reason);
        }
    };
    match wait_until(&mut child, deadline) {
        Some(status) if status.success() && !frame.is_empty() => Some(frame),
        Some(status) => {
            tracing::debug!(%status, "ffmpeg gave no frame");
            None
        }
        None => kill(child, "timed out"),
    }
}

fn wait_until(child: &mut Child, deadline: Instant) -> Option<ExitStatus> {
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn kill(mut child: Child, reason: &str) -> Option<Vec<u8>> {
    tracing::warn!(reason, "ffmpeg stopped");
    if let Err(error) = child.kill() {
        tracing::warn!(%error, "ffmpeg kill failed");
    }
    let _ = child.wait();
    None
}

/// Where ffmpeg is looked for: the absolute `PATH` entries (a relative one would resolve against
/// whatever directory the app runs in), then the extra directories.
pub(super) fn search_dirs(search_path: Option<&OsStr>) -> Vec<PathBuf> {
    search_path
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|dir| dir.is_absolute())
        .chain(EXTRA_DIRS.iter().map(PathBuf::from))
        .collect()
}
