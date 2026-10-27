//! Remembering the main window's size and position: port of
//! `apps/desktop/src/main/window-bounds.ts`. All values are logical (DIP) units, as Electron
//! stores them, so a file written by one build opens correctly in the other.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Sizes below these are corrupt or stale and would give an unusable window.
const MIN_WIDTH: i32 = 400;
const MIN_HEIGHT: i32 = 300;
/// A saved position is reused only when this much of the window lands on a display's work area.
const MIN_VISIBLE_X: i64 = 100;
const MIN_VISIBLE_Y: i64 = 50;

/// The trailing debounce of the noisy resize and move streams. A drag settles into one write.
pub const PERSIST_DELAY_MS: u64 = 1500;

/// `windowBounds` in `memry-config.json`. Unknown keys of other builds round-trip through
/// `extra`; `isFullScreen` is written by Electron although its TypeScript type omits it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StoredWindowBounds {
    pub width: i32,
    pub height: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_maximized: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_full_screen: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for StoredWindowBounds {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            x: None,
            y: None,
            is_maximized: None,
            is_full_screen: None,
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// A display's usable area.
pub type WorkArea = Rect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fallback {
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedBounds {
    pub width: i32,
    pub height: i32,
    pub position: Option<(i32, i32)>,
    pub maximize: bool,
    pub full_screen: bool,
}

fn position_visible(rect: Rect, displays: &[WorkArea]) -> bool {
    displays.iter().any(|area| {
        let overlap_x = i64::from(rect.x + rect.width).min(i64::from(area.x + area.width))
            - i64::from(rect.x).max(i64::from(area.x));
        let overlap_y = i64::from(rect.y + rect.height).min(i64::from(area.y + area.height))
            - i64::from(rect.y).max(i64::from(area.y));
        overlap_x >= MIN_VISIBLE_X && overlap_y >= MIN_VISIBLE_Y
    })
}

/// How to open the main window given the saved bounds. No usable size gives the fallback,
/// centered by the OS. The size returned is the normal (restored) size.
pub fn resolve_startup_bounds(
    saved: Option<&StoredWindowBounds>,
    displays: &[WorkArea],
    fallback: Fallback,
) -> ResolvedBounds {
    let Some(saved) = saved.filter(|s| s.width >= MIN_WIDTH && s.height >= MIN_HEIGHT) else {
        return ResolvedBounds {
            width: fallback.width,
            height: fallback.height,
            position: None,
            maximize: false,
            full_screen: false,
        };
    };
    let position = match (saved.x, saved.y) {
        (Some(x), Some(y))
            if position_visible(
                Rect {
                    x,
                    y,
                    width: saved.width,
                    height: saved.height,
                },
                displays,
            ) =>
        {
            Some((x, y))
        }
        _ => None,
    };
    ResolvedBounds {
        width: saved.width,
        height: saved.height,
        position,
        maximize: saved.is_maximized == Some(true),
        full_screen: saved.is_full_screen == Some(true),
    }
}

/// What the window reports right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowState {
    pub minimized: bool,
    pub visible: bool,
    pub maximized: bool,
    pub full_screen: bool,
    pub bounds: Rect,
}

/// What to remember: the normal rectangle plus the mode flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capture {
    pub rect: Rect,
    pub maximized: bool,
    pub full_screen: bool,
}

impl StoredWindowBounds {
    /// Replaces the known fields with `capture` and keeps every unknown key.
    pub fn apply(&mut self, capture: Capture) {
        self.width = capture.rect.width;
        self.height = capture.rect.height;
        self.x = Some(capture.rect.x);
        self.y = Some(capture.rect.y);
        self.is_maximized = Some(capture.maximized);
        self.is_full_screen = Some(capture.full_screen);
    }
}

/// Tauri has no `getNormalBounds`, so the last rectangle seen while the window was neither
/// maximized nor fullscreen stands in for it. Also drops writes that repeat the last one.
#[derive(Debug, Default)]
pub struct BoundsTracker {
    last_normal: Option<Rect>,
    last_written: Option<Capture>,
}

impl BoundsTracker {
    /// Feeds a resize or move. Only a trustworthy normal state updates the remembered rect.
    pub fn observe(&mut self, state: WindowState) {
        if state.visible && !state.minimized && !state.maximized && !state.full_screen {
            self.last_normal = Some(state.bounds);
        }
    }

    /// The state to persist, or `None` when the snapshot cannot be trusted (minimized and
    /// hidden windows report a restored, non-maximized rectangle on Windows, which would
    /// downgrade a maximized window) or repeats the last write.
    pub fn capture(&mut self, state: WindowState) -> Option<Capture> {
        if state.minimized || !state.visible {
            return None;
        }
        self.observe(state);
        let rect = if state.maximized || state.full_screen {
            self.last_normal.unwrap_or(state.bounds)
        } else {
            state.bounds
        };
        let capture = Capture {
            rect,
            maximized: state.maximized,
            full_screen: state.full_screen,
        };
        if self.last_written == Some(capture) {
            return None;
        }
        self.last_written = Some(capture);
        Some(capture)
    }

