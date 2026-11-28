//! Every string a seeded block carries, and the restore that undoes the masks
//! in each.
//!
//! A mask hides a construct behind a placeholder while the text is parsed, and
//! desktop swaps it back in every string of the blocks it builds: a run's text,
//! a link's address, a block's props (`parse-markdown.ts` `repairBlocks`,
//! `note-markdown.ts` `withMaskedBytes`). A restore that reached only the text
//! left the placeholder in a code block's language, a math block's source or
//! an image's address, so [`restore_masks`] walks every string.

use super::code_spans::restore_code_whitespace;
use super::comment_nodes::decode;
use super::mentions;
use super::toggles::details_lt_token;
use super::{SeedBlock, SeedInline, SeedKind, SeedMarks};

type Visit<'f> = &'f mut dyn FnMut(&mut String);

/// Every placeholder left in a string of `blocks` turned back into the bytes it
/// stands for: a code span's whitespace, a `((mention:…))` or `((date:…))`
/// token, a comment's source, a details tag's `<`, in the reverse of the order
/// the masks ran in (a hidden tag was put back in its chunk, first of all).
/// Each placeholder starts with `MEMRY`, so a string without one is passed
/// over.
pub(super) fn restore_masks(blocks: &mut [SeedBlock]) {
    each_string(blocks, true, &mut |value| {
        if value.contains("MEMRY") {
            let restored = decode(&mentions::restore(&restore_code_whitespace(value)));
            *value = restored.replace(details_lt_token(), "<");
        }
    });
}

/// Calls `visit` on every string in `blocks` and their children: block props,
/// the address of a link, the strings of an inline node, and the text of a run
/// when `text` is set.
pub(super) fn each_string(blocks: &mut [SeedBlock], text: bool, visit: Visit) {
    for block in blocks {
        match &mut block.kind {
            SeedKind::CodeBlock { language } => visit(language),
            SeedKind::Math { latex } => visit(latex),
            SeedKind::Callout { kind, fold } => {
                visit(kind);
                visit(fold);
            }
            SeedKind::Image { url, name, .. } | SeedKind::Video { url, name } => {
                visit(url);
                visit(name);
            }
            SeedKind::YoutubeEmbed {
                video_id,
                video_url,
                alt,
            } => {
                visit(video_id);
                visit(video_url);
                visit(alt);
            }
            SeedKind::Bookmark { url, domain } => {
                visit(url);
                visit(domain);
            }
            SeedKind::Whiteboard { canvas_id } => visit(canvas_id),
            SeedKind::File(file) => {
                visit(&mut file.url);
                visit(&mut file.name);
                visit(&mut file.mime_type);
                visit(&mut file.align);
            }
            SeedKind::Table { rows } => {
                for cell in rows.iter_mut().flat_map(|row| row.cells.iter_mut()) {
                    each_inline_string(&mut cell.content, text, visit);
                }
            }
            _ => {}
        }
        each_inline_string(&mut block.content, text, visit);
        each_string(&mut block.children, text, visit);
    }
}

fn each_inline_string(content: &mut [SeedInline], text: bool, visit: Visit) {
    let link = |marks: &mut SeedMarks, visit: Visit| {
        if let Some(href) = &mut marks.link {
            visit(href);
        }
    };
    for piece in content {
        match piece {
            SeedInline::Text { text: run, marks } => {
                if text {
                    visit(run);
                }
                link(marks, visit);
            }
            SeedInline::HardBreak { marks } => link(marks, visit),
            SeedInline::HtmlComment { source } => visit(source),
            SeedInline::InlineImage { src, alt, .. } => {
                visit(src);
                visit(alt);
            }
            // Made by the promotion, which runs after every restore.
            SeedInline::Token(_) => {}
        }
    }
}
