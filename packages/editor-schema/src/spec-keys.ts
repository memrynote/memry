/**
 * Registration key ≡ `config.type` (#1455).
 *
 * A BlockNote spec's ProseMirror node name is its `config.type`. The key it is
 * registered under is what BlockNote's own `blockSchema` / `inlineContentSchema`
 * ends up keyed by. Nothing in BlockNote forces the two to agree, and when they
 * disagree the failure is silent content loss that every guard we have reads as
 * healthy:
 *
 *   - ProseMirror CAN build `config.type`, so y-prosemirror does not delete the
 *     element out of the shared Y.Doc — the loud failure never happens
 *   - `findUnrepresentableNodes` asks the ProseMirror schema, finds the name,
 *     and returns `[]`, so the fail-closed write guard lets the write through
 *   - BlockNote cannot resolve the node against a schema keyed by the OTHER
 *     name, so it drops it while serializing
 *
 * Measured on the mis-keyed schema in the issue: `See [[Wiki Link]] for
 * details.` came back `See for details.` — 30 bytes to 16, written to the vault
 * with no error raised anywhere.
 *
 * So the invariant is made structural rather than gated: it is asserted once,
 * at construction, in every place this package assembles a spec map. That is
 * module scope in both processes, and never a serialization path — a mis-keyed
 * spec fails the schema build (and therefore every suite that builds one)
 * instead of quietly deleting text from someone's notes.
 */

/** A spec map as BlockNote takes it: registration key → spec. */
type SpecMap = Record<string, unknown>

/**
 * The ProseMirror node name a spec registers, or `null` when the value is not a
 * shape this package recognises.
 *
 * Two shapes are recognised, because BlockNote ships both: a spec object whose
 * `config.type` is the node name, and a bare string config — that is what
 * `defaultInlineContentSpecs` holds for `text` and `link`, and there the string
 * IS the node name, so those pass the check rather than skipping it.
 *
 * `null` deliberately does not throw. A dependency growing a third spec shape
 * must not stop the app from building a schema whose own specs are all correct;
 * every spec Memry ships is checked by name in the contract suite as well.
 */
function nodeTypeOf(spec: unknown): string | null {
  const config = (spec as { config?: unknown } | null | undefined)?.config
  if (typeof config === 'string') return config
  if (typeof config === 'object' && config !== null) {
    const { type } = config as { type?: unknown }
    if (typeof type === 'string') return type
  }
  return null
}

/**
 * Throws unless every spec in `specs` is registered under its own node name.
 *
 * `mapName` is the BlockNote option the map feeds (`blockSpecs` /
 * `inlineContentSpecs`) so the message points at something greppable.
 */
export function assertSpecKeysMatchNodeTypes(mapName: string, specs: SpecMap): void {
  for (const key of Object.keys(specs)) {
    const nodeType = nodeTypeOf(specs[key])
    if (nodeType === null || nodeType === key) continue

    throw new Error(
      `@memry/editor-schema: ${mapName}["${key}"] registers a spec whose config.type is "${nodeType}". ` +
        "A BlockNote spec's ProseMirror node name comes from config.type, not from the key it is " +
        `registered under, so this spec builds "${nodeType}" nodes that a schema keyed "${key}" cannot ` +
        'resolve when serializing: the node is dropped from the vault file, and findUnrepresentableNodes ' +
        'cannot see it because ProseMirror can still build the name (#1455). ' +
        `Register it as "${nodeType}", or set config.type to "${key}".`
    )
  }
}

/**
 * The same invariant in the type system, for the one map that is generic.
 *
 * `createMemrySchema` takes the renderer's block specs as a free-form
 * `BlockSpecs`, so a block registered under the wrong key type-checks today.
 * Intersecting the parameter with this maps a mis-keyed entry to `never`, which
 * makes the whole argument unassignable at the call site.
 *
 * It is a partial carry on purpose. A spec whose `config.type` is widened to
 * `string` — a shape BlockNote's own `BlockSpecs` allows — cannot be checked
 * here, so it falls through to the runtime assertion; that is why the runtime
 * assertion is the backstop and not the other way round. The inline half needs
 * none of this: `MemryInlineSpecs` names each spec's config by hand
 * (`InlineContentSpec<typeof wikiLinkConfig>`), which already binds key to
 * config.
 */
export type SpecKeysMatchNodeTypes<Specs> = {
  [Key in keyof Specs]: Specs[Key] extends { config: { type: infer NodeType } }
    ? [NodeType] extends [Key]
      ? Specs[Key]
      : never
    : Specs[Key]
}
