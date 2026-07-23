import type {
  TagCategoryRow,
  TagAssignment,
  CreateCategoryResponse,
  CategoryOperationResponse
} from '@/services/tags-service'

/**
 * Tag hub data hook.
 *
 * Placeholder module: Task 8 replaces this body with the real
 * implementation (tagsService.listCategories + the onTagCategoriesChanged
 * subscription, plus create/rename/delete/reorder mutations). It exists now
 * only so `TagsHubPage` (Task 7) has a real module to import — the page's
 * own test mocks this hook entirely, so nothing here is exercised yet.
 */
export interface UseTagCategoriesResult {
  categories: TagCategoryRow[]
  uncategorized: string[]
  isLoading: boolean
  error: string | null
  createCategory: (name: string) => Promise<CreateCategoryResponse>
  renameCategory: (id: string, name: string) => Promise<CategoryOperationResponse>
  deleteCategory: (id: string) => Promise<CategoryOperationResponse>
  createTag: (name: string) => Promise<void>
  reorder: (payload: {
    tags?: TagAssignment[]
    categories?: { id: string; sortOrder: number }[]
  }) => Promise<CategoryOperationResponse>
}

export function useTagCategories(): UseTagCategoriesResult {
  return {
    categories: [],
    uncategorized: [],
    isLoading: false,
    error: null,
    createCategory: () => Promise.resolve({ success: false }),
    renameCategory: () => Promise.resolve({ success: false }),
    deleteCategory: () => Promise.resolve({ success: false }),
    createTag: () => Promise.resolve(),
    reorder: () => Promise.resolve({ success: false })
  }
}

export default useTagCategories
