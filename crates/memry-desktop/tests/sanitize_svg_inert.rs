//! `vault::svg` writes icons that stay inert as documents of their own: opened as
//! `image/svg+xml` in a browser, in Quick Look, or inlined into HTML by an export.
//!
//! Each hostile case below gets past the TypeScript sanitizer: its output fails the check of
//! `svg_inert`, so every case is a real gap. The output the app writes passes the check and
//! is a fixpoint. Icons as the usual editors export them keep their drawing.

mod svg_inert;

use memry_desktop::vault::svg::{sanitize_svg, sanitize_svg_as_typescript};
use memry_test_kit::proptest_config;
use proptest::prelude::*;
use svg_inert::check_inert;

const HOSTILE: &[(&str, &str)] = &[
    (
        "a stray < rejoins the text after a dropped tag into an event handler",
        r#"<svg><<a>svg onload="alert(1)"></svg>"#,
    ),
    (
        "a stray < rejoins into a script",
        "<svg><<a>script>alert(1)<</a>/script></svg>",
    ),
    (
        "a stray < rejoins into a DOCTYPE with an external entity",
        r#"<<a>!DOCTYPE svg [<<a>!ENTITY x SYSTEM "http://127.0.0.1:9/x">]><svg>&x;</svg>"#,
    ),
    (
        "a removed processing instruction rejoins into a stylesheet link",
        r#"<<?x?>?xml-stylesheet href="http://127.0.0.1:9/x.css"?><svg/>"#,
    ),
    (
        "a prefix bound to XLink",
        r#"<svg xmlns:x="http://www.w3.org/1999/xlink"><use x:href="http://127.0.0.1:9/a.svg#b"/></svg>"#,
    ),
    (
        "an entity in a style attribute",
        r#"<svg><rect style="fill:ur&#108;(http://127.0.0.1:9/a.svg#g)"/></svg>"#,
    ),
    (
        "an entity in a style element",
        "<svg><style>rect{fill:ur&#108;(http://127.0.0.1:9/a.svg#g)}</style><rect/></svg>",
    ),
    (
        "a CSS escape",
        r#"<svg><rect style="fill:u\72l(http://127.0.0.1:9/a.svg#g)"/></svg>"#,
    ),
    (
        "a style closer with attributes",
        "<svg><style>a{}</style x><style>@import url(http://127.0.0.1:9/x.css);</style x></svg>",
    ),
    (
        "a style closer with a prefix, where HTML does not end the style",
        "<svg><style>.a{}</x:style>@import url(http://127.0.0.1:9/x.css);</style></svg>",
    ),
    (
        "a base behind a prefix",
        r##"<svg><g x:base="http://127.0.0.1:9/"><use href="#a"/></g></svg>"##,
    ),
    (
        "an animation of a base",
        r#"<svg><set attributeName="xml:base" to="http://127.0.0.1:9/"/></svg>"#,
    ),
    (
        "a style with no closer",
        "<svg><rect/><style>@import url(http://127.0.0.1:9/x.css);",
    ),
    (
        "image-set with a string",
        r#"<svg><rect style="background:image-set('http://127.0.0.1:9/x.png' 1x)"/></svg>"#,
    ),
    (
        "a URL in a presentation attribute",
        r#"<svg><rect fill="url(http://127.0.0.1:9/a.svg#g)"/></svg>"#,
    ),
    (
        "an animation of href behind a prefix",
        r##"<svg><set attributeName="x:href" to="#b"/></svg>"##,
    ),
    (
        "an animation of href spelled with an entity",
        r##"<svg><set attributeName="&#104;ref" to="#b"/></svg>"##,
    ),
    (
        "an HTML image in the XHTML namespace",
        r#"<svg><h:img xmlns:h="http://www.w3.org/1999/xhtml" srcset="http://127.0.0.1:9/x.png"/></svg>"#,
    ),
    (
        "markup inside a value, which HTML reads out of a style",
        r#"<svg><rect x="</style><img src=x onerror=alert(1)>"/></svg>"#,
    ),
    (
        "a title, whose content HTML parses as HTML",
        r#"<svg><title><image srcset="http://127.0.0.1:9/x.png"/></title></svg>"#,
    ),
    (
        "an event handler behind a prefix",
        r#"<svg x:onload="alert(1)"/>"#,
    ),
    (
        "a NUL before a fragment in a style, which HTML reads as U+FFFD",
        "<svg><rect style=\"fill:url(\0#x)\"/></svg>",
    ),
    (
        "NULs before a fragment in style text",
        "<svg><style>rect{fill:url(\0\0#f)}</style><rect/></svg>",
    ),
    (
        "NULs before a fragment in an href",
        "<svg><image href=\"\0\0#f\"/></svg>",
    ),
    (
        "a space inside the scheme of a data URL",
        r#"<svg><image href="da ta:image/png;base64,AAAA"/></svg>"#,
    ),
    (
        "a tab inside the scheme of a data URL, which XML reads as a space",
        "<svg><image href=\"da\tta:image/png;base64,AAAA\"/></svg>",
    ),
    (
        "a control character inside the scheme of a data URL",
        "<svg><image href=\"d\u{1}ata:image/png;base64,AAAA\"/></svg>",
    ),
];

