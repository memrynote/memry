import Foundation
import SwiftUI

/// Syntax colour for a code block, by its `language` prop.
///
/// **A scanner, not a grammar.** Desktop highlights through shiki's TextMate
/// grammars, which are a JavaScript engine's worth of dependency. What a
/// reader needs from colour is to tell keywords, strings, comments, numbers,
/// calls and types apart at a glance, and one pass over the text with a
/// keyword table per language family gets that for the languages notes
/// actually hold. A language this table does not know is still scanned for
/// strings, comments and numbers, which are nearly universal, and never has
/// its text changed — only coloured.
///
/// Colours are `Tokens.Code`, which are shiki's own `github-light` and
/// `github-dark`, the themes desktop uses.
enum CodeHighlighter {
    enum Kind: Equatable {
        case plain, keyword, function, string, constant, variable, comment
    }

    struct Token: Equatable {
        let text: String
        let kind: Kind
    }

    static func attributed(_ code: String, language: String?) -> AttributedString {
        var out = AttributedString()
        for token in tokens(code, language: language) {
            var piece = AttributedString(token.text)
            piece.foregroundColor = color(token.kind)
            out.append(piece)
        }
        return out
    }

    private static func color(_ kind: Kind) -> Color {
        switch kind {
        case .plain: Tokens.Code.plain.color
        case .keyword: Tokens.Code.keyword.color
        case .function: Tokens.Code.function.color
        case .string: Tokens.Code.string.color
        case .constant: Tokens.Code.constant.color
        case .variable: Tokens.Code.variable.color
        case .comment: Tokens.Code.comment.color
        }
    }

    // MARK: - Scanning

    static func tokens(_ code: String, language: String?) -> [Token] {
        let rules = Rules.of(language)
        let chars = Array(code)
        var tokens: [Token] = []
        var plain = ""
        var index = 0
        var previousWord: String?

        func flushPlain() {
            if !plain.isEmpty {
                tokens.append(Token(text: plain, kind: .plain))
                plain = ""
            }
        }
        func emit(_ text: String, _ kind: Kind) {
            flushPlain()
            tokens.append(Token(text: text, kind: kind))
        }
        func starts(_ prefix: String, at position: Int) -> Bool {
            let needle = Array(prefix)
            guard position + needle.count <= chars.count else { return false }
            return Array(chars[position..<position + needle.count]) == needle
        }

        while index < chars.count {
            let char = chars[index]

            // Comments: to the end of the line, or to a block's close.
            if rules.lineComments.contains(where: { starts($0, at: index) }) {
                var end = index
                while end < chars.count, chars[end] != "\n" { end += 1 }
                emit(String(chars[index..<end]), .comment)
                index = end
                continue
            }
            if let (open, close) = rules.blockComment, starts(open, at: index) {
                var end = index + open.count
                while end < chars.count, !starts(close, at: end) { end += 1 }
                end = min(chars.count, end + close.count)
                emit(String(chars[index..<end]), .comment)
                index = end
                continue
            }

            // Strings, honouring a backslash escape. A template string's
            // `${…}` stays inside the string, as github-light colours it.
            if rules.quotes.contains(char) {
                var end = index + 1
                while end < chars.count, chars[end] != char {
                    if chars[end] == "\\" { end += 1 }
                    if char != "`", chars[end] == "\n" { break }
                    end += 1
                }
                end = min(chars.count, end + 1)
                emit(String(chars[index..<end]), .string)
                index = end
                continue
            }

            // Numbers, not the digits inside an identifier.
            if char.isNumber, !(index > 0 && (chars[index - 1].isLetter || chars[index - 1] == "_")) {
                var end = index
                while end < chars.count,
                      chars[end].isHexDigit || chars[end] == "." || chars[end] == "x" || chars[end] == "_" {
                    end += 1
                }
                emit(String(chars[index..<end]), .constant)
                index = end
                continue
            }

            // Words: keywords, constants, calls and types.
            if char.isLetter || char == "_" || (char == "$" && rules.dollarIdentifiers) {
                var end = index
                while end < chars.count,
                      chars[end].isLetter || chars[end].isNumber || chars[end] == "_"
                      || (chars[end] == "$" && rules.dollarIdentifiers) {
                    end += 1
                }
                let word = String(chars[index..<end])
                var next = end
                while next < chars.count, chars[next] == " " { next += 1 }
                let isCall = next < chars.count && chars[next] == "("
                let kind: Kind
                if rules.keywords.contains(word) {
                    kind = .keyword
                } else if rules.constants.contains(word) {
                    kind = .constant
                } else if isCall || rules.declarers.contains(previousWord ?? "") {
                    kind = .function
                } else if rules.types.contains(word) || (word.first?.isUppercase == true && word.count > 1) {
                    kind = .constant
                } else {
                    kind = .plain
                }
                if kind == .plain { plain += word } else { emit(word, kind) }
                previousWord = word
                index = end
                continue
            }

            if !char.isWhitespace { previousWord = nil }
            plain.append(char)
            index += 1
        }
        flushPlain()
        return tokens
    }

    // MARK: - Languages

    struct Rules {
        var keywords: Set<String> = []
        var constants: Set<String> = ["true", "false", "null", "nil", "None", "True", "False", "undefined"]
        var types: Set<String> = []
        /// Words after which the next identifier is a definition's name.
        var declarers: Set<String> = []
        var lineComments: [String] = []
        var blockComment: (String, String)?
        var quotes: Set<Character> = ["\"", "'"]
        var dollarIdentifiers = false

