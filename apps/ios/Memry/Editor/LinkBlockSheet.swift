//
//  LinkBlockSheet.swift
//  The Bookmark and YouTube catalog rows: one URL field, and the block it
//  becomes, in the props desktop writes before it fetches anything.
//
//  Desktop references: `packages/shared/src/youtube.ts` (the video id rule
//  and its fixtures in `youtube.test.ts`), `ContentArea.tsx`
//  `handlePasteLinkSelect` (the props an embed and a bookmark start with),
//  `url-metadata.ts` `extractDomain`, and `paste-url-link.ts`
//  `BARE_URL_REGEX` (what counts as a link).
//

import MemryCore
import SwiftUI

/// Desktop's `extractYouTubeVideoId`, on Foundation's URL parser.
enum YouTubeLink {
    static func videoId(_ address: String) -> String? {
        guard let components = URLComponents(string: address), let host = components.host?.lowercased() else { return nil }
        let segments = components.percentEncodedPath.split(separator: "/").map(String.init)
        if host == "youtu.be" { return valid(segments.first) }
        guard host == "youtube.com" || host.hasSuffix(".youtube.com") else { return nil }
        if components.percentEncodedPath == "/watch" {
            return valid(components.queryItems?.first { $0.name == "v" }?.value)
        }
        guard segments.count >= 2, segments[0] == "embed" || segments[0] == "shorts" else { return nil }
        return valid(segments[1])
    }

    private static func valid(_ id: String?) -> String? {
        guard let id, id.utf8.count == 11,
              id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else { return nil }
        return id
    }
}

struct LinkBlock: Equatable {
    enum Kind: String, Identifiable, Sendable {
        case bookmark, youtube
        var id: String { rawValue }
    }

    let kind: String
    let props: [String: String]

    /// `nil` when `address` is not a link this row can make a block from:
    /// a bookmark takes any `http(s)` address, a YouTube embed only a video.
    static func make(_ kind: Kind, from address: String) -> LinkBlock? {
        let url = address.trimmingCharacters(in: .whitespacesAndNewlines)
        switch kind {
        case .youtube:
            guard let videoId = YouTubeLink.videoId(url) else { return nil }
            return LinkBlock(kind: "youtubeEmbed", props: ["videoId": videoId, "videoUrl": url])
        case .bookmark:
            guard url.range(of: #"^https?://\S+$"#, options: .regularExpression) != nil,
                  let host = URLComponents(string: url)?.host?.lowercased(), !host.isEmpty else { return nil }
            let domain = host.range(of: "www.").map { host.replacingCharacters(in: $0, with: "") } ?? host
            return LinkBlock(kind: "bookmark", props: ["domain": domain, "url": url])
        }
    }

    static func pasted(_ strings: [String]) -> String? {
        strings.lazy.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
    }

    func edits(newId: String, after: String?) -> [BlockEdit] {
        [.insertBlock(kind: kind, afterBlockId: after, text: "", newBlockId: newId)]
            + props.sorted { $0.key < $1.key }.map { .setProp(blockId: newId, name: $0.key, value: $0.value) }
    }
}

struct LinkBlockRequest: Identifiable, Equatable {
    let kind: LinkBlock.Kind
    /// The block the new one goes after; `nil` for the end of the body.
    let after: String?
    var id: String { kind.id }
}

struct LinkBlockSheet: View {
    let kind: LinkBlock.Kind
    let add: (LinkBlock) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @FocusState private var focused: Bool

    private var block: LinkBlock? { LinkBlock.make(kind, from: address) }

    private var title: String {
        switch kind {
        case .bookmark: "Bookmark"
        case .youtube: "YouTube video"
        }
    }

    private var hint: String {
        switch kind {
        case .bookmark: "Paste a link that starts with https://"
        case .youtube: "Paste a YouTube video link"
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("https://", text: $address)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .focused($focused)
                            .onSubmit(submit)
                            .accessibilityLabel("Link")
                            .accessibilityIdentifier("linkBlock.address")
                        // The system button reads the pasteboard only on the
                        // user's tap, so the sheet never raises the paste prompt.
                        PasteButton(payloadType: String.self) { strings in
                            if let pasted = LinkBlock.pasted(strings) { address = pasted }
                        }
                        .labelStyle(.iconOnly)
                        .buttonBorderShape(.capsule)
                        .accessibilityIdentifier("linkBlock.paste")
                    }
                } footer: {
                    if !address.isEmpty, block == nil {
                        Text(hint)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("linkBlock.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add", action: submit)
                        .disabled(block == nil)
                        .accessibilityIdentifier("linkBlock.add")
                }
            }
        }
        .presentationDetents([.medium])
        .task { focused = true }
    }

    private func submit() {
        guard let block else { return }
        add(block)
        dismiss()
    }
}
