//! Names every window kind and answers "which windows does the app have". Every "first live
//! window" decision calls [`WindowRegistry::main_window`]; none reads `webview_windows()`.

use serde::Serialize;
use tauri::{AppHandle, Runtime, WebviewWindow};

use super::MAIN_LABEL;
use crate::events::send_to;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowKind {
    Main,
    QuickCapture,
    Sticky,
    EdgeTab,
    PdfPrint,
    Preboot,
    StartupError,
    TestSecondary,
}

impl WindowKind {
    pub fn of_label(label: &str) -> Option<Self> {
        match label {
            MAIN_LABEL => Some(Self::Main),
            "quick-capture" => Some(Self::QuickCapture),
            "sticky" => Some(Self::Sticky),
            "sticky-tab" => Some(Self::EdgeTab),
            "preboot" => Some(Self::Preboot),
            "startup-error" => Some(Self::StartupError),
            other if other.starts_with("pdf-print-") => Some(Self::PdfPrint),
            other if other.starts_with("e2e-") => Some(Self::TestSecondary),
            _ => None,
        }
    }

    /// The label of a window of this kind. `index` numbers the kinds that can have several.
    pub fn label(self, index: u32) -> String {
        match self {
            Self::Main => MAIN_LABEL.to_owned(),
            Self::QuickCapture => "quick-capture".to_owned(),
            Self::Sticky => "sticky".to_owned(),
            Self::EdgeTab => "sticky-tab".to_owned(),
            Self::PdfPrint => format!("pdf-print-{index}"),
            Self::Preboot => "preboot".to_owned(),
            Self::StartupError => "startup-error".to_owned(),
            Self::TestSecondary => format!("e2e-{index}"),
        }
    }

    /// Windows that show app content: they receive broadcasts and the zoom.
    pub fn is_app_window(self) -> bool {
        matches!(self, Self::Main | Self::Sticky | Self::TestSecondary)
    }
}

pub struct WindowRegistry;

impl WindowRegistry {
    /// The main window, else the first live test secondary window.
    pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
        Self::app_windows(app)
            .into_iter()
            .find(|w| WindowKind::of_label(w.label()) == Some(WindowKind::Main))
            .or_else(|| {
                Self::app_windows(app)
                    .into_iter()
                    .find(|w| WindowKind::of_label(w.label()) == Some(WindowKind::TestSecondary))
            })
    }

    /// Live windows that show app content, ordered by label.
    pub fn app_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<WebviewWindow<R>> {
        use tauri::Manager;
        let mut windows: Vec<_> = app
            .webview_windows()
            .into_values()
            .filter(|w| WindowKind::of_label(w.label()).is_some_and(WindowKind::is_app_window))
            .collect();
        windows.sort_by(|a, b| a.label().cmp(b.label()));
        windows
    }

    /// Emits `event` to every app window over the guarded helper.
    pub fn broadcast<R, E>(app: &AppHandle<R>, event: E)
    where
        R: Runtime,
        E: tauri_specta::Event + Serialize + Clone,
    {
        for window in Self::app_windows(app) {
            send_to(app, window.label(), event.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_round_trip_and_app_windows_are_main_sticky_and_test() {
        for kind in [
            WindowKind::Main,
            WindowKind::QuickCapture,
            WindowKind::Sticky,
            WindowKind::EdgeTab,
            WindowKind::PdfPrint,
            WindowKind::Preboot,
            WindowKind::StartupError,
            WindowKind::TestSecondary,
        ] {
            assert_eq!(WindowKind::of_label(&kind.label(7)), Some(kind));
        }
        assert_eq!(WindowKind::of_label("unknown"), None);
        let app: Vec<_> = [
            WindowKind::Main,
            WindowKind::Sticky,
            WindowKind::TestSecondary,
        ]
        .into_iter()
        .filter(|k| k.is_app_window())
        .collect();
        assert_eq!(app.len(), 3);
        assert!(!WindowKind::QuickCapture.is_app_window());
        assert!(!WindowKind::EdgeTab.is_app_window());
        assert!(!WindowKind::PdfPrint.is_app_window());
        assert!(!WindowKind::Preboot.is_app_window());
        assert!(!WindowKind::StartupError.is_app_window());
    }
}
