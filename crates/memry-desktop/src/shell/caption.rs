//! Hit testing of the Windows caption buttons. The renderer draws them and reports their
//! rectangles; the shell answers the native `WM_NCHITTEST` from these rectangles so Windows 11
//! shows its snap-layout flyout over the maximize button.

use super::bounds::Rect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionButton {
    Minimize,
    Maximize,
    Close,
}

impl CaptionButton {
    pub fn name(self) -> &'static str {
        match self {
            Self::Minimize => "minimize",
            Self::Maximize => "maximize",
            Self::Close => "close",
        }
    }

    /// The non-client hit-test code Windows maps to this button (`HTMINBUTTON`, `HTMAXBUTTON`,
    /// `HTCLOSE`).
    pub fn hit_code(self) -> isize {
        match self {
            Self::Minimize => 8,
            Self::Maximize => 9,
            Self::Close => 20,
        }
    }

    pub fn from_hit_code(code: isize) -> Option<Self> {
        match code {
            8 => Some(Self::Minimize),
            9 => Some(Self::Maximize),
            20 => Some(Self::Close),
            _ => None,
        }
    }
}

/// The three rectangles in client coordinates, physical pixels. All zero until the renderer
/// reports them, which hits nothing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CaptionRects {
    pub minimize: Option<Rect>,
    pub maximize: Option<Rect>,
    pub close: Option<Rect>,
}

fn contains(rect: Rect, x: i32, y: i32) -> bool {
    x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

impl CaptionRects {
    pub fn hit(&self, x: i32, y: i32) -> Option<CaptionButton> {
        [
            (CaptionButton::Minimize, self.minimize),
            (CaptionButton::Maximize, self.maximize),
            (CaptionButton::Close, self.close),
        ]
        .into_iter()
        .find_map(|(button, rect)| rect.filter(|r| contains(*r, x, y)).map(|_| button))
    }

    /// Where the input sink goes: the smallest rectangle around the reported buttons, below the
    /// top `resize_border` pixels (the resize handle of a restored window; 0 when maximized).
    /// `None` hides the sink: no button with an area, as when the page hides the buttons.
    pub fn sink_bounds(&self, resize_border: i32) -> Option<Rect> {
        let present = [self.minimize, self.maximize, self.close]
            .into_iter()
            .flatten()
            .filter(|r| r.width > 0 && r.height > 0);
        let (left, top, right, bottom) =
            present.fold(None, |acc: Option<(i32, i32, i32, i32)>, r| {
                let (l, t, rt, b) = (r.x, r.y, r.x + r.width, r.y + r.height);
                Some(match acc {
                    None => (l, t, rt, b),
                    Some((al, at, ar, ab)) => (al.min(l), at.min(t), ar.max(rt), ab.max(b)),
                })
            })?;
        let top = top.max(resize_border);
        (right > left && bottom > top).then_some(Rect {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rects() -> CaptionRects {
        let at = |x| {
            Some(Rect {
                x,
                y: 0,
                width: 46,
                height: 36,
            })
        };
        CaptionRects {
            minimize: at(1000),
            maximize: at(1046),
            close: at(1092),
        }
    }

    #[test]
    fn each_rectangle_answers_its_button() {
        let r = rects();
        assert_eq!(r.hit(1000, 0), Some(CaptionButton::Minimize));
        assert_eq!(r.hit(1060, 35), Some(CaptionButton::Maximize));
        assert_eq!(r.hit(1137, 10), Some(CaptionButton::Close));
    }

    #[test]
    fn edges_and_outside_hit_nothing() {
        let r = rects();
        assert_eq!(r.hit(999, 10), None);
        assert_eq!(r.hit(1138, 10), None);
        assert_eq!(r.hit(1010, 36), None);
        assert_eq!(CaptionRects::default().hit(0, 0), None);
    }

    #[test]
    fn sink_covers_the_buttons_below_the_resize_border() {
        let sink = |border| rects().sink_bounds(border);
        let at = |y, height| Rect {
            x: 1000,
            y,
            width: 138,
            height,
        };
        assert_eq!(sink(0), Some(at(0, 36)));
        assert_eq!(sink(8), Some(at(8, 28)));
        assert_eq!(sink(36), None);
    }

    #[test]
    fn sink_hides_without_buttons() {
        let empty = Some(Rect {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        });
        let hidden = CaptionRects {
            minimize: empty,
            maximize: empty,
            close: empty,
        };
        assert_eq!(hidden.sink_bounds(0), None);
        assert_eq!(CaptionRects::default().sink_bounds(0), None);
    }

    #[test]
    fn hit_codes_round_trip() {
        for b in [
            CaptionButton::Minimize,
            CaptionButton::Maximize,
            CaptionButton::Close,
        ] {
            assert_eq!(CaptionButton::from_hit_code(b.hit_code()), Some(b));
        }
        assert_eq!(CaptionButton::from_hit_code(1), None);
    }
}
