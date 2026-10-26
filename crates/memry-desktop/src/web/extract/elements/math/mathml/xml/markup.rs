//! Tag, comment, doctype and instruction scanning of the `sax.js` port.

use super::text::*;
use super::*;

impl Parser {
    pub(super) fn end_tag(
        &mut self,
        stack: &mut Vec<ParseEntry>,
        tag_start: usize,
    ) -> Result<i64, Stop> {
        let mut end = index_of(&self.s, &['>'], tag_start + 3);
        let raw = substring(&self.s, tag_start as i64 + 2, end);
        let mut tag_name: Vec<char> = {
            let trimmed = raw.len()
                - raw
                    .iter()
                    .rev()
                    .take_while(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))
                    .count();
            raw[..trimmed].to_vec()
        };
        let config = stack.pop().ok_or(Stop::Soft)?;
        if end < 0 {
            tag_name = cut_at_space_or_lt(substring(&self.s, tag_start as i64 + 2, i64::MAX));
            end = (tag_start + 1 + tag_name.len()) as i64;
        } else if tag_name
            .windows(2)
            .any(|w| is_js_whitespace(w[0]) && w[1] == '<')
        {
            tag_name = cut_at_space_or_lt(&tag_name);
            end = (tag_start + 1 + tag_name.len()) as i64;
        }
        let tag_name = collect(&tag_name);
        let end_match = config.tag_name.as_deref() == Some(tag_name.as_str());
        let ignore_case = end_match
            || config
                .tag_name
                .as_deref()
                .is_some_and(|t| !t.is_empty() && to_lower(t) == to_lower(&tag_name));
        if ignore_case {
            self.end_element()?;
            if !end_match {
                return Err(Stop::Fatal);
            }
        } else {
            stack.push(config);
        }
        Ok(end + 1)
    }

    pub(super) fn parse_instruction(&mut self, start: usize) -> i64 {
        let end = index_of(&self.s, &['?', '>'], start);
        if end == 0 {
            return -1;
        }
        if substring(&self.s, start as i64, end).starts_with(&['<', '?']) {
            self.append(XNode::ProcessingInstruction);
            end + 2
        } else {
            -1
        }
    }

    pub(super) fn parse_dcc(&mut self, start: usize) -> Result<i64, Stop> {
        if self.ch(start + 2) == Some('-') {
            if self.ch(start + 3) != Some('-') {
                return Ok(-1);
            }
            let end = index_of(&self.s, &['-', '-', '>'], start + 4);
            if end > start as i64 {
                self.append(XNode::Other);
                return Ok(end + 3);
            }
            // `Unclosed comment` is logged.
            return Ok(-1);
        }
        if substring(&self.s, start as i64 + 3, start as i64 + 9) == chars("CDATA[") {
            let end = index_of(&self.s, &[']', ']', '>'], start + 9);
            let length = end - start as i64 - 9;
            if length > 0 {
                self.cdata = true;
                let text = collect(substring(&self.s, start as i64 + 9, end));
                self.characters(text)?;
                self.cdata = false;
            }
            return Ok(end + 3);
        }
        let tokens = self.doctype_tokens(start).ok_or(Stop::Soft)?;
        let is_doctype = tokens
            .first()
            .is_some_and(|t| t.text.to_ascii_lowercase().contains("!doctype"));
        if tokens.len() > 1 && is_doctype {
            // `Document.appendChild` accepts one doctype, before any element, and only at the top.
            if !self.open.is_empty() || self.root_started || self.has_doctype {
                return Err(Stop::Soft);
            }
            self.has_doctype = true;
            let last = tokens.last().expect("non-empty");
            return Ok((last.index + last.text.chars().count()) as i64);
        }
        Ok(-1)
    }

    /// `split(source, start)`: the tokens of a `<!...>` declaration up to its closing `>`, or
    /// `None` where JS returns `undefined` (no closing token).
    pub(super) fn doctype_tokens(&self, start: usize) -> Option<Vec<Token>> {
        static RE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(&format!(
                r#"'[^']+'|"[^"]+"|[^{WS_BODY}<>/=]+=?|(/?[{WS_BODY}]*>|<)"#
            ))
            .expect("doctype token pattern")
        });
        let rest = collect(&self.s[start.min(self.s.len())..]);
        let mut found = RE.captures_iter(&rest);
        found.next();
        let mut tokens = Vec::new();
        for caps in found {
            let whole = caps.get(0).expect("match");
            tokens.push(Token {
                text: whole.as_str().to_string(),
                index: start + rest[..whole.start()].chars().count(),
            });
            if caps.get(1).is_some() {
                return Some(tokens);
            }
        }
        None
    }

    pub(super) fn start_tag(
        &mut self,
        stack: &mut Vec<ParseEntry>,
        close_map: &mut HashMap<String, i64>,
        tag_start: usize,
    ) -> Result<i64, Stop> {
        let mut el = ElementAttributes::default();
        let current_ns = stack.last().ok_or(Stop::Soft)?.ns.clone();
        let end = self.parse_element_start_part(tag_start, &mut el)?;
        let Some(tag_name) = el.tag_name.clone() else {
            // `appendElement` reads `tagName.indexOf` of `undefined`.
            return Err(Stop::Soft);
        };
        if !el.closed && fix_self_closed(&self.s, end, &tag_name, close_map) {
            el.closed = true;
        }
        // appendElement: namespace declarations, then the element's namespace.
        let mut ns = current_ns;
        let mut declared = false;
        for (q_name, value) in el.attrs.iter().rev() {
            let declaration = match q_name.find(':') {
                Some(i) if i > 0 => (&q_name[..i] == "xmlns").then(|| q_name[i + 1..].to_string()),
                _ => (q_name == "xmlns").then(String::new),
            };
            if let Some(prefix) = declaration {
                if !declared {
                    declared = true;
                    ns = Rc::new((*ns).clone());
                }
                Rc::make_mut(&mut ns).insert(prefix, value.clone());
            }
        }
        let prefix = match tag_name.find(':') {
            Some(i) if i > 0 => &tag_name[..i],
            _ => "",
        };
        let uri = ns.get(prefix).cloned();
        if self.open.is_empty() {
            if self.root_started {
                return Err(Stop::Soft);
            }
            self.root_started = true;
        }
        self.open.push(OpenNode {
            name: tag_name.clone(),
            attrs: el.attrs,
            children: Vec::new(),
        });
        if el.closed {
            self.end_element()?;
        } else {
            stack.push(ParseEntry {
                tag_name: Some(tag_name.clone()),
                ns,
            });
        }
        if uri.as_deref() == Some(HTML_NS) && !el.closed {
            self.parse_html_special_content(end, &tag_name)
        } else {
            Ok(end as i64 + 1)
        }
    }

    pub(super) fn parse_html_special_content(
        &mut self,
        el_start_end: usize,
        tag_name: &str,
    ) -> Result<i64, Stop> {
        let lower = tag_name.to_ascii_lowercase();
        if lower == "script" || lower == "textarea" {
            let closing = chars(&format!("</{tag_name}>"));
            let el_end_start = index_of(&self.s, &closing, el_start_end);
            let text = collect(substring(&self.s, el_start_end as i64 + 1, el_end_start));
            if text.contains(['&', '<']) {
                let text = if lower == "script" {
                    text
                } else {
                    replace_entities(&text)
                };
                self.characters(text)?;
                return Ok(el_end_start);
            }
        }
        Ok(el_start_end as i64 + 1)
    }

    pub(super) fn parse_element_start_part(
        &mut self,
        tag_start: usize,
        el: &mut ElementAttributes,
    ) -> Result<usize, Stop> {
        let mut names: HashSet<String> = HashSet::new();
        let mut attr_name = String::new();
        let mut start = tag_start + 1;
        let mut p = start;
        let mut s = S::Tag;
        macro_rules! add_attribute {
            ($name:expr, $value:expr) => {{
                let name: String = $name;
                if names.contains(&name) {
                    return Err(Stop::Fatal);
                }
                if !tag_name_ok(&name) {
                    return Err(Stop::Soft);
                }
                names.insert(name.clone());
                let value = replace_entities(&$value.replace(['\t', '\n', '\r'], " "));
                el.attrs.push((name, value));
            }};
        }
        macro_rules! set_tag_name {
            ($name:expr) => {{
                let name: String = $name;
                if !tag_name_ok(&name) {
                    return Err(Stop::Soft);
                }
                el.tag_name = Some(name);
            }};
        }
        loop {
            let c = self.ch(p);
            if s == S::Tag && c == Some('<') {
                return Err(Stop::Soft);
            }
            match c {
                Some('=') => match s {
                    S::Attr => {
                        attr_name = collect(&self.s[start..p]);
                        s = S::Eq;
                    }
                    S::AttrSpace => s = S::Eq,
                    _ => return Err(Stop::Soft),
                },
                Some(q @ ('\'' | '"')) => match s {
                    S::Eq | S::Attr => {
                        if s == S::Attr {
                            attr_name = collect(&self.s[start..p]);
                        }
                        start = p + 1;
                        let found = index_of(&self.s, &[q], start);
                        if found > 0 {
                            p = found as usize;
                            let value = collect(&self.s[start..p]);
                            add_attribute!(attr_name.clone(), value);
                            s = S::AttrEnd;
                        } else {
                            return Err(Stop::Soft);
                        }
                    }
                    S::AttrNoquotValue => {
                        let value = collect(&self.s[start..p]);
                        add_attribute!(attr_name.clone(), value);
                        start = p + 1;
                        s = S::AttrEnd;
                    }
                    _ => return Err(Stop::Soft),
                },
                Some('/') => match s {
                    S::Tag => {
                        set_tag_name!(collect(&self.s[start..p]));
                        s = S::TagClose;
                        el.closed = true;
                    }
                    S::AttrEnd | S::TagSpace | S::TagClose => {
                        s = S::TagClose;
                        el.closed = true;
                    }
                    S::AttrNoquotValue | S::Attr => {}
                    S::AttrSpace => el.closed = true,
                    S::Eq => return Err(Stop::Soft),
                },
                None => {
                    // `unexpected end of input` is logged.
                    if s == S::Tag {
                        set_tag_name!(collect(&self.s[start..p]));
                    }
                    return Ok(p);
                }
                Some('>') => {
                    match s {
                        S::Tag => set_tag_name!(collect(&self.s[start..p])),
                        S::AttrEnd | S::TagSpace | S::TagClose => {}
                        S::AttrNoquotValue | S::Attr | S::AttrSpace => {
                            let mut value = collect(&self.s[start..p]);
                            if s != S::AttrSpace && value.ends_with('/') {
                                el.closed = true;
                                value.pop();
                            }
                            if s == S::AttrSpace {
                                value = attr_name.clone();
                            }
                            if s == S::AttrNoquotValue {
                                add_attribute!(attr_name.clone(), value);
                            } else {
                                add_attribute!(value.clone(), value);
                            }
                        }
                        S::Eq => return Err(Stop::Soft),
                    }
                    return Ok(p);
                }
                Some(c) => {
                    let c = if c == '\u{80}' { ' ' } else { c };
                    if c <= ' ' {
                        match s {
                            S::Tag => {
                                set_tag_name!(collect(&self.s[start..p]));
                                s = S::TagSpace;
                            }
                            S::Attr => {
                                attr_name = collect(&self.s[start..p]);
                                s = S::AttrSpace;
                            }
                            S::AttrNoquotValue => {
                                let value = collect(&self.s[start..p]);
                                add_attribute!(attr_name.clone(), value);
                                s = S::TagSpace;
                            }
                            S::AttrEnd => s = S::TagSpace,
                            _ => {}
                        }
                    } else {
                        match s {
                            S::AttrSpace => {
                                add_attribute!(attr_name.clone(), attr_name.clone());
                                start = p;
                                s = S::Attr;
                            }
                            S::AttrEnd | S::TagSpace => {
                                s = S::Attr;
                                start = p;
                            }
                            S::Eq => {
                                s = S::AttrNoquotValue;
                                start = p;
                            }
                            S::TagClose => return Err(Stop::Soft),
                            S::Tag | S::Attr | S::AttrNoquotValue => {}
                        }
                    }
                }
            }
            p += 1;
        }
    }
}
