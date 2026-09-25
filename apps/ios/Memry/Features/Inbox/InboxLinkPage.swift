import Foundation

// D3. The page facts desktop's link job stores in `metadata` (`jobs.ts`:
// description, heroImage, siteName, favicon), read from the page's own
// `<meta>` tags. `LPMetadataProvider` gives the title but no description, so
// without this an iOS capture would carry less than a desktop one.

struct InboxLinkPage: Equatable {
    var title: String?
    var description: String?
    var heroImage: String?
    var siteName: String?
    var favicon: String?

    /// The page's head, or nil when it cannot be read (quiet, as on desktop).
    static func fetch(_ url: URL) async -> InboxLinkPage? {
        guard let head = await PageHeadFetch.html(url) else { return nil }
        let page = parse(head.html, base: head.url)
        return page == InboxLinkPage() ? nil : page
    }

    /// Open Graph first, then Twitter and plain tags, the order metascraper
    /// prefers. Relative image and icon addresses resolve against `base`.
    static func parse(_ html: String, base: URL) -> InboxLinkPage {
        var tags: [String: String] = [:]
        var icon: String?
        for tag in matches(of: #"<(meta|link)\s[^>]*>"#, in: html) {
            let attributes = attributes(of: tag)
            if tag.lowercased().hasPrefix("<link") {
                if icon == nil, attributes["rel"]?.lowercased().split(separator: " ").contains("icon") == true {
                    icon = attributes["href"]
                }
                continue
            }
            guard let key = (attributes["property"] ?? attributes["name"])?.lowercased(),
                  let content = attributes["content"].map(decodeEntities)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !content.isEmpty, tags[key] == nil else { continue }
            tags[key] = content
        }
        let titleTag = matches(of: #"<title[^>]*>[^<]*</title>"#, in: html).first.map {
            decodeEntities($0.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        func absolute(_ value: String?) -> String? {
            guard let value, let url = URL(string: value, relativeTo: base)?.absoluteURL,
                  url.scheme == "https" || url.scheme == "http" else { return nil }
            return url.absoluteString
        }
        return InboxLinkPage(
            title: tags["og:title"] ?? tags["twitter:title"] ?? titleTag.flatMap { $0.isEmpty ? nil : $0 },
            description: tags["og:description"] ?? tags["twitter:description"] ?? tags["description"],
            heroImage: absolute(tags["og:image"] ?? tags["og:image:url"] ?? tags["twitter:image"]),
            siteName: tags["og:site_name"] ?? tags["application-name"],
            favicon: absolute(icon)
        )
    }

    private static func matches(of pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { Range($0.range, in: text).map { String(text[$0]) } }
    }

    private static func attributes(of tag: String) -> [String: String] {
        guard let regex = try? NSRegularExpression(pattern: #"([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#) else { return [:] }
        var result: [String: String] = [:]
        for match in regex.matches(in: tag, range: NSRange(tag.startIndex..., in: tag)) {
            guard let name = Range(match.range(at: 1), in: tag) else { continue }
            let value = Range(match.range(at: 2), in: tag) ?? Range(match.range(at: 3), in: tag)
            result[tag[name].lowercased()] = value.map { String(tag[$0]) } ?? ""
        }
        return result
    }

    private static func decodeEntities(_ text: String) -> String {
        var decoded = text
        for (entity, character) in [("&quot;", "\""), ("&#39;", "'"), ("&#x27;", "'"), ("&apos;", "'"),
                                    ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " "), ("&amp;", "&")] {
            decoded = decoded.replacingOccurrences(of: entity, with: character)
        }
        return decoded
    }
}
