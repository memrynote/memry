//! The Velopack update source (`apps/desktop/src/main/updater-backend-velopack.ts`): the only code
//! that names `velopack` besides the install hook in `main`. It reads the feed, downloads the
//! release the last check found and hands it to Velopack's updater, which waits for this process
//! to exit. One download at a time is the service's rule (`UpdaterService::download`), so a second
//! never reaches Velopack's global update lock.

use std::error::Error as _;
use std::io;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Mutex, PoisonError};

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::updater::backend::{CheckOutcome, UpdateBackend};
use memry_desktop::updater::marker::Installer;
use memry_desktop::updater::notes::plain_text_release_notes;
use memry_desktop::updater::severity::{NetworkKind, UpdateError, UpdateErrorKind};
use memry_desktop::updater::state::AvailableUpdate;
use velopack::sources::{AutoSource, GithubSource};
use velopack::{NetworkError, UpdateCheck, UpdateInfo, UpdateManager, VelopackAsset};

use super::channel;

/// The production feed: the GitHub releases of the repository. Velopack reads `releases.<channel>.json`
/// and the packages from the latest release.
const PRODUCTION_FEED: &str = "https://github.com/memrynote/memry";

/// Rehearsal builds set `MEMRY_UPDATE_FEED_URL` at build time, and `build_env.rs` hands it over
/// trimmed and only when it is not blank; a production build never has one.
pub const FEED_URL: &str = match option_env!("MEMRY_BUILD_MEMRY_UPDATE_FEED_URL") {
    Some(feed) => feed,
    None => PRODUCTION_FEED,
};

/// The GitHub token a rehearsal build reads its feed with. Velopack reads a GitHub feed through
/// the REST API, which allows 60 unauthenticated requests an hour per IP, and the proof jobs run
/// on shared CI runners whose IP often has none left. Only the proof workflow sets it.
const FEED_TOKEN_VAR: &str = "MEMRY_REHEARSAL_FEED_TOKEN";

/// The token for a rehearsal build's GitHub feed. A production build has no rehearsal feed, so it
/// never reads the variable and always reads the feed as users do.
fn feed_token(rehearsal_feed: Option<&str>, env: &LaunchEnv) -> Option<String> {
    rehearsal_feed
        .filter(|feed| feed.starts_with("https://github.com/"))
        .and(env.get(FEED_TOKEN_VAR))
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
}

pub struct VelopackBackend {
    manager: UpdateManager,
    switch: channel::Switch,
    current: semver::Version,
    /// The channel `sq.version` memorized, which the install marker records.
    channel: String,
    /// The release the last check found, or the one an earlier run left on disk; `download` and
    /// `apply` act on it. An up-to-date check keeps it: the service keeps a downloaded update
    /// through such a check (a release pulled from the feed), and the next quit installs this.
    pending: Mutex<Option<UpdateInfo>>,
}

impl VelopackBackend {
    /// `Err` with the reason when this process is not a Velopack install: a dev run, a `.deb`, a
    /// portable copy, an AppImage started without `APPIMAGE`.
    pub fn new(env: &LaunchEnv) -> Result<Self, String> {
        let switch = channel::current();
        let options = Some(switch.options());
        let token = feed_token(option_env!("MEMRY_BUILD_MEMRY_UPDATE_FEED_URL"), env);
        let authenticated = token.is_some();
        let manager = match token {
            Some(token) => UpdateManager::new(
                GithubSource::new(FEED_URL, Some(token), false),
                options,
                None,
            ),
            None => UpdateManager::new(AutoSource::new(FEED_URL), options, None),
        }
        .map_err(|error| error.to_string())?;
        let current = manager.get_current_version();
        let channel = installed_channel();
        tracing::info!(
            scope = "Updater",
            "velopack: current={current} channel={} feed={FEED_URL}{}",
            switch.describe(&channel),
            if authenticated { " (token)" } else { "" },
        );
        Ok(Self {
            manager,
            switch,
            current,
            channel,
            pending: Mutex::new(None),
        })
    }

    /// The installed version (`sq.version`), which the app reports as its own.
    pub fn current_version(&self) -> String {
        self.current.to_string()
    }

    pub fn channel(&self) -> String {
        self.channel.clone()
    }

    fn set_pending(&self, info: Option<UpdateInfo>) {
        *self.pending.lock().unwrap_or_else(PoisonError::into_inner) = info;
    }

