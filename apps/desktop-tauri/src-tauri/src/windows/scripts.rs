//! The init scripts this crate adds to every window it builds.

const DRAG_REGION: &str = include_str!("scripts/drag-region.js");

/// What the page may know about its window: whether it maximizes, and where the loopback media
/// server listens (`http://127.0.0.1:<port>` and the token its routes carry).
#[derive(Debug, Clone)]
pub struct ShellGlobals {
    pub maximizable: bool,
    pub loopback_origin: String,
    pub loopback_token: String,
    /// The origins of the app's own pages. Init scripts run in whatever page the main frame shows,
    /// so a page that got there anyway (see `shell::navigation_guard::pin_main_frame`) must not
    /// be handed the token.
    pub app_origins: Vec<String>,
}

/// `window.__MEMRY_SHELL__`, then the drag-region listeners, in the top frame of an app page only.
/// wry runs init scripts in every frame on Windows whatever the builder asks
/// (`for_main_frame_only` is ignored there), so the script checks `window.top === window` itself:
/// a `memry-html:` embed or a YouTube frame must not see the loopback token.
pub fn init_script(globals: ShellGlobals) -> String {
    let json = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned());
    let origins = serde_json::to_string(&globals.app_origins).unwrap_or_else(|_| "[]".to_owned());
    format!(
        "if (window.top === window && {origins}.includes(location.protocol + '//' + location.host)) {{\nwindow.__MEMRY_SHELL__ = Object.freeze({{ maximizable: {}, loopbackOrigin: {}, loopbackToken: {} }});\n{DRAG_REGION}\n}}",
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
            app_origins: vec!["tauri://localhost".to_owned()],
        });
        assert!(script.starts_with(
            "if (window.top === window && [\"tauri://localhost\"].includes(location.protocol + '//' + location.host)) {\nwindow.__MEMRY_SHELL__ = Object.freeze({ maximizable: false, loopbackOrigin: \"http://127.0.0.1:4000\", loopbackToken: \"ab12\" });"
        ));
        assert!(script.trim_end().ends_with('}'));
        assert!(script.contains("plugin:window|start_dragging"));
        assert!(script.contains("plugin:window|toggle_maximize"));
    }
}