#[test]
fn hostile_input_that_gets_past_the_typescript_is_written_inert() {
    for (what, input) in HOSTILE {
        let typescript = sanitize_svg_as_typescript(input).expect("the TypeScript keeps a root");
        assert!(
            check_inert(&typescript).is_err(),
            "{what}: the TypeScript output is inert already: {typescript:?}"
        );
        let out = sanitize_svg(input).expect("an svg root");
        if let Err(problem) = check_inert(&out) {
            panic!("{what}: {problem}\n  output: {out:?}");
        }
        assert_eq!(sanitize_svg(&out).as_deref(), Some(out.as_str()), "{what}");
    }
}

#[test]
fn a_stray_lt_is_written_as_text() {
    assert_eq!(
        sanitize_svg(r#"<svg><<a>svg onload="alert(1)"></svg>"#).as_deref(),
        Some(r#"<svg>&lt;svg onload="alert(1)"></svg>"#)
    );
    assert_eq!(
        sanitize_svg("<<?x?>?xml-stylesheet?><svg/>").as_deref(),
        Some("&lt;?xml-stylesheet?><svg/>")
    );
}

#[test]
fn a_style_keeps_its_css_only_when_it_loads_nothing() {
    let kept = "<svg><style>.a{fill:url(#g)}</style></svg>";
    assert_eq!(sanitize_svg(kept).as_deref(), Some(kept));
    // Each piece between `;`, `{` and `}` stands alone: an unsafe one goes, the rest stays.
    for (css, kept) in [
        (
            ".st0{fill:#FF0000;}.st1{font-family:'MyriadPro-Regular';font-size:12px;}",
            ".st0{fill:#FF0000;}.st1{;font-size:12px;}",
        ),
        (".a{background:image-set(x 1x);fill:red}", ".a{;fill:red}"),
        (".a{fill:red}.b{fill:u\\72l(#g)}", ".a{fill:red}.b{}"),
    ] {
        assert_eq!(
            sanitize_svg(&format!("<svg><style>{css}</style><g/></svg>")).as_deref(),
            Some(format!("<svg><style>{kept}</style><g/></svg>").as_str()),
            "{css}"
        );
    }
    assert_eq!(
        sanitize_svg(r#"<svg style="fill:red;font-family:'Arial';stroke:blue"/>"#).as_deref(),
        Some(r#"<svg style="fill:red;;stroke:blue"/>"#)
    );
    // A closer by another name, a tag inside, or no closer: the opener goes and the CSS is
    // plain text.
    assert_eq!(
        sanitize_svg("<svg><style>.a{}</STYLE><g/></svg>").as_deref(),
        Some("<svg>.a{}</STYLE><g/></svg>")
    );
    assert_eq!(
        sanitize_svg("<svg><style>.a{}<g/></style></svg>").as_deref(),
        Some("<svg>.a{}<g/></style></svg>")
    );
    assert_eq!(
        sanitize_svg("<svg><g/><style>.a{}").as_deref(),
        Some("<svg><g/>.a{}")
    );
}

#[test]
fn a_name_the_typescript_reads_as_a_style_but_is_none_goes() {
    // Kept, `<style/>` or `<style:rect>` would make the TypeScript's style pass read the text
    // after it, joined where a tag went, as CSS: a second pass would drop the drawing.
    for input in [
        "<svg><style/>@im<b/>port<g/><style>a{}</style></svg>",
        "<svg><style:rect>@im<b/>port<g/><style>a{}</style></svg>",
    ] {
        let out = sanitize_svg(input).expect("an svg root");
        assert!(out.contains("<g/>"), "{out}");
        assert_eq!(sanitize_svg(&out).as_deref(), Some(out.as_str()), "{input}");
    }
}

const ICONS: &[&str] = &[
    // Figma
    r##"<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect width="4" height="4" fill="url(#paint0_linear)"/><defs><linearGradient id="paint0_linear" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse"><stop stop-color="#FF0000"/><stop offset="1" stop-color="#0000FF"/></linearGradient></defs></svg>"##,
    // Illustrator, after its prolog and comment go
    r#"<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 512 512" style="enable-background:new 0 0 512 512;" xml:space="preserve"><style type="text/css">.st0{fill:#FF0000;}</style><g><path class="st0" d="M0,0h512v512H0V0z"/></g></svg>"#,
    // An animated loader
    r#"<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"><animate attributeName="r" values="10;5;10" dur="1s" repeatCount="indefinite"/></circle><g><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></g></svg>"#,
    // Symbols, a fragment reference, an embedded raster, text
    r##"<svg xmlns:xlink="http://www.w3.org/1999/xlink"><symbol id="s"><path d="M0 0h1v1z"/></symbol><use xlink:href="#s" transform="translate(2 2) scale(2)"/><image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/><text x="0" y="10" font-family="Arial, sans-serif">A &amp; B</text><filter id="f"><feGaussianBlur stdDeviation="2"/></filter><g clip-path="url(#c)" filter="url(#f)"/></svg>"##,
    // Inkscape, with an embedded raster whose base64 it wraps
    "<svg xmlns:xlink=\"http://www.w3.org/1999/xlink\"><image width=\"1\" height=\"1\" xlink:href=\"data:image/png;base64,\niVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk\n+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\n\"/></svg>",
];

#[test]
fn icons_as_editors_export_them_keep_their_drawing() {
    for icon in ICONS {
        assert_eq!(sanitize_svg(icon).as_deref(), Some(*icon));
    }
    let inkscape = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" inkscape:version="1.0 (4035a4f, 2020-05-01)"><sodipodi:namedview id="base" pagecolor="#ffffff"/><g inkscape:label="Layer 1" id="layer1"><circle style="fill:#000000;stroke-width:0.26" cx="12" cy="12" r="10"/></g></svg>"##;
    assert_eq!(
        sanitize_svg(inkscape).as_deref(),
        Some(
            r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" inkscape:version="1.0 (4035a4f, 2020-05-01)"><g inkscape:label="Layer 1" id="layer1"><circle style="fill:#000000;stroke-width:0.26" cx="12" cy="12" r="10"/></g></svg>"##
        )
    );
}

/// Pieces of every construct the passes and the writer look for, hostile ones included, so
/// random input reaches each rule.
const PIECES: &[&str] = &[
    "<",
    "<<",
    ">",
    "/",
    "\"",
    "'",
    "=",
    " ",
    "\u{a0}",
    "#",
    ":",
    "&",
    "\\",
    "(",
    ")",
    "!",
    "?",
    "<a>",
    "</a>",
    "<a",
    "<svg",
    "<svg>",
    "</svg>",
    "svg",
    "<g>",
    "</g>",
    "<rect",
    "/>",
    "<!--",
    "-->",
    "<!DOCTYPE",
    "<!ENTITY",
    "<?",
    "?>",
    "<![CDATA[",
    "]]>",
    "<script",
    "</script",
    "<style",
    "<style>",
    "</style>",
    "</style x>",
    "style:",
    "<title>",
    "<h:img",
    "<image",
    "<set",
    "<animate",
    " attributeName=",
    "\"x:href\"",
    "href",
    " x:href=",
    " xlink:href=",
    " src=",
    " srcset=",
    " onload=",
    " style=",
    " fill=",
    " to=",
    "x:",
    "on",
    "url(",
    "url(#a)",
    "http://e/",
    "javascript:",
    "@import",
    "image-set(",
    "&#108;",
    "\\72",
    "xml:base",
    "data:image/png;base64,",
    "da ta:",
    "\0",
    "\t",
    "\u{1}",
    "x",
];

fn soup() -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(PIECES), 0..60).prop_map(|pieces| pieces.concat())
}

proptest! {
    #![proptest_config(proptest_config(1024))]

    #[test]
    fn any_soup_is_written_inert_and_stable(input in soup()) {
        if let Some(out) = sanitize_svg(&input) {
            if let Err(problem) = check_inert(&out) {
                prop_assert!(false, "{} in {:?}", problem, out);
            }
            prop_assert_eq!(sanitize_svg(&out), Some(out));
        }
    }
}