    fn pending(&self) -> Result<UpdateInfo, UpdateError> {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or_else(|| {
                UpdateError::new(UpdateErrorKind::Other, "No update available to download")
            })
    }
}

/// The running install as Velopack's updater sees it, for the boot guard.
pub struct Installed {
    /// `sq.version`.
    pub version: String,
    /// The `--root` the updater is started with: the `.app` bundle on macOS, the AppImage on
    /// Linux (velopack `manager.rs` `unsafe_apply_updates`).
    pub root: PathBuf,
}

/// Read without an update manager. `None` outside a Velopack install.
pub fn installed() -> Option<Installed> {
    velopack::locator::auto_locate_app_manifest(velopack::locator::LocationContext::FromCurrentExe)
        .ok()
        .map(|locator| Installed {
            version: locator.get_manifest_version().to_string(),
            #[cfg(target_os = "linux")]
            root: locator.get_appimage_path(),
            #[cfg(not(target_os = "linux"))]
            root: locator.get_root_dir(),
        })
}

/// The channel is memorized in the installed `sq.version`; `UpdateManager` does not expose it.
fn installed_channel() -> String {
    velopack::locator::auto_locate_app_manifest(velopack::locator::LocationContext::FromCurrentExe)
        .map(|locator| locator.get_manifest_channel())
        .unwrap_or_default()
}

impl UpdateBackend for VelopackBackend {
    fn check(&self) -> Result<CheckOutcome, UpdateError> {
        let mut info = match self.manager.check_for_updates().map_err(map_error)? {
            UpdateCheck::RemoteIsEmpty | UpdateCheck::NoUpdateAvailable => {
                tracing::info!(scope = "Updater", "velopack: up-to-date");
                return Ok(CheckOutcome::UpToDate);
            }
            UpdateCheck::UpdateAvailable(info) => *info,
        };
        self.switch.restrict(&mut info);
        let target = &info.TargetFullRelease;
        tracing::info!(
            scope = "Updater",
            "velopack: available version={} deltas={} downgrade={}",
            target.Version,
            info.DeltasToTarget.len(),
            info.IsDowngrade
        );
        if channel::is_older(&self.current, &target.Version) {
            tracing::warn!(
                scope = "Updater",
                "velopack: ignoring {} below the running {}",
                target.Version,
                self.current
            );
            return Ok(CheckOutcome::UpToDate);
        }
        let update = available_update(target);
        self.set_pending(Some(info));
        Ok(CheckOutcome::Available(update))
    }

    /// Not while moving to the ARM64 pack: a package on disk is of the channel being left, and
    /// the startup check finds the native one.
    fn downloaded(&self) -> Option<AvailableUpdate> {
        if self.switch == channel::Switch::ToArm64 {
            return None;
        }
        let asset = self.manager.get_update_pending_restart()?;
        let update = available_update(&asset);
        self.set_pending(Some(UpdateInfo {
            TargetFullRelease: asset,
            BaseRelease: None,
            DeltasToTarget: Vec::new(),
            IsDowngrade: false,
        }));
        Some(update)
    }

    fn download(&self, progress: &dyn Fn(f64)) -> Result<(), UpdateError> {
        let info = self.pending()?;
        let (sender, ticks) = mpsc::channel::<i16>();
        // Velopack reports on a channel from the downloading thread; `progress` stays on this one.
        let result = std::thread::scope(|scope| {
            let download = scope.spawn(|| self.manager.download_updates(&info, Some(sender)));
            for tick in ticks {
                progress(f64::from(tick));
            }
            download.join()
        });
        match result {
            Ok(outcome) => outcome.map_err(map_error)?,
            Err(_) => {
                return Err(UpdateError::new(
                    UpdateErrorKind::Other,
                    "the Velopack download panicked",
                ));
            }
        }
        tracing::info!(
            scope = "Updater",
            "velopack: downloaded {}",
            info.TargetFullRelease.Version
        );
        Ok(())
    }

    /// Never `apply_updates_and_restart`: it exits the process at once and skips the shutdown
    /// sequence. Velopack's updater waits for this process, up to 60 s.
    fn apply(&self, silent: bool, restart: bool) -> Result<(), UpdateError> {
        let info = self.pending()?;
        tracing::info!(
            scope = "Updater",
            "velopack: applying {} silent={silent} restart={restart}",
            info.TargetFullRelease.Version
        );
        self.manager
            .wait_exit_then_apply_updates(
                &info.TargetFullRelease,
                silent,
                restart,
                Vec::<String>::new(),
            )
            .map_err(map_error)
    }

