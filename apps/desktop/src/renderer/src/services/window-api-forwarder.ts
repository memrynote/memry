export function createWindowApiForwarder<T extends object>(selectApi: () => T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the proxy target is never read; every trap forwards to selectApi()
  return new Proxy({} as T, {
    get(_target, property) {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- a forwarding proxy resolves arbitrary property keys by definition
      return Reflect.get(selectApi(), property)
    },
    has(_target, property) {
      return property in selectApi()
    },
    ownKeys() {
      return Reflect.ownKeys(selectApi())
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(selectApi(), property)
    }
  })
}
