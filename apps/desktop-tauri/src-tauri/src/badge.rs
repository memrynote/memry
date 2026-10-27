//! The app badge: the Dock icon on macOS and the launcher on Linux; Windows has none through this
//! call, as in Electron.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Wry};

use crate::windows::registry::WindowRegistry;

/// Callers tick every minute: an equal count is written again at most this often, so a badge the
/// OS dropped comes back.
const REASSERT: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct BadgeService {
    last: Mutex<Option<(u32, Instant)>>,
}

impl BadgeService {
    pub fn set(&self, app: &AppHandle<Wry>, count: u32) {
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((previous, at)) = *last
            && previous == count
            && at.elapsed() < REASSERT
        {
            return;
        }
        let Some(window) = WindowRegistry::main_window(app) else {
            return;
        };
        let value = (count > 0).then_some(i64::from(count));
        match window.set_badge_count(value) {
            Ok(()) => *last = Some((count, Instant::now())),
            Err(error) => tracing::warn!(scope = "Badge", "could not set the badge: {error}"),
        }
    }
}
