//! tiptap's `injectExtensionAttributesToParseRule`: every parse rule's
//! `getAttrs` is the rule's own result merged with one value per attribute of
//! the target type, read from the element.
//!
//! ```text
//! old = rule.getAttrs ? rule.getAttrs(node) : rule.attrs
//! if old === false: no match
//! for each extension attribute of the type:
//!   value = attribute.parseHTML ? attribute.parseHTML(node) : fromString(node.getAttribute(name))
//!   a null or undefined value is skipped, the rest overrides `old`
//! ```
//!
//! The attributes of a type are the ones the schema declares, and what each
//! one's `parseHTML` reads is named here by node or mark type.

use yrs::Any;

use super::js::{from_string, js_parse_int};
use crate::markdown::bn::dom::{Dom, NodeId};
use crate::markdown::bn::dom_parser::AttrsResult;
use crate::markdown::frontmatter::js::parse_float;
use crate::markdown::pm::schema::Default as AttrDefault;
use crate::markdown::pm::{Attrs, Schema};

/// What a rule's own `getAttrs` or `parse` returns: `None` is `false` or
/// `undefined` (the rule does not apply), `Some` the attribute object. Keys
/// whose value is `undefined` are left out.
pub type Props = Vec<(&'static str, Any)>;

pub type Own = fn(&Dom, NodeId) -> AttrsResult;

pub fn props_result(props: Option<Props>) -> AttrsResult {
    match props {
        None => AttrsResult::Reject,
        Some(props) => AttrsResult::Attrs(
            props
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value))
                .collect(),
        ),
    }
}

pub fn text(value: &str) -> Any {
    Any::from(value)
}

fn set(attrs: &mut Attrs, name: &str, value: Any) {
    match attrs.iter_mut().find(|(n, _)| n == name) {
        Some((_, slot)) => *slot = value,
        None => attrs.push((name.to_owned(), value)),
    }
}

/// `camelToDataKebab`.
pub fn data_kebab(name: &str) -> String {
    let mut out = String::from("data-");
    let mut previous = ' ';
    for c in name.chars() {
        if previous.is_ascii_lowercase() && c.is_ascii_uppercase() {
            out.push('-');
        }
        out.push(c.to_ascii_lowercase());
        previous = c;
    }
    out
}

/// `propsToAttributes(...).parseHTML`: `data-<kebab>` read by the type of the
/// prop's default. A declared default of `undefined` is a number prop here
/// (`previewWidth`, `start`).
fn prop_attribute(dom: &Dom, id: NodeId, name: &str, default: AttrDefault) -> Option<Any> {
    let value = dom.attr(id, &data_kebab(name))?;
    match default {
        AttrDefault::Bool(_) => match value {
            "true" => Some(Any::Bool(true)),
            "false" => Some(Any::Bool(false)),
            _ => None,
        },
        AttrDefault::Number(_) | AttrDefault::Undefined => {
            let number = parse_float(value);
            number.is_finite().then_some(Any::Number(number))
        }
        _ => Some(text(value)),
    }
}

/// `getTextColorAttribute().parseHTML` and its two siblings in `defaultProps.ts`.
fn color_attribute(dom: &Dom, id: NodeId, data: &str, style_property: &str, default: &str) -> Any {
    if let Some(value) = dom.attr(id, data) {
        return text(value);
    }
    let style = dom.style(id);
    let value = style.get(style_property);
    text(if value.is_empty() { default } else { value })
}

fn text_color(dom: &Dom, id: NodeId) -> Any {
    color_attribute(dom, id, "data-text-color", "color", "default")
}

/// tiptap's table `colwidth`: `"100,200"` to `[100, 200]`, absent or empty to null.
fn colwidth(dom: &Dom, id: NodeId) -> Option<Any> {
    let value = dom.attr(id, "colwidth").filter(|v| !v.is_empty())?;
    let widths: Vec<Any> = value
        .split(',')
        .map(|w| Any::Number(js_parse_int(w)))
        .collect();
    Some(Any::from(widths))
}

/// `column.width`: `parseFloat(data-width ?? "")`, kept only when finite.
fn column_width(dom: &Dom, id: NodeId) -> Option<Any> {
    let parsed = parse_float(dom.attr(id, "data-width").unwrap_or(""));
    parsed.is_finite().then_some(Any::Number(parsed))
}

