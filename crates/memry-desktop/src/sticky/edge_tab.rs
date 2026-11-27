//! The edge tab's rules (`apps/desktop/src/main/stickies/edge-tab.ts`): when it shows, and where
//! it sits on the screen edge, collapsed or fanned out over the draft list.

use super::geometry::Rect;

/// The tab plus room for its shadow, in logical pixels.
const COLLAPSED: (f64, f64) = (44.0, 84.0);
const PEEK_WIDTH: f64 = 300.0;
const PEEK_ROW_HEIGHT: f64 = 52.0;
const PEEK_CHROME_HEIGHT: f64 = 64.0;
const PEEK_MAX_ROWS: usize = 5;
/// The tab's top edge, as a share of the work area's height from its top.
const TOP: f64 = 0.32;

/// The screen edge the tab sits on (`sticky.tuckEdge`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Edge {
    Left,
    #[default]
    Right,
}

impl Edge {
    /// `left` is the left edge; any other value the right one, as `boundsFor` reads it.
    pub fn parse(value: &str) -> Self {
        if value == "left" {
            Self::Left
        } else {
            Self::Right
        }
    }
}

/// Where the tab goes: its top-left corner in physical pixels and its size in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: f64,
    pub height: f64,
}

/// `boundsFor` and `applyBounds`: collapsed, or the peek list sized for at most five of `drafts`.
/// The top stays put when the list fans out below it, so the height is capped to the work area
/// below the top edge. `area` is the work area of the display the tab opened on, physical; `scale`
/// is that display's.
pub fn bounds(area: Rect, scale: f64, edge: Edge, peeking: bool, drafts: usize) -> Bounds {
    let (width, height) = if peeking {
        let rows = drafts.min(PEEK_MAX_ROWS) as f64;
        (PEEK_WIDTH, PEEK_CHROME_HEIGHT + rows * PEEK_ROW_HEIGHT)
    } else {
        COLLAPSED
    };
    let bottom = area.y + area.height as i32;
    let y = (f64::from(area.y) + f64::from(area.height) * TOP).round() as i32;
    let x = match edge {
        Edge::Left => area.x,
        Edge::Right => area.x + area.width as i32 - (width * scale).round() as i32,
    };
    Bounds {
        x,
        y,
        width,
        height: height.min(f64::from(bottom - y) / scale),
    }
}

/// `shouldShow`: only while no sticky is open and drafts exist, and, where the app ends with its
/// last window (Windows, Linux), only while an app window does, or the tab would keep it running.
pub fn should_show(
    sticky_open: bool,
    drafts: usize,
    app_window: bool,
    app_outlives_windows: bool,
) -> bool {
    !sticky_open && drafts > 0 && (app_window || app_outlives_windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: Rect = Rect {
        x: 0,
        y: 25,
        width: 1440,
        height: 875,
    };

    #[test]
    fn collapsed_the_tab_sits_on_the_edge_at_32_percent_of_the_work_area() {
        let right = bounds(PRIMARY, 1.0, Edge::Right, false, 3);
        assert_eq!(
            right,
            Bounds {
                x: 1396,
                y: 305,
                width: 44.0,
                height: 84.0
            }
        );
        let left = bounds(PRIMARY, 1.0, Edge::Left, false, 3);
        assert_eq!((left.x, left.y), (0, 305));
    }

    #[test]
    fn the_peek_list_grows_by_52_a_row_up_to_five_rows() {
        let one = bounds(PRIMARY, 1.0, Edge::Right, true, 1);
        assert_eq!((one.x, one.width, one.height), (1140, 300.0, 116.0));
        let nine = bounds(PRIMARY, 1.0, Edge::Right, true, 9);
        assert_eq!(nine.height, 64.0 + 5.0 * 52.0);
        assert_eq!(nine.y, one.y, "the top stays put");
    }

    #[test]
    fn every_scale_keeps_the_sizes_logical_and_the_right_edge_flush() {
        for scale in [1.0, 1.5, 2.0] {
            let area = Rect {
                x: 0,
                y: 0,
                width: (1920.0 * scale) as u32,
                height: (1080.0 * scale) as u32,
            };
            let tab = bounds(area, scale, Edge::Right, true, 2);
            assert_eq!((tab.width, tab.height), (300.0, 168.0), "scale {scale}");
            assert_eq!(
                tab.x + (tab.width * scale).round() as i32,
                area.width as i32,
                "scale {scale}"
            );
            assert_eq!(tab.y, (1080.0 * scale * 0.32).round() as i32);
        }
    }

    #[test]
    fn a_second_monitor_uses_its_own_work_area_and_a_short_one_caps_the_height() {
        let left_of_primary = Rect {
            x: -2560,
            y: -200,
            width: 2560,
            height: 1415,
        };
        let tab = bounds(left_of_primary, 2.0, Edge::Left, false, 1);
        assert_eq!((tab.x, tab.y), (-2560, 253));
        let short = Rect {
            x: 0,
            y: 0,
            width: 800,
            height: 300,
        };
        // y is 96, which leaves 204 physical pixels below it: 102 logical at 200 percent.
        let peek = bounds(short, 2.0, Edge::Right, true, 5);
        assert_eq!((peek.y, peek.height), (96, 102.0));
    }

    #[test]
    fn the_tab_shows_only_with_drafts_no_sticky_and_off_macos_an_app_window() {
        assert!(should_show(false, 1, true, false));
        assert!(!should_show(true, 1, true, false), "the sticky is open");
        assert!(!should_show(false, 0, true, false), "no drafts");
        assert!(
            !should_show(false, 1, false, false),
            "no app window off macOS"
        );
        assert!(should_show(false, 1, false, true), "macOS keeps the tab");
    }

    #[test]
    fn only_left_is_the_left_edge() {
        assert_eq!(Edge::parse("left"), Edge::Left);
        assert_eq!(Edge::parse("right"), Edge::Right);
        assert_eq!(Edge::parse("top"), Edge::Right);
    }
}
