use std::fs;
use std::io;

use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::EnvFilter;

use crate::paths::AppPaths;

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

/// The one logging entry point of the app: `main.log` in append mode in the log dir, no ANSI
/// codes, `RUST_LOG` honored and `info` the default. Step 09 (#3526) changes the body
/// (rotation, redaction) and never the signature or the path logic.
pub fn init(paths: &AppPaths) -> LogGuard {
    let (writer, worker, file_error) = open_writer(paths);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let installed = tracing_subscriber::fmt()
        .with_writer(writer)
        .with_ansi(false)
        .with_env_filter(filter)
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
    LogGuard { _worker: worker }
}

fn open_writer(paths: &AppPaths) -> (NonBlocking, WorkerGuard, Option<io::Error>) {
    let opened = fs::create_dir_all(&paths.log_dir).and_then(|()| {
        RollingFileAppender::builder()
            .rotation(Rotation::NEVER)
            .filename_prefix(LOG_FILE)
            .build(&paths.log_dir)
            .map_err(io::Error::other)
    });
    match opened {
        Ok(appender) => {
            let (writer, worker) = tracing_appender::non_blocking(appender);
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
