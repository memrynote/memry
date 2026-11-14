import Foundation
import Testing

@testable import Memry

// #4381: a Handoff activity carries ids only, continues through the shell's
// routers, and never opens an item from another vault.

@MainActor
@Suite("Handoff")
struct HandoffTests {
    nonisolated static let items: [HandoffItem] = [.note("note-1"), .journalDay("2099-03-02"), .task("task-1")]

    @Test(arguments: items)
    func the_activity_holds_only_ids(_ item: HandoffItem) throws {
        let activity = NSUserActivity(activityType: HandoffActivity.type)
        HandoffActivity(vaultId: "vault-1", item: item).configure(activity)

        let info = try #require(activity.userInfo as? [String: String])
        #expect(Set(info.keys) == ["vault", "kind", "id"])
        #expect(info["vault"] == "vault-1")
        #expect(info["id"] == item.id)
        #expect(activity.title == nil)
        #expect(activity.isEligibleForHandoff)
        #expect(!activity.isEligibleForSearch)
        #expect(!activity.isEligibleForPrediction)
        #expect(HandoffActivity(activity) == HandoffActivity(vaultId: "vault-1", item: item))
    }

    @Test func a_note_opens_on_the_notes_page() {
        let (tasks, journal, notes) = routers()
        let missing = HandoffActivity(vaultId: "vault-1", item: .note("note-1"))
            .open(openVault: "vault-1", tasks: tasks, journal: journal, notes: notes)
        #expect(missing == nil)
        #expect(tasks.selectedTab == .notes)
        #expect(notes.pending == "note-1")
    }

    @Test func a_journal_day_opens_in_the_journal() {
        let (tasks, journal, notes) = routers()
        tasks.selectedTab = .home
        let missing = HandoffActivity(vaultId: "vault-1", item: .journalDay("2099-03-02"))
            .open(openVault: "vault-1", tasks: tasks, journal: journal, notes: notes)
        #expect(missing == nil)
        #expect(tasks.selectedTab == .journal)
        #expect(journal.path == [.month(year: 2099, month: 3), .day("2099-03-02")])
    }

    @Test func a_task_opens_in_tasks() {
        let (tasks, journal, notes) = routers()
        let missing = HandoffActivity(vaultId: "vault-1", item: .task("task-1"))
            .open(openVault: "vault-1", tasks: tasks, journal: journal, notes: notes)
        #expect(missing == nil)
        #expect(tasks.selectedTab == .tasks)
        #expect(tasks.path == [.task("task-1")])
    }

    @Test(arguments: items)
    func another_vault_shows_the_missing_state_and_opens_nothing(_ item: HandoffItem) {
        let (tasks, journal, notes) = routers()
        tasks.selectedTab = .home
        let missing = HandoffActivity(vaultId: "vault-2", item: item)
            .open(openVault: "vault-1", tasks: tasks, journal: journal, notes: notes)
        #expect(missing == item.kind)
        #expect(tasks.selectedTab == .home)
        #expect(tasks.path.isEmpty)
        #expect(journal.path.isEmpty)
        #expect(notes.pending == nil)
    }

    @Test func an_unknown_kind_or_a_bad_day_is_ignored() {
        #expect(HandoffActivity(userInfo: ["vault": "v", "kind": "whiteboard", "id": "x"]) == nil)
        #expect(HandoffActivity(userInfo: ["vault": "v", "kind": "journal", "id": "2099-02-30"]) == nil)
        #expect(HandoffActivity(userInfo: ["vault": "v", "kind": "note"]) == nil)
    }

    @Test func turning_handoff_off_ignores_a_continued_activity() throws {
        let defaults = try #require(UserDefaults(suiteName: "HandoffTests"))
        defer { defaults.removePersistentDomain(forName: "HandoffTests") }
        let activity = NSUserActivity(activityType: HandoffActivity.type)
        HandoffActivity(vaultId: "vault-1", item: .task("task-1")).configure(activity)
        let links = HandoffLinks()

        defaults.set(false, forKey: HandoffActivity.settingKey)
        #expect(!links.request(activity, defaults: defaults))
        #expect(links.pending == nil)

        defaults.removeObject(forKey: HandoffActivity.settingKey)
        #expect(links.request(activity, defaults: defaults), "absent means on")
        #expect(links.take() == HandoffActivity(vaultId: "vault-1", item: .task("task-1")))
    }

    private func routers() -> (TasksRouter, JournalRouter, NotesLinks) {
        let tasks = TasksRouter()
        return (tasks, JournalRouter(today: "2099-06-15", tabs: nil), NotesLinks())
    }
}
