/**
 * Mock IPC router stub. Task 9 requires `mockRouter` to exist so the invoke
 * wrapper can compile. Task 10 replaces this stub with the full router that
 * delegates to domain route maps.
 */
export async function mockRouter<T>(cmd: string, _args?: unknown): Promise<T> {
  throw new Error(`Mock IPC: command "${cmd}" not implemented`)
}
