//! `element.src` as jsdom answers it: the `src` attribute resolved against the
//! document's base URL, which is `about:blank`. Nothing relative resolves
//! against that base (it cannot be a base), so a relative value comes back as
//! written, and an absolute URL comes back in the WHATWG URL serialisation,
//! which is what the `url` crate implements (jsdom uses whatwg-url).

use url::Url;

pub fn reflect_url(value: &str) -> String {
    let base = Url::parse("about:blank").expect("static URL");
    match base.join(value) {
        Ok(url) => url.to_string(),
        Err(_) => value.to_owned(),
    }
}

/// `element.src || undefined`.
pub fn src_property(raw: Option<&str>) -> Option<String> {
    let url = raw.map_or_else(String::new, reflect_url);
    (!url.is_empty()).then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_values_come_back_as_written() {
        assert_eq!(reflect_url("a.png"), "a.png");
        assert_eq!(reflect_url(" ./a b.png "), " ./a b.png ");
        assert_eq!(src_property(None), None);
        assert_eq!(src_property(Some("")), None);
    }

    #[test]
    fn absolute_values_are_serialised() {
        assert_eq!(reflect_url("HTTPS://Example.COM"), "https://example.com/");
        assert_eq!(
            reflect_url("http://a.com:80/x y?q=1 2#f"),
            "http://a.com/x%20y?q=1%202#f"
        );
        assert_eq!(
            reflect_url("data:image/png;base64,AAA="),
            "data:image/png;base64,AAA="
        );
        assert_eq!(reflect_url("#top"), "about:blank#top");
    }
}
