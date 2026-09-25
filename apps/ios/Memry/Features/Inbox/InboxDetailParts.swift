import AVFoundation
import MemryCore
import SwiftUI

// IB11 / IB12. The voice memo's player and transcript (Paper 11), the note
// capture's editable body, and the reminder capture's target.

struct InboxVoiceDetail: View {
    let item: InboxItemRecord
    let store: InboxStore
    let file: URL?

    @State private var player: AVAudioPlayer?
    @State private var playing = false
    @State private var position: TimeInterval = 0
    @State private var copied = false

    private var duration: TimeInterval { InboxMeta.metadata(item)["duration"] as? Double ?? 0 }
    private var waveform: [Double] { (InboxMeta.metadata(item)["waveform"] as? [NSNumber])?.map(\.doubleValue) ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.inset) {
            if file != nil { playerCard } else {
                Label(InboxCopy.fileNotHere, systemImage: "iphone.slash")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            HStack {
                Text(InboxCopy.transcription)
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.secondary.color)
                Spacer()
                if let text = item.transcription, !text.isEmpty {
                    Button(copied ? InboxCopy.copied : InboxCopy.copy) {
                        UIPasteboard.general.string = text
                        copied = true
                    }
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.tint.color)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityLabel(InboxCopy.copyTranscription)
                    .accessibilityIdentifier("inbox.detail.copy")
                }
            }
            transcript
        }
    }

    @ViewBuilder private var transcript: some View {
        switch item.transcriptionStatus {
        case "pending", "processing":
            Label(InboxCopy.transcribingAudio, systemImage: "waveform")
                .foregroundStyle(Tokens.Text.secondary.color)
        case "failed":
            HStack {
                Text(InboxCopy.transcriptionFailed).foregroundStyle(Tokens.Text.secondary.color)
                Spacer()
                if file != nil {
                    Button(InboxCopy.retry) { Task { await store.transcribeVoice(item.id, file: file) } }
                        .foregroundStyle(Tokens.Text.tint.color)
                        .accessibilityIdentifier("inbox.detail.retry")
                }
            }
        default:
            Text(item.transcription?.isEmpty == false ? item.transcription ?? "" : InboxCopy.noTranscription)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .textSelection(.enabled)
        }
    }

    private var playerCard: some View {
        HStack(spacing: Tokens.Space.medium) {
            Button {
                toggle()
            } label: {
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .foregroundStyle(Tokens.Interaction.actionForeground.color)
                    .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                    .background(Tokens.Interaction.actionFill.color, in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(playing ? InboxCopy.pause : InboxCopy.play)
            .accessibilityIdentifier("inbox.detail.play")
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                HStack(alignment: .center, spacing: 2) {
                    let bars = waveform.isEmpty ? Array(repeating: 0.4, count: 30) : InboxVoiceRecorder.buckets(waveform, count: 30)
                    ForEach(Array(bars.enumerated()), id: \.offset) { index, level in
                        Capsule()
                            .fill(Double(index) / Double(bars.count) <= progress ? Tokens.Inbox.voice.color : Tokens.Line.focus.color.opacity(0.4))
                            .frame(width: 3, height: max(4, level * Tokens.Size.pill))
                    }
                }
                .frame(height: Tokens.Size.pill)
                Slider(value: Binding(get: { position }, set: { seek($0) }), in: 0 ... max(duration, 1))
                    .accessibilityLabel(InboxCopy.audioPosition)
                HStack {
                    Text(InboxMeta.duration(position))
                    Spacer()
                    Text(InboxMeta.duration(duration))
                }
                .font(Tokens.Typography.caption.font.monospacedDigit())
                .foregroundStyle(Tokens.Text.tertiary.color)
            }
        }
        .padding(Tokens.Space.medium)
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
        .task(id: playing) {
            while playing, let player {
                position = player.currentTime
                if !player.isPlaying { playing = false }
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
        .onDisappear { player?.stop() }
    }

    private var progress: Double { duration > 0 ? position / duration : 0 }

    private func toggle() {
        if player == nil, let file {
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            player = try? AVAudioPlayer(contentsOf: file)
        }
        guard let player else { return }
        if player.isPlaying {
            player.pause()
            playing = false
        } else {
            player.play()
            playing = true
        }
    }

    private func seek(_ time: TimeInterval) {
        position = time
        player?.currentTime = time
    }
}

/// A note capture's body: edited in place, saved after a pause (desktop's
/// debounced `inbox:update`), the title following the first line.
struct InboxNoteEditor: View {
    let item: InboxItemRecord
    let store: InboxStore
    let editable: Bool
    @State private var text = ""
    @State private var loaded = false

    var body: some View {
        TextField(InboxCopy.notePlaceholder, text: $text, axis: .vertical)
            .font(Tokens.Typography.body.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .disabled(!editable)
            .accessibilityIdentifier("inbox.detail.body")
            .onAppear {
                if !loaded {
                    text = item.content ?? ""
                    loaded = true
                }
            }
            .task(id: text) {
                guard loaded, text != (item.content ?? "") else { return }
                try? await Task.sleep(for: .milliseconds(600))
                guard !Task.isCancelled else { return }
                await store.setContent(item.id, text)
                let first = String(text.split(separator: "\n", omittingEmptySubsequences: true).first ?? "")
                let title = first.count > 50 ? String(first.prefix(50)) + "..." : first
                if !title.isEmpty, title != item.title { await store.rename(item.id, to: title) }
            }
    }
}

/// A fired reminder (desktop `reminder-detail.tsx`): its target and note, and
/// Open for a task target (the task opens in the Tasks tab).
struct InboxReminderDetail: View {
    let item: InboxItemRecord
    @Environment(TasksRouter.self) private var tasksRouter

    private var meta: [String: Any] { InboxMeta.metadata(item) }

    var body: some View {
        let type = meta["targetType"] as? String ?? "note"
        let targetId = meta["targetId"] as? String ?? ""
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            Label(InboxCopy.reminderTriggered, systemImage: "bell")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Inbox.reminder.color)
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(InboxCopy.source).font(Tokens.Typography.caption.font).foregroundStyle(Tokens.Text.tertiary.color)
                    Text(InboxPanelText.targetTitle(type: type, id: targetId, title: meta["targetTitle"] as? String))
                        .font(Tokens.Typography.body.font)
                }
                Spacer()
                if type == "task", !targetId.isEmpty {
                    Button(InboxCopy.open) { tasksRouter.openTask(targetId) }
                        .foregroundStyle(Tokens.Text.tint.color)
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .accessibilityIdentifier("inbox.detail.openTarget")
                }
            }
            .padding(Tokens.Space.inset)
            .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
            if type != "task" {
                Text(InboxPanelText.unopenable(type))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            if let note = meta["reminderNote"] as? String, !note.isEmpty {
                Text(InboxCopy.reminderNote).font(Tokens.Typography.caption.font.weight(.semibold))
                Text(note).font(Tokens.Typography.body.font)
            }
            Text(item.viewedAtMs == nil ? InboxCopy.notYetViewed : InboxCopy.viewed)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
        }
    }
}

/// How a reminder's target reads, and why a note or journal target does not
/// open from here (§6 IB18).
enum InboxPanelText {
    static func targetTitle(type: String, id: String, title: String?) -> String {
        if let title, !title.isEmpty { return type == "journal" ? InboxCopy.journalTitle(title) : title }
        switch type {
        case "journal": return InboxCopy.journalTitle(id)
        case "task": return "Task"
        default: return "Note"
        }
    }

    static func unopenable(_ type: String) -> String {
        type == "journal" ? "Journal days open on your computer for now." : "Open it from Notes on this phone."
    }
}