fn node_attribute(
    dom: &Dom,
    id: NodeId,
    ty: &str,
    name: &str,
    default: AttrDefault,
) -> Option<Any> {
    let cell = matches!(ty, "tableCell" | "tableHeader");
    match (ty, name) {
        // `UniqueID`'s global attribute.
        ("blockContainer" | "column" | "columnList", "id") => dom.attr(id, "data-id").map(text),
        ("column", "width") => column_width(dom, id),
        ("columnList", "regionId") => Some(text(dom.attr(id, "data-region-id").unwrap_or(""))),
        ("columnList", "settings") => Some(text(dom.attr(id, "data-settings").unwrap_or(""))),
        // `Table`'s own attributes carry no `parseHTML` but `colwidth`'s.
        (_, "colspan" | "rowspan") if cell => dom.attr(id, name).map(from_string),
        (_, "colwidth") if cell => colwidth(dom, id),
        // The global attributes of `TextColor`, `BackgroundColor`, `TextAlignment`.
        ("table", "textColor") => Some(text_color(dom, id)),
        (_, "textColor") if cell => Some(text_color(dom, id)),
        (_, "backgroundColor") if cell => Some(color_attribute(
            dom,
            id,
            "data-background-color",
            "background-color",
            "default",
        )),
        (_, "textAlignment") if cell => dom.attr(id, "data-text-alignment").map(text),
        _ => prop_attribute(dom, id, name, default),
    }
}

/// The wrapped `getAttrs` of a node type's rule.
pub fn wrap_node(dom: &Dom, id: NodeId, ty: &'static str, own: Option<Own>) -> AttrsResult {
    let mut attrs: Attrs = match own.map(|f| f(dom, id)) {
        Some(AttrsResult::Reject) => return AttrsResult::Reject,
        Some(AttrsResult::Attrs(attrs)) => attrs,
        Some(AttrsResult::NoAttrs) | None => Vec::new(),
    };
    let schema = Schema::memry();
    let node_ty = schema
        .node_type(ty)
        .expect("a node type of the memry schema");
    for attr in schema.node_ty(node_ty).spec.attrs {
        if let Some(value) = node_attribute(dom, id, ty, attr.name, attr.default) {
            set(&mut attrs, attr.name, value);
        }
    }
    AttrsResult::Attrs(attrs)
}

fn mark_attribute(dom: &Dom, id: NodeId, ty: &str, name: &str) -> Option<Any> {
    match (ty, name) {
        // `stylePropsToAttributes`.
        ("textColor" | "backgroundColor", "stringValue") => dom.attr(id, "data-value").map(text),
        ("link", "href") => dom.attr(id, "href").map(text),
        _ => None,
    }
}

