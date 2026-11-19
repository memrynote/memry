//! Which window has a canvas mounted in its editor: port of `canvas/live-registry.ts`, fed by
//! `canvas_live_opened` / `canvas_live_closed`. An agent write to a canvas the user has open must
//! reach that editor, or its next autosave overwrites the write. A stale entry is harmless: the
//! write falls back to the headless path, which is guarded by the read stamp.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct LiveCanvases(Mutex<Registry>);

#[derive(Default)]
struct Registry {
    owners: HashMap<String, String>,
}

impl LiveCanvases {
    /// `markCanvasOpen`.
    pub fn open(&self, canvas_id: &str, window: &str) {
        let mut registry = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry
            .owners
            .insert(canvas_id.to_owned(), window.to_owned());
    }

    /// `markCanvasClosed`: only the current owner releases a canvas, so a window that unmounts
    /// after another opened the same canvas does not evict the newer owner.
    pub fn close(&self, canvas_id: &str, window: &str) {
        let mut registry = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if registry
            .owners
            .get(canvas_id)
            .is_some_and(|owner| owner == window)
        {
            registry.owners.remove(canvas_id);
        }
    }

    /// `forgetWindow`: a closed window owns nothing.
    pub fn forget_window(&self, window: &str) {
        let mut registry = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.owners.retain(|_, owner| owner != window);
    }

    /// `getCanvasWindowId`.
    pub fn window_of(&self, canvas_id: &str) -> Option<String> {
        let registry = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.owners.get(canvas_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::LiveCanvases;

    #[test]
    fn the_latest_opener_owns_a_canvas_until_it_closes_it() {
        let live = LiveCanvases::default();
        assert_eq!(live.window_of("c1"), None);
        live.open("c1", "main");
        assert_eq!(live.window_of("c1").as_deref(), Some("main"));
        live.open("c1", "w2");
        live.close("c1", "main");
        assert_eq!(live.window_of("c1").as_deref(), Some("w2"));
        live.close("c1", "w2");
        assert_eq!(live.window_of("c1"), None);
    }

    #[test]
    fn a_closed_window_owns_nothing() {
        let live = LiveCanvases::default();
        live.open("c1", "main");
        live.open("c2", "main");
        live.open("c3", "w2");
        live.forget_window("main");
        assert_eq!(live.window_of("c1"), None);
        assert_eq!(live.window_of("c2"), None);
        assert_eq!(live.window_of("c3").as_deref(), Some("w2"));
        live.open("c1", "main");
        assert_eq!(live.window_of("c1").as_deref(), Some("main"));
    }
}
