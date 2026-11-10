import Foundation

// The advanced filter's rule tree (docs/protocol §13.7.14), as the builder
// edits it. The core evaluates the tree (`TaskFilters::from_json`); this file
// only holds and edits it.
//
// **Lossless.** A node is the JSON another build wrote, and the accessors read
// and write single keys of it. A rule from a newer build, a key this build does
// not know, or a value of another type survives an edit of its neighbours and
// goes back to the core and to sync as it came.

/// A JSON value kept as written.
enum FilterJSON: Codable, Equatable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([FilterJSON])
    case object([String: FilterJSON])

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([FilterJSON].self) {
            self = .array(value)
        } else {
            self = try .object(container.decode([String: FilterJSON].self))
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case .null: try container.encodeNil()
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }

    var string: String? {
        if case let .string(value) = self { value } else { nil }
    }

    var object: [String: FilterJSON]? {
        if case let .object(value) = self { value } else { nil }
    }

    /// The string entries of an array; anything else reads as none.
    var strings: [String] {
        if case let .array(items) = self { items.compactMap(\.string) } else { [] }
    }

    static func strings(_ list: [String]) -> FilterJSON { .array(list.map(FilterJSON.string)) }

    static func decode(_ json: String?) -> FilterJSON? {
        guard let json, !json.isEmpty else { return nil }
        return try? JSONDecoder().decode(FilterJSON.self, from: Data(json.utf8))
    }

    var json: String {
        (try? JSONEncoder().encode(self)).flatMap { String(bytes: $0, encoding: .utf8) } ?? "null"
    }
}

/// A group (`match` + `rules`) or a rule (`field` + `op` + values).
struct TaskFilterNode: Codable, Equatable, Sendable {
    var json: FilterJSON

    init(json: FilterJSON) { self.json = json }

    init(from decoder: any Decoder) throws { json = try FilterJSON(from: decoder) }

    func encode(to encoder: any Encoder) throws { try json.encode(to: encoder) }

    private subscript(key: String) -> FilterJSON? {
        get { json.object?[key] }
        set {
            guard var object = json.object else { return }
            object[key] = newValue
            json = .object(object)
        }
    }

    var isGroup: Bool { self["match"] != nil }

    /// `all`, `any`, `none`, or a newer build's value (the core skips that group).
    var match: String {
        get { self["match"]?.string ?? "" }
        set { self["match"] = .string(newValue) }
    }

    var rules: [TaskFilterNode] {
        get {
            if case let .array(items) = self["rules"] { items.map(TaskFilterNode.init(json:)) } else { [] }
        }
        set { self["rules"] = .array(newValue.map(\.json)) }
    }

    var field: String { self["field"]?.string ?? "" }

    var op: String {
        get { self["op"]?.string ?? "" }
        set { self["op"] = .string(newValue) }
    }

    var values: [String] {
        get { self["values"]?.strings ?? [] }
        set { self["values"] = .strings(newValue) }
    }

    var folderPaths: [String] { self["folderPaths"]?.strings ?? [] }
    var noteIds: [String] { self["noteIds"]?.strings ?? [] }

    /// A custom due range's `YYYY-MM-DD` ends.
    var dueStart: String? {
        get { self["dueStart"]?.string }
        set { self["dueStart"] = newValue.map(FilterJSON.string) ?? .null }
    }

    var dueEnd: String? {
        get { self["dueEnd"]?.string }
        set { self["dueEnd"] = newValue.map(FilterJSON.string) ?? .null }
    }

    /// Whether this build's builder can edit the rule.
    var isKnownRule: Bool { TaskFilterRuleVocabulary.ops[field] != nil }

    static func group(_ match: String, _ rules: [TaskFilterNode] = []) -> TaskFilterNode {
        TaskFilterNode(json: .object(["match": .string(match), "rules": .array(rules.map(\.json))]))
    }

    /// A blank rule for `field`, as desktop's `newRule` makes it.
    static func rule(_ field: String) -> TaskFilterNode {
        var object: [String: FilterJSON] = ["field": .string(field)]
        switch field {
        case "location":
            object["op"] = .string("any")
            object["folderPaths"] = .array([])
            object["noteIds"] = .array([])
        case "due":
            object["op"] = .string("is")
            object["values"] = .array([])
        case "repeat":
            object["op"] = .string("is")
            object["values"] = .strings(["repeating"])
        case "hasTime":
            object["op"] = .string("is")
            object["values"] = .strings(["with-time"])
        case "title":
            object["op"] = .string("contains")
            object["values"] = .array([])
        default:
            object["op"] = .string("any")
            object["values"] = .array([])
        }
        return TaskFilterNode(json: .object(object))
    }