    /// Forgets that `capture` was written, after its write failed, so the next one retries.
    pub fn write_failed(&mut self) {
        self.last_written = None;
    }
}

/// The compact window the vault picker uses, and the app window's default size.
pub const PICKER_SIZE: Fallback = Fallback {
    width: 900,
    height: 720,
};
pub const DEFAULT_MAIN_SIZE: Fallback = Fallback {
    width: 1550,
    height: 900,
};

/// What the window does when the vault opens or closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerTransition {
    None,
    /// Grow from the picker to the app window, then maximize when the saved state says so.
    Grow {
        size: Fallback,
        maximize: bool,
    },
    ShrinkToPicker,
}

/// The picker size, or smaller: the OS shrinks a window that does not fit its screen (a 768 px
/// laptop cannot hold 720 px under a taskbar), and such a window is still the picker.
fn is_picker_size((width, height): (i32, i32)) -> bool {
    width <= PICKER_SIZE.width && height <= PICKER_SIZE.height
}

/// Port of the `onVaultStatusChanged` handler of `apps/desktop/src/main/index.ts`. A window the
/// user already sized or maximized is left alone: only the genuine picker to app transition
/// acts. A vault switch closes one vault before it opens the next, and shrinking in that gap
/// would make the window jump.
pub fn picker_transition(
    vault_open: bool,
    switching: bool,
    maximized: bool,
    size: (i32, i32),
    saved: Option<&StoredWindowBounds>,
) -> PickerTransition {
    if !vault_open {
        return if switching || is_picker_size(size) {
            PickerTransition::None
        } else {
            PickerTransition::ShrinkToPicker
        };
    }
    if maximized || !is_picker_size(size) {
        return PickerTransition::None;
    }
    PickerTransition::Grow {
        size: Fallback {
            width: saved.map_or(DEFAULT_MAIN_SIZE.width, |s| s.width),
            height: saved.map_or(DEFAULT_MAIN_SIZE.height, |s| s.height),
        },
        maximize: saved.is_some_and(|s| s.is_maximized == Some(true)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FALLBACK: Fallback = Fallback {
        width: 1550,
        height: 900,
    };
    const PRIMARY: WorkArea = Rect {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
    };

    fn saved(width: i32, height: i32, x: Option<i32>, y: Option<i32>) -> StoredWindowBounds {
        StoredWindowBounds {
            width,
            height,
            x,
            y,
            ..StoredWindowBounds::default()
        }
    }

    #[test]
    fn no_saved_bounds_gives_the_fallback() {
        let r = resolve_startup_bounds(None, &[PRIMARY], FALLBACK);
        assert_eq!((r.width, r.height, r.position), (1550, 900, None));
        assert!(!r.maximize && !r.full_screen);
    }

    #[test]
    fn corrupt_size_gives_the_fallback() {
        let s = saved(399, 800, Some(0), Some(0));
        assert_eq!(
            resolve_startup_bounds(Some(&s), &[PRIMARY], FALLBACK).width,
            1550
        );
        let s = saved(800, 299, Some(0), Some(0));
        assert_eq!(
            resolve_startup_bounds(Some(&s), &[PRIMARY], FALLBACK).height,
            900
        );
    }

    #[test]
    fn restores_a_visible_position() {
        let s = saved(1200, 800, Some(100), Some(60));
        let r = resolve_startup_bounds(Some(&s), &[PRIMARY], FALLBACK);
        assert_eq!(r.position, Some((100, 60)));
        assert_eq!((r.width, r.height), (1200, 800));
    }

    #[test]
    fn drops_an_off_screen_position_and_keeps_the_size() {
        let s = saved(1200, 800, Some(5000), Some(60));
        let r = resolve_startup_bounds(Some(&s), &[PRIMARY], FALLBACK);
        assert_eq!(r.position, None);
        assert_eq!((r.width, r.height), (1200, 800));
    }

    #[test]
    fn needs_a_100_by_50_overlap() {
        // 99 px of overlap in x: not visible. 100: visible.
        let s = saved(1200, 800, Some(1341), Some(0));
        assert_eq!(
            resolve_startup_bounds(Some(&s), &[PRIMARY], FALLBACK).position,
            None
        );
        let s = saved(1200, 800, Some(1340), Some(0));
        assert_eq!(
            resolve_startup_bounds(Some(&s), &[PRIMARY], FALLBACK).position,
            Some((1340, 0))
        );
        let s = saved(1200, 800, Some(0), Some(851));
        assert_eq!(
            resolve_startup_bounds(Some(&s), &[PRIMARY], FALLBACK).position,
            None
        );
    }

    #[test]
    fn a_second_display_counts() {
        let second = Rect {
            x: 1440,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let s = saved(1200, 800, Some(1500), Some(10));
        assert_eq!(
            resolve_startup_bounds(Some(&s), &[PRIMARY, second], FALLBACK).position,
            Some((1500, 10))
        );
        assert_eq!(
            resolve_startup_bounds(Some(&s), &[PRIMARY], FALLBACK).position,
            None
        );
    }

    #[test]
    fn mode_flags_pass_through() {
        let mut s = saved(1200, 800, Some(100), Some(60));
        s.is_maximized = Some(true);
        let r = resolve_startup_bounds(Some(&s), &[PRIMARY], FALLBACK);
        assert!(r.maximize && !r.full_screen);
        s.is_maximized = None;
        s.is_full_screen = Some(true);
        let r = resolve_startup_bounds(Some(&s), &[PRIMARY], FALLBACK);
        assert!(!r.maximize && r.full_screen);
    }

    fn state(bounds: Rect) -> WindowState {
        WindowState {
            minimized: false,
            visible: true,
            maximized: false,
            full_screen: false,
            bounds,
        }
    }

    const A: Rect = Rect {
        x: 10,
        y: 20,
        width: 1000,
        height: 700,
    };
    const SCREEN: Rect = Rect {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
    };

    #[test]
    fn captures_the_current_bounds_when_normal() {
        let mut t = BoundsTracker::default();
        let c = t.capture(state(A)).unwrap();
        assert_eq!((c.rect, c.maximized, c.full_screen), (A, false, false));
    }

    #[test]
    fn maximized_keeps_the_last_normal_rect() {
        let mut t = BoundsTracker::default();
        t.observe(state(A));
        let c = t
            .capture(WindowState {
                maximized: true,
                ..state(SCREEN)
            })
            .unwrap();
        assert_eq!((c.rect, c.maximized), (A, true));
        let c = t
            .capture(WindowState {
                full_screen: true,
                ..state(SCREEN)
            })
            .unwrap();
        assert_eq!((c.rect, c.full_screen), (A, true));
    }

    #[test]
    fn untrusted_states_are_skipped() {
        let mut t = BoundsTracker::default();
        assert!(
            t.capture(WindowState {
                minimized: true,
                ..state(A)
            })
            .is_none()
        );
        assert!(
            t.capture(WindowState {
                visible: false,
                ..state(A)
            })
            .is_none()
        );
    }

    #[test]
    fn identical_captures_are_dropped_until_a_write_fails() {
        let mut t = BoundsTracker::default();
        assert!(t.capture(state(A)).is_some());
        assert!(t.capture(state(A)).is_none());
        t.write_failed();
        assert!(t.capture(state(A)).is_some());
    }

    #[test]
    fn an_electron_file_round_trips_with_unknown_keys() {
        let text = r#"{"width":1200,"height":800,"x":100,"y":60,"isMaximized":true,"isFullScreen":false,"displayId":3}"#;
        let mut stored: StoredWindowBounds = serde_json::from_str(text).unwrap();
        assert_eq!(serde_json::to_string(&stored).unwrap(), text);
        stored.apply(Capture {
            rect: A,
            maximized: false,
            full_screen: false,
        });
        let value = serde_json::to_value(&stored).unwrap();
        assert_eq!(
            value,
            json!({"width":1000,"height":700,"x":10,"y":20,"isMaximized":false,"isFullScreen":false,"displayId":3})
        );
    }

    #[test]
    fn a_file_without_optional_keys_stays_without_them() {
        let text = r#"{"width":1200,"height":800}"#;
        let stored: StoredWindowBounds = serde_json::from_str(text).unwrap();
        assert_eq!(serde_json::to_string(&stored).unwrap(), text);
    }

    #[test]
    fn picker_grows_only_from_the_picker_size() {
        let picker = (900, 720);
        let mut s = saved(1200, 800, None, None);
        s.is_maximized = Some(true);
        assert_eq!(
            picker_transition(true, false, false, picker, Some(&s)),
            PickerTransition::Grow {
                size: Fallback {
                    width: 1200,
                    height: 800
                },
                maximize: true
            }
        );
        assert_eq!(
            picker_transition(true, false, false, picker, None),
            PickerTransition::Grow {
                size: DEFAULT_MAIN_SIZE,
                maximize: false
            }
        );
        assert_eq!(
            picker_transition(true, false, false, (1000, 700), Some(&s)),
            PickerTransition::None
        );
        // A picker the OS shrank to fit a small screen still grows.
        assert_eq!(
            picker_transition(true, false, false, (900, 686), None),
            PickerTransition::Grow {
                size: DEFAULT_MAIN_SIZE,
                maximize: false
            }
        );
        assert_eq!(
            picker_transition(true, false, true, picker, Some(&s)),
            PickerTransition::None
        );
    }

    #[test]
    fn picker_shrinks_unless_a_switch_is_running() {
        assert_eq!(
            picker_transition(false, false, false, (1550, 900), None),
            PickerTransition::ShrinkToPicker
        );
        assert_eq!(
            picker_transition(false, true, false, (1550, 900), None),
            PickerTransition::None
        );
        assert_eq!(
            picker_transition(false, false, false, (900, 720), None),
            PickerTransition::None
        );
    }
}
