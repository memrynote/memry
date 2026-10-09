/** Throws the owner's error, or `fallback`, when an owner call reports failure. */
export function assertSuccess(
  result: { success: boolean; error?: string },
  fallback: string
): void {
  if (!result.success) {
    throw new Error(result.error ?? fallback)
  }
}