/// The wrapped `getAttrs` of a mark type's rule.
pub fn wrap_mark(dom: &Dom, id: NodeId, ty: &'static str, own: Option<Own>) -> AttrsResult {
    let mut attrs: Attrs = match own.map(|f| f(dom, id)) {
        Some(AttrsResult::Reject) => return AttrsResult::Reject,
        Some(AttrsResult::Attrs(attrs)) => attrs,
        Some(AttrsResult::NoAttrs) | None => Vec::new(),
    };
    let schema = Schema::memry();
    let mark_ty = schema
        .mark_type(ty)
        .expect("a mark type of the memry schema");
    for attr in schema.mark_ty(mark_ty).spec.attrs {
        if let Some(value) = mark_attribute(dom, id, ty, attr.name) {
            set(&mut attrs, attr.name, value);
        }
    }
    AttrsResult::Attrs(attrs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::bn::dom::parse_fragment_in_div;

    fn first_element(html: &str) -> (Dom, NodeId) {
        let (dom, root) = parse_fragment_in_div(html);
        let el = dom.first_element_child(root).expect("an element");
        (dom, el)
    }

    fn cell(html: &str) -> (Dom, NodeId) {
        let (dom, root) = parse_fragment_in_div(&format!("<table><tr>{html}</tr></table>"));
        let el = dom
            .query_selector(root, &crate::markdown::bn::dom::Selector::new("td, th"))
            .expect("a cell");
        (dom, el)
    }

    fn attrs(result: AttrsResult) -> Attrs {
        match result {
            AttrsResult::Attrs(a) => a,
            other => panic!("expected attributes, got {other:?}"),
        }
    }

    fn get<'a>(attrs: &'a Attrs, name: &str) -> Option<&'a Any> {
        attrs.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    #[test]
    fn kebab_names() {
        assert_eq!(data_kebab("previewWidth"), "data-preview-width");
        assert_eq!(data_kebab("dateISO"), "data-date-iso");
        assert_eq!(data_kebab("url"), "data-url");
    }

    #[test]
    fn props_are_typed_by_their_default() {
        let (dom, el) = first_element(
            r#"<img data-name="n" data-show-preview="false" data-preview-width="300.5" data-level="x">"#,
        );
        let a = attrs(wrap_node(&dom, el, "image", None));
        assert_eq!(get(&a, "name"), Some(&Any::from("n")));
        assert_eq!(get(&a, "showPreview"), Some(&Any::Bool(false)));
        assert_eq!(get(&a, "previewWidth"), Some(&Any::Number(300.5)));
        assert_eq!(get(&a, "url"), None);

        let (dom, el) = first_element(r#"<h1 data-level="x" data-is-toggleable="yes">"#);
        let a = attrs(wrap_node(&dom, el, "heading", None));
        assert_eq!(get(&a, "level"), None);
        assert_eq!(get(&a, "isToggleable"), None);
    }

    #[test]
    fn own_result_is_overridden_and_rejects() {
        fn own(_: &Dom, _: NodeId) -> AttrsResult {
            AttrsResult::Attrs(vec![("level".into(), Any::Number(2.0))])
        }
        let (dom, el) = first_element(r#"<h1 data-level="4">"#);
        let a = attrs(wrap_node(&dom, el, "heading", Some(own)));
        assert_eq!(get(&a, "level"), Some(&Any::Number(4.0)));
        let (dom, el) = first_element("<h1>");
        let a = attrs(wrap_node(&dom, el, "heading", Some(own)));
        assert_eq!(get(&a, "level"), Some(&Any::Number(2.0)));
        fn reject(_: &Dom, _: NodeId) -> AttrsResult {
            AttrsResult::Reject
        }
        assert_eq!(
            wrap_node(&dom, el, "heading", Some(reject)),
            AttrsResult::Reject
        );
    }

    #[test]
    fn table_cells_read_globals_and_table_attributes() {
        let (dom, el) = cell(
            r#"<td colspan="2" rowspan="x" colwidth="100,200" style="color: #f00; text-align: center" data-text-alignment="right">"#,
        );
        let a = attrs(wrap_node(&dom, el, "tableCell", None));
        assert_eq!(get(&a, "colspan"), Some(&Any::Number(2.0)));
        assert_eq!(get(&a, "rowspan"), Some(&Any::from("x")));
        assert_eq!(
            get(&a, "colwidth"),
            Some(&Any::from(vec![Any::Number(100.0), Any::Number(200.0)]))
        );
        assert_eq!(get(&a, "textColor"), Some(&Any::from("rgb(255, 0, 0)")));
        assert_eq!(get(&a, "backgroundColor"), Some(&Any::from("default")));
        assert_eq!(get(&a, "textAlignment"), Some(&Any::from("right")));
    }

    #[test]
    fn ids_and_column_attributes() {
        let (dom, el) = first_element(r#"<div data-id="" data-width="2.5">"#);
        let a = attrs(wrap_node(&dom, el, "blockContainer", None));
        assert_eq!(get(&a, "id"), Some(&Any::from("")));
        let a = attrs(wrap_node(&dom, el, "column", None));
        assert_eq!(get(&a, "width"), Some(&Any::Number(2.5)));
        let a = attrs(wrap_node(&dom, el, "columnList", None));
        assert_eq!(get(&a, "regionId"), Some(&Any::from("")));
    }

    #[test]
    fn marks_read_their_attribute() {
        let (dom, el) = first_element(r##"<a href="#x" data-value="red">"##);
        assert_eq!(
            attrs(wrap_mark(&dom, el, "link", None)),
            vec![("href".to_owned(), Any::from("#x"))]
        );
        assert_eq!(
            attrs(wrap_mark(&dom, el, "textColor", None)),
            vec![("stringValue".to_owned(), Any::from("red"))]
        );
    }
}
