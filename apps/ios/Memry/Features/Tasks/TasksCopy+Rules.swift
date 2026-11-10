import Foundation
import MemryCore

// The advanced filter's strings and labels, from desktop's `tasks.json`
// (`filters.advanced.*`) and `rule-labels.ts`.

extension TasksCopy {
    static let rulesEntry = "Advanced filter"
    static let rulesEntryHint = "Rules with and, or, not"
    static let rulesTitle = "Advanced filter"
    static let rulesMatch = "Match"
    static let rulesOfThese = "of these"
    static let rulesAddRule = "Add rule"
    static let rulesAddGroup = "Add group"
    static let rulesClear = "Clear rules"
    static let rulesRemoveRule = "Remove rule"
    static let rulesRemoveGroup = "Remove group"
    static let rulesUnknown = "Rule from a newer version"
    static let rulesEmpty = "No rules yet. Add one to start filtering."
    static let rulesPick = "Pick…"
    static let rulesTitlePlaceholder = "Text in the title"
    static let filterLocation = "Location"
    static let filterSearchLocations = "Search folders and notes"
    static let filterNoLocations = "No folders or notes hold tasks yet"

    static func rulesMatchCount(_ count: Int) -> String { count == 1 ? "1 task matches" : "\(count) tasks match" }
    static func rulesSkipped(_ count: Int) -> String { count == 1 ? "1 rule skipped" : "\(count) rules skipped" }
    static func rulesCount(_ count: Int) -> String { count == 1 ? "1 rule" : "\(count) rules" }

    static func ruleMatchLabel(_ match: String) -> String {
        switch match {
        case "all": "all"
        case "any": "any"
        case "none": "none"
        default: match
        }
    }

    static func ruleFieldLabel(_ field: String) -> String {
        switch field {
        case "title": "Title"
        case "status": "Status"
        case "priority": "Priority"
        case "due": "Due date"
        case "project": "Project"
        case "location": "Location"
        case "tags": "Tags"
        case "repeat": "Repeats"
        case "hasTime": "Has time"
        default: field
        }
    }

    static func ruleOpLabel(field: String, op: String) -> String {
        if field == "tags" {
            switch op {
            case "any": return "has any of"
            case "all": return "has all of"
            case "none": return "has none of"
            default: break
            }
        }
        switch op {
        case "contains": return "contains"
        case "notContains": return "does not contain"
        case "any": return "is any of"
        case "none": return "is none of"
        case "all": return "has all of"
        case "empty": return "is empty"
        case "notEmpty": return "is not empty"
        case "is": return "is"
        case "isNot": return "is not"
        default: return op
        }
    }

    static func ruleValueLabel(field: String, value: String, projects: [ProjectItem]) -> String {
        switch field {
        case "priority": return TaskFilterOptions.priorityLabel(value)
        case "status": return projects.flatMap(\.statuses).first { $0.id == value }?.name ?? value
        case "project": return projects.first { $0.id == value }?.name ?? value
        case "tags": return "#\(value)"
        case "due": return value == "custom" ? filterCustomRange : dueFilterLabel(value)
        case "repeat": return repeatFilterLabel(value)
        case "hasTime": return hasTimeFilterLabel(value)
        default: return value
        }
    }

    /// A rule's values as words, a custom due range as its two ends.
    static func ruleValues(_ rule: TaskFilterNode, projects: [ProjectItem]) -> [String] {
        switch rule.field {
        case "title":
            return rule.values.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        case "location":
            return rule.folderPaths.map { $0.split(separator: "/").last.map(String.init) ?? $0 } + rule.noteIds
        case "due":
            return rule.values.map { value in
                value == "custom"
                    ? "\(rule.dueStart.map(TaskFilterOptions.displayDate) ?? "…") – \(rule.dueEnd.map(TaskFilterOptions.displayDate) ?? "…")"
                    : dueFilterLabel(value)
            }
        default:
            return TaskFilterRuleVocabulary.isValueless(rule.op)
                ? []
                : rule.values.map { ruleValueLabel(field: rule.field, value: $0, projects: projects) }
        }
    }

    /// The rules as one sentence, as desktop's `summarizeExpression` reads
    /// them: "Priority Urgent or not ( Tags #work or Priority High )". Rules
    /// with no value are left out.
    static func rulesSummary(_ root: TaskFilterNode, projects: [ProjectItem]) -> String {
        summaryParts(root, projects: projects, top: true) ?? ""
    }

    private static func summaryParts(_ group: TaskFilterNode, projects: [ProjectItem], top: Bool) -> String? {
        let parts: [String] = group.rules.compactMap { node in
            if node.isGroup { return summaryParts(node, projects: projects, top: false) }
            guard node.isKnownRule else { return nil }
            let values = ruleValues(node, projects: projects)
            if values.isEmpty, !TaskFilterRuleVocabulary.isValueless(node.op) { return nil }
            let negative = TaskFilterRuleVocabulary.isNegative(node.op)
            let words = values.isEmpty
                ? "\(ruleFieldLabel(node.field)) \(ruleOpLabel(field: node.field, op: node.op))"
                : "\(ruleFieldLabel(node.field)) \(values.joined(separator: ", "))"
            return negative ? "not \(words)" : words
        }
        guard !parts.isEmpty else { return nil }
        let joined = parts.joined(separator: group.match == "all" ? " and " : " or ")
        if group.match == "none" { return "not ( \(joined) )" }
        return top || parts.count == 1 ? joined : "( \(joined) )"
    }
}
