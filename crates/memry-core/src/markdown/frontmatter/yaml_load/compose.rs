//! `composeNode`, node properties (tags, anchors, aliases), documents and
//! directives of `loader.js`.

use std::collections::HashMap;

use super::{
    CONTEXT_BLOCK_IN, CONTEXT_BLOCK_OUT, CONTEXT_FLOW_IN, CONTEXT_FLOW_OUT, Res, State, is_eol,
    is_flow_indicator, is_white_space, is_ws_or_eol,
};
use crate::markdown::frontmatter::scalar::{IMPLICIT, Kind, Ty};
use crate::markdown::frontmatter::value::YamlValue;

impl State {
    fn read_tag_property(&mut self) -> Res<bool> {
        let mut ch = self.cur();
        if ch != 0x21 {
            return Ok(false);
        }
        if self.tag.is_some() {
            return self.error("duplication of a tag property");
        }
        ch = self.advance();
        let mut is_verbatim = false;
        let mut is_named = false;
        let mut tag_handle = String::new();
        if ch == 0x3C {
            is_verbatim = true;
            ch = self.advance();
        } else if ch == 0x21 {
            is_named = true;
            tag_handle = "!!".to_owned();
            ch = self.advance();
        } else {
            tag_handle = "!".to_owned();
        }
        let mut start = self.position;
        let tag_name;
        if is_verbatim {
            loop {
                ch = self.advance();
                if ch == 0 || ch == 0x3E {
                    break;
                }
            }
            if self.position < self.length {
                tag_name = self.slice(start, self.position);
                self.advance();
            } else {
                return self.error("unexpected end of the stream within a verbatim tag");
            }
        } else {
            while ch != 0 && !is_ws_or_eol(ch) {
                if ch == 0x21 {
                    if !is_named {
                        tag_handle = self.slice(start - 1, self.position + 1);
                        if !tag_handle_ok(&tag_handle) {
                            return self.error("named tag handle cannot contain such characters");
                        }
                        is_named = true;
                        start = self.position + 1;
                    } else {
                        return self.error("tag suffix cannot contain exclamation marks");
                    }
                }
                ch = self.advance();
            }
            tag_name = self.slice(start, self.position);
            if tag_name
                .chars()
                .any(|c| matches!(c, ',' | '[' | ']' | '{' | '}'))
            {
                return self.error("tag suffix cannot contain flow indicator characters");
            }
        }
        if !tag_name.is_empty() && !tag_uri_ok(&tag_name) {
            return self.error("tag name cannot contain such characters");
        }
        if is_verbatim {
            self.tag = Some(tag_name);
        } else if let Some(prefix) = self.tag_map.get(&tag_handle) {
            self.tag = Some(format!("{prefix}{tag_name}"));
        } else if tag_handle == "!" {
            self.tag = Some(format!("!{tag_name}"));
        } else if tag_handle == "!!" {
            self.tag = Some(format!("tag:yaml.org,2002:{tag_name}"));
        } else {
            return self.error("undeclared tag handle");
        }
        Ok(true)
    }

    fn read_name(&mut self, what: &str) -> Res<String> {
        let mut ch = self.advance();
        let start = self.position;
        while ch != 0 && !is_ws_or_eol(ch) && !is_flow_indicator(ch) {
            ch = self.advance();
        }
        if self.position == start {
            return self.error(&format!(
                "name of an {what} must contain at least one character"
            ));
        }
        Ok(self.slice(start, self.position))
    }

    fn read_anchor_property(&mut self) -> Res<bool> {
        if self.cur() != 0x26 {
            return Ok(false);
        }
        if self.anchor.is_some() {
            return self.error("duplication of an anchor property");
        }
        self.anchor = Some(self.read_name("anchor node")?);
        Ok(true)
    }

    fn read_alias(&mut self) -> Res<bool> {
        if self.cur() != 0x2A {
            return Ok(false);
        }
        let alias = self.read_name("alias node")?;
        match self.anchor_map.get(&alias) {
            Some(value) => self.result = value.clone(),
            None => return self.error("unidentified alias"),
        }
        self.skip_separation_space(true)?;
        Ok(true)
    }

