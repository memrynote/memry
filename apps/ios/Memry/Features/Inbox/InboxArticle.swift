import Foundation
import JavaScriptCore

// D3, article half. Desktop's article job (`processArticleExtractJob`) turns a
// captured page into readable markdown with Defuddle and stores it as the
// capture's content, which filing then writes as the note body. The same
// extraction runs here: `Resources/article-extract.js` is
// `@memry/article-extract` bundled for JavaScriptCore
// (`scripts/generate-ios-article-extract.mjs`), so a phone capture carries
// the article a desktop capture would.

enum InboxArticle {
    /// What the core stores: the markdown, and the metadata keys desktop's
    /// `ingestArticleCapture` writes (`url`, `excerpt`, `extractionStatus`,
    /// `properties`).
    struct Extracted {
        var markdown: String
        var metadataJson: String
    }

    /// The article in `html`, or nil when there is none (`extractionStatus`
    /// `failed`) or the script could not run. Runs off the main thread.
    static func extract(html: String, url: URL, now: Date = .now) async -> Extracted? {
        await Task.detached(priority: .utility) {
            run(html: html, url: url.absoluteString, now: now.ISO8601Format())
        }.value
    }

    private static let script: String? = Bundle.main.url(forResource: "article-extract", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    private static func run(html: String, url: String, now: String) -> Extracted? {
        guard let script, let context = JSContext() else {
            Log.core.error("the article script is missing", .code("inbox.article.script"))
            return nil
        }
        var failed = false
        context.exceptionHandler = { _, _ in failed = true }
        context.evaluateScript(script)
        context.setObject(html, forKeyedSubscript: "__memryHtml" as NSString)
        context.setObject(url, forKeyedSubscript: "__memryUrl" as NSString)
        context.setObject(now, forKeyedSubscript: "__memryNow" as NSString)
        // Extraction makes no fetches (`useAsync` off), so the promise settles
        // in the microtasks JavaScriptCore drains before this call returns.
        context.evaluateScript("""
        memryExtractArticle(__memryHtml, __memryUrl, __memryNow)
          .then(function (json) { globalThis.__memryResult = json })
          .catch(function () { globalThis.__memryResult = null })
        """)
        guard !failed,
              let json = context.objectForKeyedSubscript("__memryResult")?.toString(),
              let capture = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
              let markdown = capture["contentMarkdown"] as? String, !markdown.isEmpty,
              let status = capture["extractionStatus"] as? String, status != "failed"
        else {
            if failed { Log.core.error("an article could not be extracted", .code("inbox.article.extract")) }
            return nil
        }
        let patch: [String: Any] = [
            "url": capture["url"] as? String ?? url,
            "excerpt": capture["excerpt"] as? String ?? "",
            "extractionStatus": status,
            "properties": capture["properties"] ?? [:]
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: patch),
              let metadataJson = String(data: data, encoding: .utf8) else { return nil }
        return Extracted(markdown: markdown, metadataJson: metadataJson)
    }
}
