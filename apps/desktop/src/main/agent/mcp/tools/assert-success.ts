export function assertSuccess(
  result: { success: boolean; error?: string },
  fallback: string
): void {
  if (!result.success) {
    throw new Error(result.error ?? fallback)
  }
}