    pub fn compose_node(
        &mut self,
        parent_indent: i64,
        node_context: u8,
        allow_to_seek: bool,
        allow_compact: bool,
    ) -> Res<bool> {
        let mut indent_status = 1i8;
        let mut at_new_line = false;
        let mut has_content = false;
        self.tag = None;
        self.anchor = None;
        self.kind = None;
        self.result = YamlValue::Null;

        let allow_block_styles =
            node_context == CONTEXT_BLOCK_OUT || node_context == CONTEXT_BLOCK_IN;
        let allow_block_scalars = allow_block_styles;
        let mut allow_block_collections = allow_block_styles;

        let status = |indent: i64| match indent.cmp(&parent_indent) {
            std::cmp::Ordering::Greater => 1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Less => -1,
        };
        if allow_to_seek && self.skip_separation_space(true)? > 0 {
            at_new_line = true;
            indent_status = status(self.line_indent);
        }
        if indent_status == 1 {
            while self.read_tag_property()? || self.read_anchor_property()? {
                if self.skip_separation_space(true)? > 0 {
                    at_new_line = true;
                    allow_block_collections = allow_block_styles;
                    indent_status = status(self.line_indent);
                } else {
                    allow_block_collections = false;
                }
            }
        }
        if allow_block_collections {
            allow_block_collections = at_new_line || allow_compact;
        }
        if indent_status == 1 || node_context == CONTEXT_BLOCK_OUT {
            let flow_indent = if node_context == CONTEXT_FLOW_IN || node_context == CONTEXT_FLOW_OUT
            {
                parent_indent
            } else {
                parent_indent + 1
            };
            let block_indent = (self.position - self.line_start) as i64;
            if indent_status == 1 {
                if (allow_block_collections
                    && (self.read_block_sequence(block_indent)?
                        || self.read_block_mapping(block_indent, flow_indent)?))
                    || self.read_flow_collection(flow_indent)?
                {
                    has_content = true;
                } else {
                    if (allow_block_scalars && self.read_block_scalar(flow_indent)?)
                        || self.read_single_quoted_scalar(flow_indent)?
                        || self.read_double_quoted_scalar(flow_indent)?
                    {
                        has_content = true;
                    } else if self.read_alias()? {
                        has_content = true;
                        if self.tag.is_some() || self.anchor.is_some() {
                            return self.error("alias node should not have any properties");
                        }
                    } else if self
                        .read_plain_scalar(flow_indent, node_context == CONTEXT_FLOW_IN)?
                    {
                        has_content = true;
                        if self.tag.is_none() {
                            self.tag = Some("?".to_owned());
                        }
                    }
                    if let Some(anchor) = &self.anchor {
                        self.anchor_map.insert(anchor.clone(), self.result.clone());
                    }
                }
            } else if indent_status == 0 {
                has_content = allow_block_collections && self.read_block_sequence(block_indent)?;
            }
        }
        self.apply_tag()?;
        Ok(self.tag.is_some() || self.anchor.is_some() || has_content)
    }

    /// The tail of `composeNode`: resolve the implicit or explicit tag.
    fn apply_tag(&mut self) -> Res<()> {
        let Some(tag) = self.tag.clone() else {
            return Ok(());
        };
        if tag == "!" {
            return Ok(());
        }
        if tag == "?" {
            if self.result != YamlValue::Null && self.kind != Some(Kind::Scalar) {
                return self.error("unacceptable node kind for !<?> tag");
            }
            for ty in IMPLICIT {
                if ty.resolve(&self.result) {
                    self.result =
                        ty.construct(std::mem::replace(&mut self.result, YamlValue::Null));
                    self.tag = Some(ty.tag().to_owned());
                    if let Some(anchor) = &self.anchor {
                        self.anchor_map.insert(anchor.clone(), self.result.clone());
                    }
                    break;
                }
            }
            return Ok(());
        }
        // `typeMap[kind || 'fallback']`: a typed node only finds types of its own kind.
        let found = Ty::from_tag(&tag).filter(|ty| self.kind.is_none_or(|kind| ty.kind() == kind));
        let Some(ty) = found else {
            return self.error("unknown tag");
        };
        if self.result != YamlValue::Null && Some(ty.kind()) != self.kind {
            return self.error("unacceptable node kind for the tag");
        }
        if !ty.resolve(&self.result) {
            return self.error("cannot resolve a node with the explicit tag");
        }
        self.result = ty.construct(std::mem::replace(&mut self.result, YamlValue::Null));
        if let Some(anchor) = &self.anchor {
            self.anchor_map.insert(anchor.clone(), self.result.clone());
        }
        Ok(())
    }

