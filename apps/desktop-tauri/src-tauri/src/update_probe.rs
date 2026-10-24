//! Rehearsal-only Velopack probe (feature `update-probe`). Step 38 (#3555) replaces this module
//! with the real updater and removes the feature. Release builds never enable it.

use std::time::Duration;

use velopack::locator::{self, LocationContext};
use velopack::sources::AutoSource;
use velopack::{UpdateCheck, UpdateInfo, UpdateManager};

/// Build-time feed. Rehearsal builds set `MEMRY_UPDATE_FEED_URL` to the rehearsal repo.
const FEED_URL: &str = match option_env!("MEMRY_UPDATE_FEED_URL") {
    Some(url) => url,
    None => "https://github.com/memrynote/memry",
};

/// Delay between the main window being shown and the first check.
const START_DELAY: Duration = Duration::from_secs(10);

/// Starts the probe on its own thread. The Velopack client is blocking.
pub fn spawn() {
    let spawned = std::thread::Builder::new()
        .name("update-probe".into())
        .spawn(|| {
            std::thread::sleep(START_DELAY);
            run(FEED_URL);
        });
    if let Err(error) = spawned {
        tracing::error!("update-probe: cannot start thread: {error}");
    }
}

fn run(feed: &str) {
    let manager = match UpdateManager::new(AutoSource::new(feed), None, None) {
        Ok(manager) => manager,
        Err(error) => {
            tracing::info!("update-probe: not an installed Velopack app: {error}");
            return;
        }
    };
    tracing::info!(
        "{}",
        current_line(
            &manager.get_current_version_as_string(),
            &installed_channel(),
            feed
        )
    );
    match manager.check_for_updates() {
        Ok(UpdateCheck::UpdateAvailable(info)) => apply(&manager, &info),
        Ok(UpdateCheck::NoUpdateAvailable | UpdateCheck::RemoteIsEmpty) => {
            tracing::info!("update-probe: up-to-date");
        }
        Err(error) => tracing::error!("update-probe: check failed: {error}"),
    }
}

/// The channel is memorized in the installed `sq.version`; `UpdateManager` does not expose it.
fn installed_channel() -> String {
    locator::auto_locate_app_manifest(LocationContext::FromCurrentExe)
        .map(|locator| locator.get_manifest_channel())
        .unwrap_or_default()
}

fn apply(manager: &UpdateManager, info: &UpdateInfo) {
    tracing::info!("{}", available_line(info));
    if let Err(error) = manager.download_updates(info, None) {
        tracing::error!("update-probe: download failed: {error}");
        return;
    }
    tracing::info!("update-probe: downloaded");
    tracing::info!("update-probe: applying");
    if let Err(error) = manager.apply_updates_and_restart(&info.TargetFullRelease) {
        tracing::error!("update-probe: apply failed: {error}");
    }
}

fn current_line(version: &str, channel: &str, feed: &str) -> String {
    format!("update-probe: current={version} channel={channel} feed={feed}")
}

fn available_line(info: &UpdateInfo) -> String {
    format!(
        "update-probe: available version={} deltas={} downgrade={}",
        info.TargetFullRelease.Version,
        info.DeltasToTarget.len(),
        info.IsDowngrade
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use velopack::VelopackAsset;

    #[test]
    fn available_line_reports_version_delta_count_and_downgrade() {
        let info = UpdateInfo {
            TargetFullRelease: VelopackAsset {
                Version: "2099.101.2".into(),
                ..Default::default()
            },
            BaseRelease: None,
            DeltasToTarget: vec![VelopackAsset::default()],
            IsDowngrade: false,
        };
        assert_eq!(
            available_line(&info),
            "update-probe: available version=2099.101.2 deltas=1 downgrade=false"
        );
    }

    #[test]
    fn current_line_names_version_channel_and_feed() {
        assert_eq!(
            current_line("2099.101.1", "win", "https://github.com/x/y"),
            "update-probe: current=2099.101.1 channel=win feed=https://github.com/x/y"
        );
    }
}
