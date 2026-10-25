//! Constant tables of htmlparser2 10.1.0 `Parser.js`. Order inside a list never matters; they
//! are membership sets.

const P: &[&str] = &["p"];
const FORM: &[&str] = &[
    "input", "option", "optgroup", "select", "button", "datalist", "textarea",
];
const TABLE_SECTION: &[&str] = &["thead", "tbody"];
const DD_DT: &[&str] = &["dd", "dt"];
const RT_RP: &[&str] = &["rt", "rp"];

/// `openImpliesClose`: the open elements that a start tag closes first.
pub fn open_implies_close(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "tr" => &["tr", "th", "td"],
        "th" => &["th"],
        "td" => &["thead", "th", "td"],
        "body" => &["head", "link", "script"],
        "li" => &["li"],
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "address" | "article" | "aside"
        | "blockquote" | "details" | "div" | "dl" | "fieldset" | "figcaption" | "figure"
        | "footer" | "form" | "header" | "hr" | "main" | "nav" | "ol" | "pre" | "section"
        | "table" | "ul" => P,
        "select" | "input" | "output" | "button" | "datalist" | "textarea" => FORM,
        "option" => &["option"],
        "optgroup" => &["optgroup", "option"],
        "dd" | "dt" => DD_DT,
        "rt" | "rp" => RT_RP,
        "tbody" | "tfoot" => TABLE_SECTION,
        _ => return None,
    })
}

/// htmlparser2's `voidElements`. linkedom's own void list, used to serialise, differs.
pub fn is_void_element(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "basefont"
            | "br"
            | "col"
            | "command"
            | "embed"
            | "frame"
            | "hr"
            | "img"
            | "input"
            | "isindex"
            | "keygen"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

pub fn is_foreign_context_element(name: &str) -> bool {
    matches!(name, "math" | "svg")
}

pub fn is_html_integration_element(name: &str) -> bool {
    matches!(
        name,
        "mi" | "mo" | "mn" | "ms" | "mtext" | "annotation-xml" | "foreignobject" | "desc" | "title"
    )
}
