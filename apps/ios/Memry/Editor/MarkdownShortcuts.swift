//
//  MarkdownShortcuts.swift
//  Desktop's markdown input rules: `# ` makes a heading, `**x**` makes bold.
//
//  Desktop references: BlockNote's block input rules (`Heading/block.ts`,
//  `BulletListItem`, `NumberedListItem`, `CheckListItem`, `Quote`,
//  `CodeKeyboardShortcutsExtension.ts`, `Divider/block.ts`) and TipTap's mark
//  input rules (`extension-bold`, `extension-italic`, `extension-strike`, and
//  BlockNote's `code` override in `defaultBlocks.ts`).
//

import Foundation
import MemryCore
import UIKit

/// The input rules, as pure functions of the text before the caret with the
/// typed text already appended (ProseMirror's `textBefore + text`).
enum MarkdownShortcut {
    /// A block-start rule: the block becomes `kind`, and the first
    /// `prefixLength` UTF-16 units of the text before the caret go away.
    struct BlockRule: Equatable {
        let kind: String
        var level: Int?
        /// Props written after the type change, in name order.
        var props: [String: String] = [:]
        let prefixLength: Int
    }

    /// A mark rule: `match` (delimiters included, in UTF-16 units of the text
    /// with the typed text appended) becomes `content` carrying `mark`.
    struct MarkRule: Equatable {
        let mark: String
        let match: NSRange
        let content: NSRange
        /// Text kept after the marked content, unmarked (the code rule's space).
        var trailing = ""
    }

    /// The block rule `before` completes in a block of `kind`, or `nil`.
    /// Never on a column list or column, which hold no text.
    static func block(_ before: String, in kind: String) -> BlockRule? {
        guard kind != "codeBlock", !NoteColumns.isStructural(kind), !before.contains("\u{FFFC}") else { return nil }
        let length = (before as NSString).length
        func matches(_ pattern: String) -> [String]? {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let result = regex.firstMatch(in: before, range: NSRange(location: 0, length: length))
            else { return nil }
            return (0..<result.numberOfRanges).map {
                let range = result.range(at: $0)
                return range.location == NSNotFound ? "" : (before as NSString).substring(with: range)
            }
        }
        if let match = matches("^(#{1,6})\\s$") {
            return BlockRule(kind: "heading", level: match[1].count, prefixLength: length)
        }
        // BlockNote's bullet rule refuses a heading.
        if kind != "heading", matches("^\\s?[-+*]\\s$") != nil {
            return BlockRule(kind: "bulletListItem", prefixLength: length)
        }
        if kind != "heading", let match = matches("^\\s?(\\d+)\\.\\s$"), let start = Int(match[1]) {
            return BlockRule(kind: "numberedListItem", props: start == 1 ? [:] : ["start": String(start)], prefixLength: length)
        }
        if matches("^\\s?\\[\\s*\\]\\s$") != nil {
            return BlockRule(kind: "checkListItem", props: ["checked": "false"], prefixLength: length)
        }
        if matches("^\\s?\\[[Xx]\\]\\s$") != nil {
            return BlockRule(kind: "checkListItem", props: ["checked": "true"], prefixLength: length)
        }
        // `>` and every Unicode quotation mark (`\p{Quotation_Mark}`), which
        // is also what iOS smart quotes turn a typed `"` into.
        if matches("^[>\"'\u{AB}\u{BB}\u{2018}-\u{201F}\u{2039}\u{203A}\u{2E42}\u{300C}-\u{300F}\u{301D}-\u{301F}\u{FE41}-\u{FE44}\u{FF02}\u{FF07}\u{FF62}\u{FF63}]\\s$") != nil {
            return BlockRule(kind: "quote", prefixLength: length)
        }
        if let match = matches("^```(.*?)\\s$") {
            // `getLanguageId(options, name) ?? name`, as BlockNote's rule does.
            let name = match[1].trimmingCharacters(in: .whitespaces)
            let language = CodeLanguage.id(for: name) ?? name
            return BlockRule(kind: "codeBlock", props: language.isEmpty ? [:] : ["language": language], prefixLength: length)
        }
        // `---`, and what iOS smart dashes make of it: `—-`.
        if matches("^(---|\u{2014}-)$") != nil {
            return BlockRule(kind: "divider", prefixLength: length)
        }
        return nil
    }

