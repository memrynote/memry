//! The init scripts this crate adds to every window it builds.

const DRAG_REGION: &str = include_str!("scripts/drag-region.js");

/// What the page may know about its window: whether it maximizes, and where the loopback media
/// server listens (`http://127.0.0.1:<port>` and the token its routes carry).
#[derive(Debug, Clone)]
pub struct ShellGlobals {
    pub maximizable: bool,
    pub loopback_origin: String,
    pub loopback_token: String,
}

/// `window.__MEMRY_SHELL__`, then the drag-region listeners. Main-frame only: it is added with
/// `initialization_script`, never the all-frames variant, so a `memry-html:` or YouTube frame
/// sees none of it.
pub fn init_script(globals: ShellGlobals) -> String {
    let json = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned());
    format!(
        "window.__MEMRY_SHELL__ = Object.freeze({{ maximizable: {}, loopbackOrigin: {}, loopbackToken: {} }});\n{DRAG_REGION}",
        globals.maximizable,
        json(&globals.loopback_origin),
        json(&globals.loopback_token)
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
        let loopback_token = "ab12".to_owned();
        let script = init_script(ShellGlobals {
            maximizable: false,
            loopback_origin: "http://127.0.0.1:4000".to_owned(),
            loopback_token,
        });
        assert!(script.starts_with(
            "window.__MEMRY_SHELL__ = Object.freeze({ maximizable: false, loopbackOrigin: \"http://127.0.0.1:4000\", loopbackToken: \"ab12\" });"
        ));
        assert!(script.contains("plugin:window|start_dragging"));
        assert!(script.contains("plugin:window|toggle_maximize"));
    }
}
