import SwiftUI
import UIKit

// IB22, Paper 22 (8R2-0): "Save to Inbox" between a close and a confirm
// button, one preview card, and Paper 05's duplicate notice when the link is
// already in the inbox.

final class ShareViewController: UIViewController {
    private lazy var model = ShareModel(context: extensionContext)

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareSheet(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.load() }
    }
}

enum ShareCopy {
    static let title = "Save to Inbox"
    static let close = "Close"
    static let save = "Save to Inbox"
    static let alreadyCaptured = "Already captured"
    static let alreadyCapturedDetail = "This link is already in your inbox."
    static let captureAnyway = "Capture anyway"
    static let unsupported = "Memry's inbox takes links, text, photos, PDFs, audio and video."
    static let tooLarge = "This file is larger than 50 MB, the inbox limit."
    static let unavailable = "Memry could not save this. Open Memry once, then try again."
    static let savedLater = "Memry adds it to your inbox the next time it opens."
}

struct ShareSheet: View {
    let model: ShareModel

    var body: some View {
        VStack(spacing: Tokens.Space.inset) {
            header
            switch model.phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
            case let .ready(shared):
                card(shared)
                if model.duplicate { duplicateNotice }
                Text(ShareCopy.savedLater)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
            case let .failed(message):
                Text(message)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Space.inset)
        .padding(.top, Tokens.Space.medium + 2)
        .background(Tokens.Canvas.background.color)
        .tint(Tokens.Text.tint.color)
    }

    private var header: some View {
        HStack {
            Button(action: model.cancel) {
                Image(systemName: "xmark")
                    .font(Tokens.Typography.supporting.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.primary.color)
                    .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                    .background(Tokens.Canvas.surfaceActive.color, in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ShareCopy.close)
            .accessibilityIdentifier("share.close")
            Spacer()
            Text(ShareCopy.title)
                .font(Tokens.Typography.body.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button(action: model.save) {
                Image(systemName: "checkmark")
                    .font(Tokens.Typography.body.font.weight(.semibold))
                    .foregroundStyle(Tokens.Tint.foreground.color)
                    .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                    .background(Tokens.Tint.base.color.opacity(model.canSave ? 1 : 0.4), in: .circle)
            }
            .buttonStyle(.plain)
            .disabled(!model.canSave)
            .accessibilityLabel(ShareCopy.save)
            .accessibilityIdentifier("share.save")
        }
    }

    private func card(_ shared: ShareModel.Shared) -> some View {
        HStack(spacing: Tokens.Space.medium) {
            preview(shared)
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.control))
                .clipShape(.rect(cornerRadius: Tokens.Radius.control))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(heading(shared))
                    .font(Tokens.Typography.supporting.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.primary.color)
                    .lineLimit(2)
                if let detail = detail(shared) {
                    Text(detail)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Tokens.Space.small + 2)
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Tokens.Line.border.color))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func preview(_ shared: ShareModel.Shared) -> some View {
        switch shared {
        case let .file(_, _, _, thumbnail?):
            Image(uiImage: thumbnail).resizable().scaledToFill()
        case let .file(_, _, mime, nil):
            Image(systemName: mime == "application/pdf" ? "doc.richtext" : mime.hasPrefix("audio/") ? "waveform" : "film")
                .foregroundStyle(Tokens.Text.secondary.color)
        case .link:
            Image(systemName: "link").foregroundStyle(Tokens.Text.secondary.color)
        case .text:
            Image(systemName: "text.alignleft").foregroundStyle(Tokens.Text.secondary.color)
        }
    }

    private func heading(_ shared: ShareModel.Shared) -> String {
        switch shared {
        case let .link(url, title): title.flatMap { $0.isEmpty ? nil : $0 } ?? url.absoluteString
        case let .text(text): text
        case let .file(_, filename, _, _): filename
        }
    }

    private func detail(_ shared: ShareModel.Shared) -> String? {
        switch shared {
        case let .link(url, _): url.host().map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 }
        case .text: nil
        case let .file(url, _, _, _):
            (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize)
                .map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
        }
    }

    private var duplicateNotice: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(ShareCopy.alreadyCaptured)
                .font(Tokens.Typography.supporting.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
            Text(ShareCopy.alreadyCapturedDetail)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
            Toggle(ShareCopy.captureAnyway, isOn: Binding(get: { model.force }, set: { model.force = $0 }))
                .font(Tokens.Typography.supporting.font)
                .accessibilityIdentifier("share.captureAnyway")
        }
        .padding(Tokens.Space.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Tint.base.color.opacity(Tokens.Palette.chipFillAlpha), in: .rect(cornerRadius: Tokens.Radius.card))
    }
}