    fn installer(&self) -> Installer {
        Installer::Velopack
    }
}

/// Velopack packs both note forms; the markdown is the fallback when a release was packed without
/// the HTML transform.
fn available_update(asset: &VelopackAsset) -> AvailableUpdate {
    let html = asset.NotesHtml.trim();
    let markdown = asset.NotesMarkdown.trim();
    AvailableUpdate {
        version: asset.Version.clone(),
        release_name: None,
        release_date: None,
        release_notes: if html.is_empty() {
            (!markdown.is_empty()).then(|| markdown.to_owned())
        } else {
            plain_text_release_notes(html)
        },
        release_notes_html: (!html.is_empty()).then(|| html.to_owned()),
    }
}

/// The typed failure behind Velopack's error, which decides its severity and telemetry code.
pub fn map_error(error: velopack::Error) -> UpdateError {
    let kind = match &error {
        velopack::Error::Network(network) => match network.as_ref() {
            NetworkError::Http(http) => http_kind(http),
            NetworkError::Url(_) => UpdateErrorKind::Other,
        },
        velopack::Error::Io(io) => io_kind(io),
        _ => UpdateErrorKind::Other,
    };
    let mut causes = Vec::new();
    let mut source = error.source();
    while let Some(cause) = source {
        causes.push(cause.to_string());
        source = cause.source();
    }
    UpdateError {
        message: error.to_string(),
        kind,
        causes,
    }
}

fn http_kind(error: &ureq::Error) -> UpdateErrorKind {
    match error {
        ureq::Error::StatusCode(code) => UpdateErrorKind::Status(*code),
        ureq::Error::HostNotFound => UpdateErrorKind::Network(NetworkKind::HostNotFound),
        ureq::Error::ConnectionFailed => UpdateErrorKind::Network(NetworkKind::ConnectionFailed),
        ureq::Error::Timeout(_) => UpdateErrorKind::Network(NetworkKind::Timeout),
        ureq::Error::Io(io) => {
            UpdateErrorKind::Network(network_io_kind(io).unwrap_or(NetworkKind::Other))
        }
        // TLS, protocol and redirect failures: a transport failure nobody reasoned about.
        _ => UpdateErrorKind::Network(NetworkKind::Other),
    }
}

/// A download's body read fails as an `io::Error` wrapping the `ureq` error, so it is unwrapped
/// first; the rest is the disk.
fn io_kind(error: &io::Error) -> UpdateErrorKind {
    if let Some(http) = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<ureq::Error>())
    {
        return http_kind(http);
    }
    if error.kind() == io::ErrorKind::ReadOnlyFilesystem
        || error.raw_os_error() == Some(EROFS)
        || error.to_string().to_lowercase().contains("read-only")
    {
        return UpdateErrorKind::ReadOnlyVolume;
    }
    network_io_kind(error).map_or(UpdateErrorKind::Other, UpdateErrorKind::Network)
}

/// `EROFS` on macOS and Linux.
const EROFS: i32 = 30;

/// `WSAHOST_NOT_FOUND` and `WSATRY_AGAIN`: the Windows resolver's failures.
const WSA_LOOKUP_FAILED: [i32; 2] = [11001, 11002];

fn network_io_kind(error: &io::Error) -> Option<NetworkKind> {
    use io::ErrorKind as K;
    // The resolver's failure arrives as a plain `io::Error`, with Windows' code or the message
    // std gives `getaddrinfo` errors on Unix. Offline, a check fails here first.
    if error
        .raw_os_error()
        .is_some_and(|code| WSA_LOOKUP_FAILED.contains(&code))
        || error
            .to_string()
            .contains("failed to lookup address information")
    {
        return Some(NetworkKind::HostNotFound);
    }
    match error.kind() {
        K::ConnectionReset | K::ConnectionAborted | K::BrokenPipe | K::UnexpectedEof => {
            Some(NetworkKind::Reset)
        }
        K::ConnectionRefused
        | K::NotConnected
        | K::NetworkUnreachable
        | K::HostUnreachable
        | K::NetworkDown
        | K::AddrNotAvailable => Some(NetworkKind::Unreachable),
        K::TimedOut => Some(NetworkKind::Timeout),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
