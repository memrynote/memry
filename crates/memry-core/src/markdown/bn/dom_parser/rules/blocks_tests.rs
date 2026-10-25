use super::*;
use crate::markdown::bn::dom::parse_fragment_in_div;

fn element(html: &str, selector: &str) -> (Dom, NodeId) {
    let (dom, root) = parse_fragment_in_div(html);
    let el = dom
        .query_selector(root, &Selector::new(selector))
        .unwrap_or_else(|| panic!("{selector} in {html}"));
    (dom, el)
}

fn props(parsed: Option<Props>) -> Vec<(String, Any)> {
    parsed
        .expect("the rule applies")
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect()
}

fn get(parsed: &[(String, Any)], name: &str) -> Option<Any> {
    parsed
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.clone())
}

#[test]
fn default_props_prefer_data_attributes_over_styles() {
    let (dom, p) = element(
        r#"<p data-text-color="red" style="color: blue; background-color: #00f; text-align: center">x</p>"#,
        "p",
    );
    let parsed = props(paragraph(&dom, p));
    assert_eq!(get(&parsed, "textColor"), Some(Any::from("red")));
    assert_eq!(
        get(&parsed, "backgroundColor"),
        Some(Any::from("rgb(0, 0, 255)"))
    );
    assert_eq!(get(&parsed, "textAlignment"), Some(Any::from("center")));
    let (dom, p) = element(r#"<p style="text-align: start">x</p>"#, "p");
    assert_eq!(get(&props(paragraph(&dom, p)), "textAlignment"), None);
}

#[test]
fn paragraph_needs_text_and_the_p_tag() {
    let (dom, p) = element("<p> \u{a0} </p>", "p");
    assert!(paragraph(&dom, p).is_none());
    let (dom, div) = element("<div>x</div>", "div");
    assert!(paragraph(&dom, div).is_none());
}

#[test]
fn headings_and_toggle_headings() {
    let (dom, h) = element("<h3>x</h3>", "h3");
    assert_eq!(
        get(&props(heading(&dom, h)), "level"),
        Some(Any::Number(3.0))
    );
    let (dom, d) = element(
        r#"<details><summary><h2 data-text-color="red">t</h2></summary><p>b</p></details>"#,
        "details",
    );
    let parsed = props(heading(&dom, d));
    assert_eq!(get(&parsed, "level"), Some(Any::Number(2.0)));
    assert_eq!(get(&parsed, "isToggleable"), Some(Any::Bool(true)));
    assert_eq!(get(&parsed, "textColor"), Some(Any::from("red")));
    let (dom, d) = element("<details><summary>t</summary></details>", "details");
    assert!(heading(&dom, d).is_none());
    let (dom, p) = element("<p>x</p>", "p");
    assert!(heading(&dom, p).is_none());
}

#[test]
fn quote_and_divider() {
    let (dom, q) = element(
        r#"<blockquote style="color: red; text-align: right">x</blockquote>"#,
        "blockquote",
    );
    let parsed = props(quote(&dom, q));
    assert_eq!(parsed, vec![("textColor".to_owned(), Any::from("red"))]);
    let (dom, hr) = element("<hr>", "hr");
    assert_eq!(props(divider(&dom, hr)), vec![]);
}

#[test]
fn media_elements_and_figures() {
    let (dom, img) = element(r#"<img src="a.png" alt="alt" width="120">"#, "img");
    let parsed = props(media(&dom, img, Media::Image));
    assert_eq!(get(&parsed, "url"), Some(Any::from("a.png")));
    assert_eq!(get(&parsed, "name"), Some(Any::from("alt")));
    assert_eq!(get(&parsed, "previewWidth"), Some(Any::Number(120.0)));

    let (dom, img) = element(r#"<img alt="">"#, "img");
    assert_eq!(props(media(&dom, img, Media::Image)), vec![]);

    let (dom, video) = element(
        r#"<video src="v.mp4" width=" 30px" data-name="clip"></video>"#,
        "video",
    );
    let parsed = props(media(&dom, video, Media::Video));
    assert_eq!(get(&parsed, "previewWidth"), Some(Any::Number(30.0)));
    assert_eq!(get(&parsed, "name"), Some(Any::from("clip")));

    let (dom, fig) = element(
        r#"<figure><img src="a.png"><figcaption>cap</figcaption></figure>"#,
        "figure",
    );
    assert_eq!(
        get(&props(media(&dom, fig, Media::Image)), "caption"),
        Some(Any::from("cap"))
    );
    let (dom, img) = element(r#"<figure><img src="a.png"></figure>"#, "img");
    assert!(media(&dom, img, Media::Image).is_none());
    let (dom, fig) = element("<figure><figcaption>c</figcaption></figure>", "figure");
    assert!(media(&dom, fig, Media::Image).is_none());
    let (dom, audio) = element(r#"<audio src="a.mp3"></audio>"#, "audio");
    assert_eq!(
        props(media(&dom, audio, Media::Audio)),
        vec![("url".to_owned(), Any::from("a.mp3"))]
    );
}

#[test]
fn image_width_rides_in_the_alt_text() {
    let (dom, img) = element(r#"<img src="a.png" alt="photo|300">"#, "img");
    let parsed = props(image(&dom, img));
    assert_eq!(get(&parsed, "name"), Some(Any::from("photo")));
    assert_eq!(get(&parsed, "previewWidth"), Some(Any::Number(300.0)));
    let (dom, img) = element(r#"<img src="a.png" alt="photo|300" width="50">"#, "img");
    let parsed = props(image(&dom, img));
    assert_eq!(get(&parsed, "name"), Some(Any::from("photo")));
    assert_eq!(get(&parsed, "previewWidth"), Some(Any::Number(50.0)));
    assert_eq!(parse_inline_image_alt("a|0"), ("a|0".to_owned(), 0.0));
    assert_eq!(parse_inline_image_alt("a|b|7"), ("a|b".to_owned(), 7.0));
    assert_eq!(parse_inline_image_alt("a\n|7"), ("a\n|7".to_owned(), 0.0));
}

#[test]
fn code_and_diagram_fences() {
    let (dom, pre) = element(
        r#"<pre><code class="x language-rust">fn</code></pre>"#,
        "pre",
    );
    assert_eq!(
        props(code_block(&dom, pre)),
        vec![("language".to_owned(), Any::from("rust"))]
    );
    assert!(diagram(&dom, pre).is_none());
    let (dom, pre) = element("<pre><code>x</code></pre>", "pre");
    assert_eq!(
        props(code_block(&dom, pre)),
        vec![("language".to_owned(), Any::from(""))]
    );
    let (dom, pre) = element(
        r#"<pre><code data-language="mermaid">x</code></pre>"#,
        "pre",
    );
    assert_eq!(props(diagram(&dom, pre)), vec![]);
    let (dom, pre) = element("<pre><code>x</code>y<b></b></pre>", "pre");
    assert!(code_block(&dom, pre).is_none());
    let (dom, pre) = element("<pre>x</pre>", "pre");
    assert!(code_block(&dom, pre).is_none());
}

#[test]
fn list_items() {
    let (dom, li) = element("<ul><li>a</li></ul>", "li");
    assert!(bullet_list_item(&dom, li).is_some());
    assert!(numbered_list_item(&dom, li).is_none());
    assert!(check_list_item(&dom, li).is_none());
    let (dom, li) = element("<ol><li>a</li></ol>", "li");
    assert!(bullet_list_item(&dom, li).is_none());
    let (dom, li) = element(
        r#"<ul><li><input type="checkbox" checked>a</li></ul>"#,
        "li",
    );
    assert_eq!(
        get(&props(check_list_item(&dom, li)), "checked"),
        Some(Any::Bool(true))
    );
    let (dom, li) = element(r#"<ol start="3"><li>a</li><li>b</li></ol>"#, "li");
    assert_eq!(
        get(&props(numbered_list_item(&dom, li)), "start"),
        Some(Any::Number(3.0))
    );
    let (dom, li) = element(r#"<ol start="3"><li>a</li><li>b</li></ol>"#, "li + li");
    assert_eq!(get(&props(numbered_list_item(&dom, li)), "start"), None);
    let (dom, li) = element(r#"<ol start="abc"><li>a</li></ol>"#, "li");
    assert!(
        matches!(get(&props(numbered_list_item(&dom, li)), "start"), Some(Any::Number(n)) if n.is_nan())
    );
}

#[test]
fn inline_content_parsers() {
    let (dom, img) = element(
        r#"<table><tr><td><img src=" a.png " alt="x|40"></td></tr></table>"#,
        "img",
    );
    let parsed = props(inline_image(&dom, img));
    assert_eq!(get(&parsed, "src"), Some(Any::from("a.png")));
    assert_eq!(get(&parsed, "alt"), Some(Any::from("x")));
    assert_eq!(get(&parsed, "width"), Some(Any::Number(40.0)));
    let (dom, img) = element(r#"<img src="a.png">"#, "img");
    assert!(inline_image(&dom, img).is_none());

    let (dom, input) = element(
        r#"<table><tr><td><input type="CheckBox" checked></td></tr></table>"#,
        "input",
    );
    assert_eq!(
        props(inline_checkbox(&dom, input)),
        vec![("checked".to_owned(), Any::Bool(true))]
    );

    let (dom, span) = element(
        r#"<span data-hash-tag=" t " data-hash-tag-color="red"></span>"#,
        "span",
    );
    let parsed = props(hash_tag(&dom, span));
    assert_eq!(get(&parsed, "tag"), Some(Any::from("t")));
    assert_eq!(get(&parsed, "color"), Some(Any::from("red")));
    assert_eq!(get(&parsed, "icon"), Some(Any::from("")));
    let (dom, span) = element(r#"<span data-hash-tag="  "></span>"#, "span");
    assert!(hash_tag(&dom, span).is_none());

    let (dom, span) = element(
        r#"<span data-link-mention data-url="https://a.com"></span>"#,
        "span",
    );
    assert_eq!(
        get(&props(link_mention(&dom, span)), "url"),
        Some(Any::from("https://a.com"))
    );
    let (dom, span) = element("<span data-link-mention></span>", "span");
    assert!(link_mention(&dom, span).is_none());

    let (dom, span) = element(
        r#"<span data-date-mention data-anchor-id="a" data-date-iso="2024-01-01" data-has-time="true"></span>"#,
        "span",
    );
    let parsed = props(date_mention(&dom, span));
    assert_eq!(get(&parsed, "hasTime"), Some(Any::Bool(true)));
    assert_eq!(get(&parsed, "dateFormat"), Some(Any::from("relative")));
    assert_eq!(get(&parsed, "timeFormat"), Some(Any::from("system")));
}

#[test]
fn style_marks_read_spans_only() {
    let (dom, span) = element(r#"<span style="color: red">x</span>"#, "span");
    assert_eq!(
        props(span_style(&dom, span, "color")),
        vec![("stringValue".to_owned(), Any::from("red"))]
    );
    assert!(span_style(&dom, span, "background-color").is_none());
    let (dom, b) = element(r#"<b style="color: red">x</b>"#, "b");
    assert!(span_style(&dom, b, "color").is_none());
}