    static func rule(_ field: String, op: String, values: [String]) -> TaskFilterNode {
        var node = rule(field)
        node.op = op
        node.values = values
        return node
    }

    // MARK: Tree edits, by index path from the root group

    /// The tree with the node at `path` replaced, or removed when `update` returns nil.
    func updating(at path: [Int], _ update: (TaskFilterNode) -> TaskFilterNode?) -> TaskFilterNode? {
        guard let index = path.first else { return update(self) }
        var children = rules
        guard children.indices.contains(index) else { return self }
        let rest = Array(path.dropFirst())
        if let next = rest.isEmpty ? update(children[index]) : children[index].updating(at: rest, update) {
            children[index] = next
        } else {
            children.remove(at: index)
        }
        var copy = self
        copy.rules = children
        return copy
    }

    func appending(_ node: TaskFilterNode, at groupPath: [Int]) -> TaskFilterNode {
        updating(at: groupPath) { group in
            var copy = group
            copy.rules.append(node)
            return copy
        } ?? self
    }
}

/// The fields and operators the builder offers, in desktop's order
/// (`task-filter-rules.ts` `RULE_FIELDS`, `RULE_OPS`).
enum TaskFilterRuleVocabulary {
    static let fields = ["title", "status", "priority", "due", "project", "location", "tags", "repeat", "hasTime"]
    static let matches = ["all", "any", "none"]
    static let ops: [String: [String]] = [
        "title": ["contains", "notContains"],
        "status": ["any", "none"],
        "priority": ["any", "none"],
        "due": ["is", "isNot"],
        "project": ["any", "none"],
        "location": ["any", "none"],
        "tags": ["any", "all", "none", "empty", "notEmpty"],
        "repeat": ["is"],
        "hasTime": ["is"]
    ]

    static func isNegative(_ op: String) -> Bool { ["notContains", "none", "isNot"].contains(op) }
    static func isValueless(_ op: String) -> Bool { op == "empty" || op == "notEmpty" }

    /// Due presets, then `custom`.
    static let dueValues = ["overdue", "today", "tomorrow", "this-week", "next-week", "this-month", "none", "custom"]
}

extension TaskFilterSpec {
    /// Desktop's `seedExpressionFromFilters`: the chip dimensions as rules, and
    /// the spec with those chips cleared, so opening the builder keeps the list
    /// as it was. Search and completion stay chips.
    func seededWithRules() -> TaskFilterSpec {
        var rules: [TaskFilterNode] = []
        if !statusIds.isEmpty { rules.append(.rule("status", op: "any", values: statusIds)) }
        if !priorities.isEmpty { rules.append(.rule("priority", op: "any", values: priorities)) }
        if dueDate.type == "custom", let start = dueDate.customStart, let end = dueDate.customEnd,
           let first = TaskFilterOptions.parseDate(start), let last = TaskFilterOptions.parseDate(end) {
            var due = TaskFilterNode.rule("due", op: "is", values: ["custom"])
            due.dueStart = TaskDates.key(first)
            due.dueEnd = TaskDates.key(last)
            rules.append(due)
        } else if dueDate.type != "any", dueDate.type != "custom" {
            rules.append(.rule("due", op: "is", values: [dueDate.type]))
        }
        if !projectIds.isEmpty { rules.append(.rule("project", op: "any", values: projectIds)) }
        if !tags.isEmpty { rules.append(.rule("tags", op: "any", values: tags)) }
        if repeatType != "all" { rules.append(.rule("repeat", op: "is", values: [repeatType])) }
        if hasTime != "all" { rules.append(.rule("hasTime", op: "is", values: [hasTime])) }

        var root = TaskFilterNode.group("all", rules)
        if let existing = expression {
            root.rules += existing.match == "all" ? existing.rules : [existing]
        }
        var spec = self
        spec.statusIds = []
        spec.priorities = []
        spec.dueDate = DueDateFilterSpec()
        spec.projectIds = []
        spec.tags = []
        spec.repeatType = "all"
        spec.hasTime = "all"
        spec.expression = root.rules.isEmpty ? nil : root
        return spec
    }
}
