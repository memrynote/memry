//! Text insertion and style reading of `ParseContext`.

use super::util::{attrs_to_any, collapse, split_lines};
use super::*;

impl ParseContext<'_> {
    /// `addTextNode` for a text value; `prev_is_br` is whether the DOM text
    /// node follows a `<br>`.
    pub(super) fn add_text(
        &mut self,
        marks: &[Mark],
        value: &str,
        prev_is_br: bool,
    ) -> Result<(), ParseError> {
        let top = self.top();
        let preserve_full = top.options & OPT_PRESERVE_WS_FULL != 0;
        let preserve =
            preserve_full || self.local_preserve_ws || top.options & OPT_PRESERVE_WS != 0;
        let inline_context = self.schema.node_ty(top.ty).inline_content;
        let mut value = value.to_owned();
        if !(preserve_full || inline_context || value.chars().any(|c| !is_pm_ws(c))) {
            return Ok(());
        }
        if !preserve {
            value = collapse(&value);
            if value.starts_with(is_pm_ws) && self.open == self.nodes.len() - 1 {
                let before = self.top().content.last();
                if before.is_none()
                    || prev_is_br
                    || before
                        .is_some_and(|b| b.text.as_deref().is_some_and(|t| t.ends_with(is_pm_ws)))
                {
                    value.remove(0);
                }
            }
        } else if preserve_full {
            value = value.replace("\r\n", "\n").replace('\r', "\n");
        } else if let Some(br) = self.linebreak_replacement()
            && value.contains(['\r', '\n'])
            && {
                let probe = self.create_plain(br)?;
                let depth = self.open;
                self.context_find_wrapping(depth, &probe).is_some()
            }
        {
            let br_node = self.create_plain(br)?;
            for (i, line) in split_lines(&value).iter().enumerate() {
                if i > 0 {
                    self.insert_node(br_node.clone(), marks, true)?;
                }
                if !line.is_empty() {
                    let text = self.schema.text(line, Vec::new())?;
                    self.insert_node(text, marks, line.chars().all(is_js_whitespace))?;
                }
            }
            value.clear();
        } else {
            value = split_lines(&value).join(" ");
        }
        if !value.is_empty() {
            let blank = value.chars().all(is_js_whitespace);
            let text = self.schema.text(&value, Vec::new())?;
            self.insert_node(text, marks, blank)?;
        }
        Ok(())
    }

    pub(super) fn read_styles(
        &mut self,
        dom: &Dom,
        id: NodeId,
        marks: &[Mark],
    ) -> Result<Option<Vec<Mark>>, ParseError> {
        let style = dom.style(id);
        let mut marks = marks.to_vec();
        if style.is_empty() {
            return Ok(Some(marks));
        }
        let parser = self.parser;
        for name in &parser.matched_styles {
            let value = style.get(name);
            if value.is_empty() {
                continue;
            }
            let mut after = None;
            while let Some((index, attrs)) = parser.match_style(name, value, after) {
                let rule = &parser.styles[index];
                match &rule.target {
                    StyleTarget::ClearMark(ty) => marks.retain(|m| m.ty != *ty),
                    StyleTarget::Mark(ty) => {
                        let given = attrs_to_any(attrs.as_ref());
                        let mark = self.schema.create_mark(*ty, &given)?;
                        marks.push(mark);
                    }
                }
                if rule.consuming {
                    break;
                }
                after = Some(index);
            }
        }
        Ok(Some(marks))
    }
}
