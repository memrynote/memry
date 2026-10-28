//! The preboot and startup-error windows share `preboot.html`, a bundled page with no script.
//! No capability names their labels, so they reach no plugin command, and the page has nothing
//! that calls one anyway. The shell fills the page with `eval` once it has loaded, and the copy
//! lands in `textContent` only. Script the host evaluates runs outside the page's CSP, so the
//! app CSP needs no exception for them. The preboot window itself is shown by the updater
//! (Step 38, #3555).

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::{self, LocaleService};
use tauri::webview::{Color, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};

use super::registry::WindowKind;

/// The page background, so a window shown before its page loads does not flash white.
const BACKGROUND: Color = Color(246, 245, 240, 255);

/// One of the two views of `preboot.html`, with the text of each of its slots.
pub(super) struct PageFill {
    pub view: &'static str,
    pub slots: Vec<(&'static str, String)>,
}

/// The locale of the native copy: the live one, or the OS one when startup failed before the
/// locale service existed.
pub(crate) fn locale(app: &AppHandle<Wry>) -> &'static str {
    app.try_state::<Arc<LocaleService>>()
        .map(|service| service.get())
        .unwrap_or_else(|| locale::resolve_os_locale(sys_locale::get_locale().as_deref()))
}

/// The copy of `key`, a full `ns:key` literal, so the i18n check sees it used.
pub(super) fn text(locale: &str, key: &str, args: &Args) -> String {
    i18n::t(locale, key, args)
}

/// The script that fills the page. Every value is a JSON string literal and lands in
/// `textContent`, so no copy or error message is ever parsed as markup.
fn fill_script(fill: &PageFill, locale: &str) -> String {
    let json = |value: &str| serde_json::Value::from(value).to_string();
    let mut script = format!(
        "(()=>{{const root=document.documentElement;root.lang={};root.dir={};root.dataset.view={};",
        json(locale),
        json(locale::direction(locale)),
        json(fill.view),
    );
    for (slot, value) in &fill.slots {
        script.push_str(&format!(
            "document.querySelector({}).textContent={};",
            json(&format!(".{} [data-slot='{slot}']", fill.view)),
            json(value),
        ));
    }
    script.push_str("})()");
    script
}

/// Builds a window on `preboot.html` that fills itself once the page has loaded and is shown
/// then when `show_on_fill` is set. `configure` sets the window's size and frame.
pub(super) fn build(
    app: &AppHandle<Wry>,
    kind: WindowKind,
    fill: PageFill,
    show_on_fill: bool,
    configure: impl FnOnce(
        WebviewWindowBuilder<'_, Wry, AppHandle<Wry>>,
    ) -> WebviewWindowBuilder<'_, Wry, AppHandle<Wry>>,
) -> tauri::Result<WebviewWindow<Wry>> {
    let script = fill_script(&fill, locale(app));
    let builder =
        WebviewWindowBuilder::new(app, kind.label(0), WebviewUrl::App("preboot.html".into()))
            .title("MemryNote")
            .background_color(BACKGROUND)
            .center()
            .resizable(false)
            .maximizable(false)
            .on_page_load(move |window, payload| {
                if !matches!(payload.event(), PageLoadEvent::Finished) {
                    return;
                }
                if let Err(error) = window.eval(&script) {
                    tracing::warn!(
                        scope = "Window",
                        "{} page not filled: {error}",
                        window.label()
                    );
                }
                if show_on_fill && let Err(error) = window.show() {
                    tracing::warn!(scope = "Window", "{} not shown: {error}", window.label());
                }
            });
    super::main_window::webview_profile(configure(builder), app).build()
}

/// The copy of the preboot window.
pub struct PrebootCopy {
    pub title: String,
    pub subtitle: String,
}

/// Shows the small frameless spinner window, once its page is filled. Step 38 (#3555) shows it
/// while an update installs.
pub fn show_preboot(app: &AppHandle<Wry>, copy: PrebootCopy) -> tauri::Result<WebviewWindow<Wry>> {
    let fill = PageFill {
        view: "preboot",
        slots: vec![("title", copy.title), ("subtitle", copy.subtitle)],
    };
    build(app, WindowKind::Preboot, fill, true, |builder| {
        builder
            .inner_size(380.0, 180.0)
            .decorations(false)
            .minimizable(false)
            .visible(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_lands_in_text_content_as_json_strings() {
        let fill = PageFill {
            view: "error",
            slots: vec![(
                "details",
                "</div><img src=x onerror=alert(1)>\"'\n".to_owned(),
            )],
        };
        let script = fill_script(&fill, "ar");
        assert!(script.contains("root.dir=\"rtl\""));
        assert!(script.contains(
            "document.querySelector(\".error [data-slot='details']\").textContent=\"</div><img src=x onerror=alert(1)>\\\"'\\n\";"
        ));
    }
}
