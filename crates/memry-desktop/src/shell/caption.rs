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
