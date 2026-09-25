import Foundation

// The shell's one request that is not the core's: the `<head>` of a page the
// user captured, for its link preview (Inbox D3). It never talks to Memry's
// server, carries no credentials, and reads what `LPMetadataProvider` already
// fetches for the same page; the core has nothing to retry or switch off here.
// Kept in Seams/ with the transport so every network path in the shell is in
// one folder.

enum PageHeadFetch {
    /// Only the head matters; a long page is cut here.
    static let readLimit = 512 * 1024

    /// The page's leading HTML and its final address, or nil (quiet, as on
    /// desktop).
    static func html(_ url: URL) async -> (html: String, url: URL)? {
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.setValue("text/html", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        return (String(decoding: data.prefix(readLimit), as: UTF8.self), http.url ?? url)
    }
}
