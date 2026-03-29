export function extractError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export type MutationResult<T extends Record<string, unknown> = Record<string, never>> =
  | ({ success: true } & T)
  | ({ success: false; error: string } & { [K in keyof T]?: null })