    /// TipTap's mark rules, in the order the editor registers them.
    private static let markRules: [(mark: String, pattern: String, trailing: String)] = [
        ("code", "(?:^|[^`])(`([^`]+)`)$", ""),
        ("code", "(?:^|[^`])(`([^`]+)` )$", " "),
        ("bold", "(?:^|\\s)(\\*\\*(?!\\s+\\*\\*)([^*]+)\\*\\*(?!\\s+\\*\\*))$", ""),
        ("bold", "(?:^|\\s)(__(?!\\s+__)([^_]+)__(?!\\s+__))$", ""),
        ("italic", "(?:^|\\s)(\\*(?!\\s+\\*)([^*]+)\\*(?!\\s+\\*))$", ""),
        ("italic", "(?:^|\\s)(_(?!\\s+_)([^_]+)_(?!\\s+_))$", ""),
        ("strike", "(?:^|\\s)(~~(?!\\s+~~)([^~]+)~~(?!\\s+~~))$", ""),
    ]

    /// TipTap's input-rule guard: no rule runs with a character carrying the
    /// `code` mark right before or right after the caret at `location`.
    static func touchesCode(_ text: NSAttributedString, at location: Int) -> Bool {
        [location - 1, location].contains { index in
            guard index >= 0, index < text.length else { return false }
            let marks = text.attribute(.memryMarks, at: index, effectiveRange: nil) as? [String]
            return marks?.contains("code") ?? false
        }
    }

    /// The mark rule `before` completes, or `nil`. Outside a code block only,
    /// where ProseMirror runs no input rules, and never on a layout row.
    static func mark(_ before: String, in kind: String) -> MarkRule? {
        guard kind != "codeBlock", !NoteColumns.isStructural(kind) else { return nil }
        let range = NSRange(location: 0, length: (before as NSString).length)
        for rule in markRules {
            guard let regex = try? NSRegularExpression(pattern: rule.pattern),
                  let result = regex.firstMatch(in: before, range: range)
            else { continue }
            let content = result.range(at: 2)
            guard content.length > 0,
                  (before as NSString).substring(with: content).trimmingCharacters(in: .whitespaces).isEmpty == false
            else { continue }
            return MarkRule(mark: rule.mark, match: result.range(at: 1), content: content, trailing: rule.trailing)
        }
        return nil
    }
}

extension BlockField {
    /// Runs the input rules for `text` typed over the empty `range`. `true`
    /// when a rule fired and the text view already holds the result.
    func applyMarkdownShortcut(_ textView: UITextView, range: NSRange, text: String) -> Bool {
        guard let session, range.length == 0, !text.isEmpty, !text.contains("\n"),
              textView.markedTextRange == nil,
              !MarkdownShortcut.touchesCode(textView.attributedText ?? NSAttributedString(), at: range.location)
        else { return false }
        let string = textView.text as NSString
        let before = string.substring(to: range.location) + text

        if let rule = MarkdownShortcut.block(before, in: block.kind) {
            // Desktop drops the text after the caret for a divider; here a
            // divider waits for an empty rest rather than delete words.
            if rule.kind == "divider", range.location < string.length { return false }
            textView.textStorage.replaceCharacters(in: NSRange(location: 0, length: range.location), with: "")
            textView.selectedRange = NSRange(location: 0, length: 0)
            dirty = true
            textView.invalidateIntrinsicContentSize()
            session.applyBlockShortcut(rule, in: self)
            return true
        }

        if let rule = MarkdownShortcut.mark(before, in: block.kind) {
            let typed = (text as NSString).length
            // The match ends in the typed text, which never reached storage.
            let stored = NSRange(location: rule.match.location, length: rule.match.length - typed)
            let content = textView.attributedText.attributedSubstring(from: rule.content)
            let replacement = NSMutableAttributedString(attributedString: content)
            if !rule.trailing.isEmpty {
                replacement.append(NSAttributedString(string: rule.trailing, attributes: BlockText.baseAttributes(style)))
            }
            textView.textStorage.replaceCharacters(in: stored, with: replacement)
            let start = rule.match.location
            let caret = start + replacement.length
            textView.selectedRange = NSRange(location: caret, length: 0)
            textView.typingAttributes = BlockText.baseAttributes(style)
            dirty = true
            textView.invalidateIntrinsicContentSize()
            let attributed = textView.attributedText ?? NSAttributedString()
            let from = BlockText.coreOffset(in: attributed, utf16: start)
            let to = BlockText.coreOffset(in: attributed, utf16: start + rule.content.length)
            pendingSelection = NSRange(location: caret, length: 0)
            session.applyMarkShortcut(rule.mark, from: from, to: to, in: self)
            return true
        }
        return false
    }
}

