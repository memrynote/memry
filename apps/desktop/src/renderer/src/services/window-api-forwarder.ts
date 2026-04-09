export function createWindowApiForwarder<T extends object>(selectApi: () => T): T {
  return new Proxy({} as T, {
    get(_target, property, receiver) {
      return Reflect.get(selectApi(), property, receiver)
    },
    has(_target, property) {
      return property in selectApi()
    }
  })
}
