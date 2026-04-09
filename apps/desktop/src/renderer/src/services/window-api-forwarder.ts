export function createWindowApiForwarder<T extends object>(selectApi: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
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
