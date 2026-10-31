/**
 * `window.api.<domain>` resolved at each access. `ported` holds the methods a step moved to
 * Rust commands: they win, and every other name still reaches `window.api`, the not-ported
 * shim included, so an unported call rejects there instead of reading as `undefined`.
 */
export function createWindowApiForwarder<T extends object, P extends keyof T = never>(
  selectApi: () => Omit<T, P>,
  ported?: Pick<T, P>
): T {
  const own: object = ported ?? {}
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the proxy target is never read; every trap forwards to `ported` or selectApi()
  return new Proxy({} as T, {
    get(_target, property) {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- a forwarding proxy resolves arbitrary property keys by definition
      if (Object.hasOwn(own, property)) return Reflect.get(own, property)
      // oxlint-disable-next-line anti-slop/no-reflect-get -- a forwarding proxy resolves arbitrary property keys by definition
      return Reflect.get(selectApi(), property)
    },
    has(_target, property) {
      return Object.hasOwn(own, property) || property in selectApi()
    },
    ownKeys() {
      return [...new Set([...Reflect.ownKeys(selectApi()), ...Reflect.ownKeys(own)])]
    },
    getOwnPropertyDescriptor(_target, property) {
      return (
        Reflect.getOwnPropertyDescriptor(own, property) ??
        Reflect.getOwnPropertyDescriptor(selectApi(), property)
      )
    }
  })
}
