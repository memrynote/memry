//! The init scripts this crate adds to every window it builds.

const DRAG_REGION: &str = include_str!("scripts/drag-region.js");

/// What the page may know about its window. Step 10d adds the loopback origin and token.
#[derive(Debug, Clone, Copy)]
pub struct ShellGlobals {
    pub maximizable: bool,
}

/// `window.__MEMRY_SHELL__`, then the drag-region listeners. Main-frame only: it is added with
/// `initialization_script`, never the all-frames variant, so a `memry-html:` or YouTube frame
/// sees none of it.
pub fn init_script(globals: ShellGlobals) -> String {
    format!(
        "window.__MEMRY_SHELL__ = Object.freeze({{ maximizable: {} }});\n{DRAG_REGION}",
        globals.maximizable
    )
}

/// The drag-region script alone, for windows that build their own globals (the sticky and the
/// quick capture windows of Steps 27 and 31).
pub fn drag_region_script() -> &'static str {
    DRAG_REGION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_publishes_the_globals_before_the_listeners() {
        let script = init_script(ShellGlobals { maximizable: false });
        assert!(
            script.starts_with("window.__MEMRY_SHELL__ = Object.freeze({ maximizable: false });")
        );
        assert!(script.contains("plugin:window|start_dragging"));
        assert!(script.contains("plugin:window|toggle_maximize"));
    }
}