extension EditorSession {
    /// A block rule: the stripped text is written, then the type and props.
    func applyBlockShortcut(_ rule: MarkdownShortcut.BlockRule, in field: BlockField) {
        let blockId = field.blockId
        if rule.kind == "divider" {
            // A divider holds no text, so the caret moves to a new line after it.
            let previous = field.block.kind
            commit(field) { [weak self] in
                guard let self, let model = self.model else { return }
                await model.turnInto(blockId, kind: "divider")
                self.history.record(.turnInto(blockId: blockId, from: previous, to: "divider"))
                guard let newId = await model.insert("paragraph", after: blockId) else { return }
                self.history.record(.insert(blockId: newId, after: blockId, kind: "paragraph", text: ""))
                self.pendingFocus = newId
            }
            return
        }
        turnInto(InsertableBlock(id: rule.kind, name: "", symbol: "", level: rule.level))
        commit(field) { [weak self] in
            guard let self, let model = self.model else { return }
            for (name, value) in rule.props.sorted(by: { $0.key < $1.key }) {
                await model.setProp(blockId, name, value)
            }
            // The row can change shape (a paragraph to a heading), which
            // makes a new text view; the caret follows the block into it.
            self.pendingFocus = blockId
        }
    }

    /// A mark rule: the stripped text is written, then the mark over it.
    func applyMarkShortcut(_ mark: String, from start: Int, to end: Int, in field: BlockField) {
        let blockId = field.blockId
        commit(field) { [weak self] in
            guard let self, let model = self.model else { return }
            await model.mark(blockId, from: start, to: end, mark)
            self.history.record(.mark(blockId: blockId, start: start, end: end, mark: mark, value: nil))
        }
    }
}

/// A code block's language key, as desktop resolves a fence tag: BlockNote's
/// `getLanguageId` over `memryCodeBlockOptions.supportedLanguages`
/// (`@blocknote/code-block` plus Memry's PowerShell and KQL,
/// `packages/editor-schema/src/code-block.ts`).
enum CodeLanguage {
    /// Each language key and the names that resolve to it.
    static let supported: [(id: String, aliases: [String])] = [
        ("text", ["text", "txt", "plain"]),
        ("c", ["c"]),
        ("cpp", ["cpp", "c++"]),
        ("css", ["css"]),
        ("glsl", ["glsl"]),
        ("graphql", ["graphql", "gql"]),
        ("haml", ["haml"]),
        ("html", ["html"]),
        ("java", ["java"]),
        ("javascript", ["javascript", "js"]),
        ("json", ["json"]),
        ("jsonc", ["jsonc"]),
        ("jsonl", ["jsonl"]),
        ("jsx", ["jsx"]),
        ("julia", ["julia", "jl"]),
        ("less", ["less"]),
        ("markdown", ["markdown", "md"]),
        ("mdx", ["mdx"]),
        ("php", ["php"]),
        ("postcss", ["postcss"]),
        ("pug", ["pug", "jade"]),
        ("python", ["python", "py"]),
        ("r", ["r"]),
        ("regexp", ["regexp", "regex"]),
        ("sass", ["sass"]),
        ("scss", ["scss"]),
        ("shellscript", ["shellscript", "bash", "sh", "shell", "zsh"]),
        ("sql", ["sql"]),
        ("svelte", ["svelte"]),
        ("typescript", ["typescript", "ts"]),
        ("vue", ["vue"]),
        ("vue-html", ["vue-html"]),
        ("wasm", ["wasm"]),
        ("wgsl", ["wgsl"]),
        ("xml", ["xml"]),
        ("yaml", ["yaml", "yml"]),
        ("tsx", ["tsx", "typescriptreact"]),
        ("haskell", ["haskell", "hs"]),
        ("csharp", ["c#", "csharp", "cs"]),
        ("latex", ["latex"]),
        ("lua", ["lua"]),
        ("mermaid", ["mermaid", "mmd"]),
        ("ruby", ["ruby", "rb"]),
        ("rust", ["rust", "rs"]),
        ("scala", ["scala"]),
        ("swift", ["swift"]),
        ("kotlin", ["kotlin", "kt", "kts"]),
        ("objective-c", ["objective-c", "objc"]),
        ("powershell", ["powershell", "pwsh", "ps1", "ps"]),
        ("kusto", ["kusto", "kql"]),
    ]

    /// The key `name` (trimmed, any case) resolves to, or `nil` when no
    /// language answers to it.
    static func id(for name: String) -> String? {
        let normalized = name.trimmingCharacters(in: .whitespaces).lowercased()
        return supported.first { $0.id == normalized || $0.aliases.contains(normalized) }?.id
    }
}
