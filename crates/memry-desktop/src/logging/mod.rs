//! Logging: `main.log` rotates at 5 MiB over five files, repeated lines collapse,
//! and every line reads `YYYY-MM-DD HH:MM:SS.mmm [level] [scope] text`, as the
//! Electron logger wrote it (`apps/desktop/src/main/lib/logger.ts`).

mod dedupe;
mod format;
mod localtime;
mod rotate;

use std::io;

use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::paths::AppPaths;

pub use rotate::{FILES_KEPT, MAX_BYTES};

const LOG_FILE: &str = "main.log";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildKind {
    Dev,
    Packaged,
}

/// Keeps the log writer thread alive. Dropping it flushes the file.
#[must_use = "dropping the guard stops logging"]
pub struct LogGuard {
    _worker: WorkerGuard,
}

/// The one logging entry point of the app. Packaged builds write `info` to the file and `warn`
/// to the console; debug builds write `debug` and `info`. `RUST_LOG` replaces the file level.
pub fn init(paths: &AppPaths) -> LogGuard {
    let (writer, worker, file_error) = open_writer(paths);
    let (file_level, console_level) = if cfg!(debug_assertions) {
        (LevelFilter::DEBUG, LevelFilter::INFO)
    } else {
        (LevelFilter::INFO, LevelFilter::WARN)
    };
    let file_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(file_level.to_string()));
    let file = tracing_subscriber::fmt::layer()
        .event_format(format::LineFormat)
        .with_writer(writer)
        .with_ansi(false)
        .with_filter(file_filter);
    let console = tracing_subscriber::fmt::layer()
        .event_format(format::LineFormat)
        .with_writer(io::stderr)
        .with_ansi(false)
        .with_filter(console_level);
    let installed = tracing_subscriber::registry()
        .with(file)
        .with(console)
        .try_init();
    if let Err(error) = installed {
        eprintln!("MemryNote logging was already initialized: {error}");
    }
    if let Some(error) = file_error {
        tracing::error!(
            "cannot open {LOG_FILE} in {}: {error}; logging to stderr",
            paths.log_dir.display()
        );
    }
    install_panic_hook();
    LogGuard { _worker: worker }
}

/// A panic is a log line with its backtrace, then the default hook still runs.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        tracing::error!(scope = "Panic", "{info}\n{backtrace}");
        previous(info);
    }));
}

fn open_writer(paths: &AppPaths) -> (NonBlocking, WorkerGuard, Option<io::Error>) {
    match rotate::RotatingFile::open(&paths.log_dir, LOG_FILE, MAX_BYTES) {
        Ok(file) => {
            let (writer, worker) = tracing_appender::non_blocking(dedupe::Dedupe::new(file));
            (writer, worker, None)
        }
        Err(error) => {
            let (writer, worker) = tracing_appender::non_blocking(io::stderr());
            (writer, worker, Some(error))
        }
    }
}

/// The line `scripts/launch-bench.mjs`, `smoke-launch.mjs` and the `vm-repro` skill parse.
pub fn log_startup(version: &str, build: BuildKind) {
    match build {
        BuildKind::Packaged => tracing::info!("MemryNote {version} starting (packaged)"),
        BuildKind::Dev => tracing::info!("MemryNote {version} starting (dev)"),
    }
}