    pub(super) fn read_document(&mut self) -> Res<()> {
        self.version = None;
        self.tag_map = HashMap::new();
        self.anchor_map = HashMap::new();
        let mut has_directives = false;

        let mut ch;
        while self.cur() != 0 {
            self.skip_separation_space(true)?;
            ch = self.cur();
            if self.line_indent > 0 || ch != 0x25 {
                break;
            }
            has_directives = true;
            ch = self.advance();
            let mut start = self.position;
            while ch != 0 && !is_ws_or_eol(ch) {
                ch = self.advance();
            }
            let name = self.slice(start, self.position);
            let mut args: Vec<String> = Vec::new();
            if name.is_empty() {
                return self.error("directive name must not be less than one character in length");
            }
            while ch != 0 {
                while is_white_space(ch) {
                    ch = self.advance();
                }
                if ch == 0x23 {
                    loop {
                        ch = self.advance();
                        if ch == 0 || is_eol(ch) {
                            break;
                        }
                    }
                    break;
                }
                if is_eol(ch) {
                    break;
                }
                start = self.position;
                while ch != 0 && !is_ws_or_eol(ch) {
                    ch = self.advance();
                }
                args.push(self.slice(start, self.position));
            }
            if ch != 0 {
                self.read_line_break()?;
            }
            match name.as_str() {
                "YAML" => self.directive_yaml(&args)?,
                "TAG" => self.directive_tag(&args)?,
                _ => {}
            }
        }
        self.skip_separation_space(true)?;
        if self.line_indent == 0
            && self.cur() == 0x2D
            && self.at(self.position + 1) == 0x2D
            && self.at(self.position + 2) == 0x2D
        {
            self.position += 3;
            self.skip_separation_space(true)?;
        } else if has_directives {
            return self.error("directives end mark is expected");
        }
        self.compose_node(self.line_indent - 1, CONTEXT_BLOCK_OUT, false, true)?;
        self.skip_separation_space(true)?;
        self.documents.push(self.result.clone());

        if self.position == self.line_start && self.test_document_separator() {
            if self.cur() == 0x2E {
                self.position += 3;
                self.skip_separation_space(true)?;
            }
            return Ok(());
        }
        if self.position + 1 < self.length {
            return self.error("end of the stream or a document separator is expected");
        }
        Ok(())
    }

    fn directive_yaml(&mut self, args: &[String]) -> Res<()> {
        if self.version.is_some() {
            return self.error("duplication of %YAML directive");
        }
        if args.len() != 1 {
            return self.error("YAML directive accepts exactly one argument");
        }
        let Some((major, minor)) = args[0].split_once('.') else {
            return self.error("ill-formed argument of the YAML directive");
        };
        let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
        if !digits(major) || !digits(minor) {
            return self.error("ill-formed argument of the YAML directive");
        }
        if major.parse::<u64>().ok() != Some(1) {
            return self.error("unacceptable YAML version of the document");
        }
        self.version = Some(args[0].clone());
        Ok(())
    }

    fn directive_tag(&mut self, args: &[String]) -> Res<()> {
        if args.len() != 2 {
            return self.error("TAG directive accepts exactly two arguments");
        }
        let (handle, prefix) = (&args[0], &args[1]);
        if !tag_handle_ok(handle) {
            return self.error("ill-formed tag handle (first argument) of the TAG directive");
        }
        if self.tag_map.contains_key(handle) {
            return self.error("there is a previously declared suffix for the tag handle");
        }
        if !tag_uri_ok(prefix) {
            return self.error("ill-formed tag prefix (second argument) of the TAG directive");
        }
        self.tag_map.insert(handle.clone(), prefix.clone());
        Ok(())
    }
}

/// `PATTERN_TAG_HANDLE`: `^(?:!|!!|![a-z\-]+!)$`, case-insensitive.
fn tag_handle_ok(handle: &str) -> bool {
    if handle == "!" || handle == "!!" {
        return true;
    }
    handle.len() >= 3
        && handle.starts_with('!')
        && handle.ends_with('!')
        && handle[1..handle.len() - 1]
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == '-')
}

/// `PATTERN_TAG_URI`.
fn tag_uri_ok(uri: &str) -> bool {
    let mut chars = uri.chars().peekable();
    match chars.next() {
        Some('!') => {}
        Some(c) if !matches!(c, ',' | '[' | ']' | '{' | '}') => {}
        _ => return false,
    }
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex = |c: Option<char>| c.is_some_and(|c| c.is_ascii_hexdigit());
            if !(hex(chars.next()) && hex(chars.next())) {
                return false;
            }
        } else if !(c.is_ascii_alphanumeric() || "-#;/?:@&=+$,_.!~*'()[]".contains(c)) {
            return false;
        }
    }
    true
}
