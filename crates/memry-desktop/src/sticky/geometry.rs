//! Placement and size of the sticky window (`sticky-window.ts:24-56,125-130`). Positions are
//! physical pixels, as the monitor work area and the cursor are; sizes are logical.

/// The card plus the transparent margin its shadow draws into.
pub const WIDTH: f64 = 360.0;
pub const INITIAL_HEIGHT: f64 = 230.0;
pub const MIN_HEIGHT: f64 = 140.0;
pub const MAX_HEIGHT: f64 = 560.0;
/// How far above the cursor the window's top edge sits.
const ABOVE_CURSOR: f64 = 60.0;

/// A rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// The sticky's top-left corner: the cursor at its horizontal centre and 60 logical pixels below
/// its top edge, kept inside the work area of the cursor's display.
pub fn place_near_cursor(cursor: (f64, f64), area: Rect, scale: f64) -> (i32, i32) {
    let width = (WIDTH * scale).round() as i32;
    let height = (INITIAL_HEIGHT * scale).round() as i32;
    let x = (cursor.0 - f64::from(width) / 2.0).round() as i32;
    let y = (cursor.1 - ABOVE_CURSOR * scale).round() as i32;
    let right = area.x + area.width as i32 - width;
    let bottom = area.y + area.height as i32 - height;
    // `min` then `max`, as Electron: a work area narrower than the window keeps its left edge.
    (x.min(right).max(area.x), y.min(bottom).max(area.y))
}

/// The renderer's measured card height, clamped (`resizeStickyWindow`).
pub fn clamp_height(height: f64) -> f64 {
    height.round().clamp(MIN_HEIGHT, MAX_HEIGHT)
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
    fn the_cursor_sits_at_the_horizontal_centre_and_60_below_the_top() {
        assert_eq!(place_near_cursor((700.0, 400.0), PRIMARY, 1.0), (520, 340));
    }

    #[test]
    fn every_scale_keeps_the_offsets_in_logical_pixels() {
        for scale in [1.0, 1.5, 2.0] {
            let area = Rect {
                x: 0,
                y: 0,
                width: (1920.0 * scale) as u32,
                height: (1080.0 * scale) as u32,
            };
            let cursor = (960.0 * scale, 540.0 * scale);
            let (x, y) = place_near_cursor(cursor, area, scale);
            assert_eq!(
                x,
                (cursor.0 - 180.0 * scale).round() as i32,
                "scale {scale}"
            );
            assert_eq!(y, (cursor.1 - 60.0 * scale).round() as i32, "scale {scale}");
        }
    }

    #[test]
    fn near_an_edge_the_window_stays_inside_the_work_area() {
        assert_eq!(place_near_cursor((5.0, 30.0), PRIMARY, 1.0), (0, 25));
        assert_eq!(
            place_near_cursor((1439.0, 899.0), PRIMARY, 1.0),
            (1080, 670)
        );
        // 150 percent: the window is 540 by 345 physical pixels.
        assert_eq!(place_near_cursor((1439.0, 899.0), PRIMARY, 1.5), (900, 555));
    }

    #[test]
    fn a_second_monitor_left_of_the_primary_clamps_to_its_own_work_area() {
        let left = Rect {
            x: -2560,
            y: -200,
            width: 2560,
            height: 1415,
        };
        assert_eq!(
            place_near_cursor((-2559.0, -199.0), left, 2.0),
            (-2560, -200)
        );
        assert_eq!(place_near_cursor((-10.0, 1000.0), left, 2.0), (-720, 755));
    }

    #[test]
    fn heights_clamp_to_140_and_560() {
        assert_eq!(clamp_height(12.0), MIN_HEIGHT);
        assert_eq!(clamp_height(230.4), 230.0);
        assert_eq!(clamp_height(9000.0), MAX_HEIGHT);
    }
}
