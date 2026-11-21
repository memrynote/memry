//! A board's widgets as the Home grid reads them (`rowToHomePage` and
//! `parseWidgets`, `apps/desktop/src/main/ipc/home-page-handlers.ts:43-103`).
//!
//! The record keeps the widgets as opaque JSON array text, and a widget of a
//! type this build does not know stays in it. Boards saved before the
//! resizable grid hold `{ id, type, size, config }` widgets; they are placed
//! on read (S 2x2, M 4x4, L 8x4, stacked in one column with a running `y`),
//! and the next layout save writes real coordinates. The stored text is never
//! rewritten here.

use serde_json::{Map, Value};

/// One widget placed on the grid.
#[derive(Debug, Clone, PartialEq)]
pub struct Widget {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// The widget's settings; `{}` when it has none.
    pub config: Map<String, Value>,
}

/// `LEGACY_SPAN`: a legacy size's grid span, M for one it does not name.
fn legacy_span(size: Option<&Value>) -> (f64, f64) {
    match size.and_then(Value::as_str) {
        Some("S") => (2.0, 2.0),
        Some("L") => (8.0, 4.0),
        _ => (4.0, 4.0),
    }
}

/// `String(value)` of a JSON value, `"undefined"` when absent.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(_)) => String::new(),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        Some(other) => other.to_string(),
    }
}

fn config(widget: &Map<String, Value>) -> Map<String, Value> {
    match widget.get("config") {
        Some(Value::Object(config)) => config.clone(),
        _ => Map::new(),
    }
}

/// The widgets of `text`, legacy ones placed, or `None` for text that is not
/// a JSON array. The caller renders such a board empty instead of failing the
/// whole list, which would seed a new board on every launch. An element that
/// is not an object is left out.
pub fn display(text: &str) -> Option<Vec<Widget>> {
    let Ok(Value::Array(raw)) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    let mut y = 0.0;
    let widgets = raw
        .iter()
        .filter_map(Value::as_object)
        .map(|widget| {
            let placed = ["x", "y", "w", "h"].map(|key| widget.get(key).and_then(Value::as_f64));
            if let [Some(x), Some(wy), Some(w), Some(h)] = placed {
                return Widget {
                    id: js_string(widget.get("id")),
                    kind: js_string(widget.get("type")),
                    x,
                    y: wy,
                    w,
                    h,
                    config: config(widget),
                };
            }
            let (w, h) = legacy_span(widget.get("size"));
            let migrated = Widget {
                id: js_string(widget.get("id")),
                kind: js_string(widget.get("type")),
                x: 0.0,
                y,
                w,
                h,
                config: config(widget),
            };
            y += h;
            migrated
        })
        .collect();
    Some(widgets)
}
