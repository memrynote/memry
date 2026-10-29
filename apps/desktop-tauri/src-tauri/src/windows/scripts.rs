//! The init scripts this crate adds to every window it builds.

const DRAG_REGION: &str = include_str!("scripts/drag-region.js");
/// F12 opens the inspector, which only a debug build has.
const DEVTOOLS_F12: &str = if cfg!(debug_assertions) {
    include_str!("scripts/devtools-f12.js")
} else {
    ""
};

/// What the page may know about its window: whether it maximizes, and where the loopback media
/// server listens (`http://127.0.0.1:<port>` and the token its routes carry).
#[derive(Debug, Clone)]
pub struct ShellGlobals {
    pub maximizable: bool,
    pub loopback_origin: String,
    pub loopback_token: String,
}

/// `window.__MEMRY_SHELL__`, then the drag-region listeners, then F12 in a debug build.
pub fn init_script(globals: ShellGlobals) -> String {
    let json = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned());
    format!(
        "window.__MEMRY_SHELL__ = Object.freeze({{ maximizable: {}, loopbackOrigin: {}, loopbackToken: {} }});\n{DRAG_REGION}{DEVTOOLS_F12}",
        globals.maximizable,
        json(&globals.loopback_origin),
        json(&globals.loopback_token)
    )
}

/// Runs `body` in the top frame of an app page only. wry runs init scripts in every frame on
/// Windows whatever the builder asks (`for_main_frame_only` is ignored there), and in whatever page
/// the main frame shows, so a `memry-html:` embed, a YouTube frame, or a page that reached the main
/// frame anyway (`shell::navigation_guard::check_commit`) never sees the loopback token or the
/// startup state (the vault path, which names the OS user).
pub fn app_page_only(app_origins: &[String], body: &str) -> String {
    let origins = serde_json::to_string(app_origins).unwrap_or_else(|_| "[]".to_owned());
    format!(
        "if (window.top === window && {origins}.includes(location.protocol + '//' + location.host)) {{\n{body}\n}}"
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
        assert_eq!(
            script.contains("internal_toggle_devtools"),
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn a_gated_script_runs_in_the_top_frame_of_an_app_page_only() {
        let script = app_page_only(&["tauri://localhost".to_owned()], "window.x = 1;");
        assert_eq!(
            script,
            "if (window.top === window && [\"tauri://localhost\"].includes(location.protocol + '//' + location.host)) {\nwindow.x = 1;\n}"
        );
    }
}