        static func of(_ language: String?) -> Rules {
            let key = (language ?? "").lowercased()
            if ["", "text", "plaintext", "plain", "txt", "markdown", "md"].contains(key) {
                // Prose in a code block. Colouring `#` as a comment would
                // grey out every markdown heading in it.
                return Rules(constants: [])
            }
            return families.first { $0.names.contains(key) }?.rules()
                // Unknown: the near-universal pieces only.
                ?? Rules(lineComments: ["//", "#"], blockComment: ("/*", "*/"))
        }

        private static let families: [(names: Set<String>, rules: @Sendable () -> Rules)] = [
            (["javascript", "js", "jsx", "typescript", "ts", "tsx"], javaScript),
            (["python", "py"], python),
            (["swift"], swift),
            (["rust", "rs"], rust),
            (["go", "golang"], go),
            (["java", "kotlin", "kt", "c", "cpp", "c++", "csharp", "cs", "c#"], cFamily),
            (["shell", "shellscript", "bash", "sh", "zsh"], shell),
            (["sql"], sql),
            (["ruby", "rb"], ruby),
            (["yaml", "yml", "toml"], config),
            (["css", "scss"], css),
            (["html", "xml"], markup),
            (["json"], json)
        ]

        private static func javaScript() -> Rules {
            var rules = Rules(
                keywords: Set("""
                    const let var function return if else for while do switch case break \
                    continue new class extends import export from default async await try \
                    catch finally throw typeof instanceof in of this super yield interface \
                    type enum implements public private protected readonly static as void
                    """.split(separator: " ").map(String.init)),
                types: ["string", "number", "boolean", "any", "unknown", "never", "object"],
                declarers: ["function", "class", "interface", "type", "enum"],
                lineComments: ["//"],
                blockComment: ("/*", "*/"),
                dollarIdentifiers: true
            )
            rules.quotes.insert("`")
            return rules
        }

        private static func python() -> Rules {
            return Rules(
                keywords: Set("""
                    def return if elif else for while in not and or is import from as class \
                    try except finally raise with lambda yield pass break continue global \
                    nonlocal async await assert del
                    """.split(separator: " ").map(String.init)),
                types: ["int", "str", "float", "bool", "list", "dict", "set", "tuple"],
                declarers: ["def", "class"],
                lineComments: ["#"]
            )
        }

        private static func swift() -> Rules {
            return Rules(
                keywords: Set("""
                    let var func return if else guard for while in switch case default break \
                    continue struct class enum protocol extension import init self Self \
                    throws throw try await async private public internal fileprivate static \
                    some any where as is
                    """.split(separator: " ").map(String.init)),
                declarers: ["func", "struct", "class", "enum", "protocol"],
                lineComments: ["//"],
                blockComment: ("/*", "*/")
            )
        }

        private static func rust() -> Rules {
            return Rules(
                keywords: Set("""
                    fn let mut pub use mod struct enum impl trait for in if else match loop \
                    while return break continue as ref move self Self crate super where \
                    async await dyn const static unsafe type
                    """.split(separator: " ").map(String.init)),
                constants: ["true", "false", "None", "Some", "Ok", "Err"],
                declarers: ["fn", "struct", "enum", "trait", "impl", "mod"],
                lineComments: ["//"],
                blockComment: ("/*", "*/")
            )
        }

        private static func go() -> Rules {
            return Rules(
                keywords: Set("""
                    func package import var const type struct interface map chan go defer \
                    return if else for range switch case default break continue select
                    """.split(separator: " ").map(String.init)),
                declarers: ["func", "type"],
                lineComments: ["//"],
                blockComment: ("/*", "*/")
            )
        }

        private static func cFamily() -> Rules {
            return Rules(
                keywords: Set("""
                    public private protected static final class interface extends implements \
                    return if else for while do switch case break continue new void int \
                    long double float bool boolean char struct namespace using include \
                    fun val var override const auto
                    """.split(separator: " ").map(String.init)),
                declarers: ["class", "interface", "struct", "fun"],
                lineComments: ["//"],
                blockComment: ("/*", "*/")
            )
        }

        private static func shell() -> Rules {
            return Rules(
                keywords: Set("""
                    if then else elif fi for in do done while case esac function return \
                    export local echo exit set unset
                    """.split(separator: " ").map(String.init)),
                lineComments: ["#"],
                dollarIdentifiers: true
            )
        }

        private static func sql() -> Rules {
            let words = """
                select from where insert into values update set delete create table alter \
                drop index join left right inner outer on group by order having limit as \
                and or not null is in distinct primary key foreign references
                """.split(separator: " ").map(String.init)
            return Rules(
                keywords: Set(words + words.map { $0.uppercased() }),
                lineComments: ["--"],
                blockComment: ("/*", "*/")
            )
        }

        private static func ruby() -> Rules {
            return Rules(
                keywords: Set("""
                    def end if elsif else unless while until for in do return class module \
                    require yield begin rescue ensure self
                    """.split(separator: " ").map(String.init)),
                declarers: ["def", "class", "module"],
                lineComments: ["#"]
            )
        }

        private static func config() -> Rules {
            return Rules(lineComments: ["#"])
        }

        private static func css() -> Rules {
            return Rules(blockComment: ("/*", "*/"))
        }

        private static func markup() -> Rules {
            return Rules(blockComment: ("<!--", "-->"))
        }

        private static func json() -> Rules {
            return Rules()
        }
    }
}
