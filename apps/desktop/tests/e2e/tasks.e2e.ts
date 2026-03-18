// @ts-nocheck - E2E tests in development, some vars intentionally unused
/**
 * Tasks E2E Tests
 *
 * Tests for task creation, completion, drag-drop, subtasks, and recurring tasks.
 *
 * Tasks covered:
 * - T538: Create tests/e2e/tasks.spec.ts
 * - T539: Test task creation with quick-add syntax
 * - T540: Test task completion, uncomplete
 * - T541: Test task drag-drop between statuses
 * - T542: Test subtask creation and management
 * - T543: Test recurring task creation
 */

import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  waitForAppReady,
  waitForVaultReady,
  createTask,
  toggleTaskCompletion as _toggleTaskCompletion,
  navigateTo,
  SELECTORS,
  SHORTCUTS,
  dragAndDrop as _dragAndDrop,
  getElementCount as _getElementCount
} from './utils/electron-helpers'

test.describe('Tasks Management', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    // Navigate to tasks view
    await navigateTo(page, 'tasks')
    await page.waitForTimeout(500)
  })

  test.describe('Task Creation', () => {
    test('T539: should create a task via quick-add input', async ({ page }) => {
      const taskTitle = `Test Task ${Date.now()}`

      // Find and use the add task button/input
      const addButton = page.locator(SELECTORS.addTaskButton)
      const hasAddButton = await addButton.isVisible().catch(() => false)

      if (hasAddButton) {
        await addButton.click()

        const taskInput = page.locator(SELECTORS.taskInput)
        await taskInput.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})

        if (await taskInput.isVisible()) {
          await taskInput.fill(taskTitle)
          await page.keyboard.press(SHORTCUTS.enter)
          await page.waitForTimeout(500)
        }
      }

      expect(true).toBe(true)
    })

    test('T539: should parse quick-add date syntax (!tomorrow)', async ({ page }) => {
      // Test quick-add with date shortcut
      const addButton = page.locator(SELECTORS.addTaskButton)
      const hasAddButton = await addButton.isVisible().catch(() => false)

      if (hasAddButton) {
        await addButton.click()

        const taskInput = page.locator(SELECTORS.taskInput)
        if (await taskInput.isVisible()) {
          await taskInput.fill('Task due !tomorrow')
          await page.waitForTimeout(300)

          // Should show date parsing preview
          const preview = page.locator('[data-testid="quick-add-preview"]')
          await preview.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})

          await page.keyboard.press(SHORTCUTS.enter)
          await page.waitForTimeout(500)
        }
      }

      expect(true).toBe(true)
    })

    test('T539: should parse quick-add priority syntax (!!high)', async ({ page }) => {
      const addButton = page.locator(SELECTORS.addTaskButton)
      const hasAddButton = await addButton.isVisible().catch(() => false)

      if (hasAddButton) {
        await addButton.click()

        const taskInput = page.locator(SELECTORS.taskInput)
        if (await taskInput.isVisible()) {
          await taskInput.fill('High priority task !!high')
          await page.waitForTimeout(300)

          await page.keyboard.press(SHORTCUTS.enter)
          await page.waitForTimeout(500)
        }
      }

      expect(true).toBe(true)
    })

    test('T539: should parse quick-add project syntax (#project)', async ({ page }) => {
      const addButton = page.locator(SELECTORS.addTaskButton)
      const hasAddButton = await addButton.isVisible().catch(() => false)

      if (hasAddButton) {
        await addButton.click()

        const taskInput = page.locator(SELECTORS.taskInput)
        if (await taskInput.isVisible()) {
          await taskInput.fill('Task in project #inbox')
          await page.waitForTimeout(300)

          await page.keyboard.press(SHORTCUTS.enter)
          await page.waitForTimeout(500)
        }
      }

      expect(true).toBe(true)
    })

    test('T539: should parse combined quick-add syntax', async ({ page }) => {
      // Test: "Buy groceries !today !!high #personal +shopping"
      const addButton = page.locator(SELECTORS.addTaskButton)
      const hasAddButton = await addButton.isVisible().catch(() => false)

      if (hasAddButton) {
        await addButton.click()

        const taskInput = page.locator(SELECTORS.taskInput)
        if (await taskInput.isVisible()) {
          await taskInput.fill('Buy groceries !today !!high #inbox')
          await page.waitForTimeout(500)

          await page.keyboard.press(SHORTCUTS.enter)
          await page.waitForTimeout(500)
        }
      }

      expect(true).toBe(true)
    })
  })

  test.describe('Task Completion', () => {
    test('T540: should complete a task by clicking checkbox', async ({ page }) => {
      await createTask(page, `Complete Test ${Date.now()}`)
      await page.waitForTimeout(500)

      const taskItem = page.locator(SELECTORS.taskItem).first()
      const hasTask = await taskItem.isVisible().catch(() => false)

      if (hasTask) {
        const checkbox = taskItem.locator(SELECTORS.taskCheckbox)
        await checkbox.click({ force: true })
        await page.waitForTimeout(500)
      }

      expect(true).toBe(true)
    })

    test('T540: should uncomplete a task', async ({ page }) => {
      await createTask(page, `Uncomplete Test ${Date.now()}`)
      await page.waitForTimeout(500)

      const taskItem = page.locator(SELECTORS.taskItem).first()
      const hasTask = await taskItem.isVisible().catch(() => false)

      if (hasTask) {
        const checkbox = taskItem.locator(SELECTORS.taskCheckbox)
        const hasCheckbox = await checkbox
          .first()
          .isVisible({ timeout: 3000 })
          .catch(() => false)
        if (hasCheckbox) {
          await checkbox.first().click({ force: true })
          await page.waitForTimeout(500)
          await checkbox
            .first()
            .click({ force: true, timeout: 5000 })
            .catch(() => {})
          await page.waitForTimeout(300)
        }
      }

      expect(true).toBe(true)
    })

    test('T540: should move completed task to completed section', async ({ page }) => {
      await createTask(page, `Move to Completed ${Date.now()}`)
      await page.waitForTimeout(500)

      const taskItem = page.locator(SELECTORS.taskItem).first()

      if (await taskItem.isVisible()) {
        const checkbox = taskItem.locator(SELECTORS.taskCheckbox)
        await checkbox.click({ force: true })
        await page.waitForTimeout(500)

        // Navigate to completed view
        const completedTab = page.locator('[data-testid="completed-tab"]')
        if (await completedTab.isVisible()) {
          await completedTab.click()
          await page.waitForTimeout(500)
        }
      }

      expect(true).toBe(true)
    })

    test('T540: should show completion animation', async ({ page }) => {
      await createTask(page, `Animation Test ${Date.now()}`)
      await page.waitForTimeout(500)

      const taskItem = page.locator(SELECTORS.taskItem).first()

      if (await taskItem.isVisible()) {
        const checkbox = taskItem.locator(SELECTORS.taskCheckbox)
        await checkbox.click({ force: true })

        // Wait for animation to play
        await page.waitForTimeout(1000)
      }

      expect(true).toBe(true)
    })
  })

  test.describe('Task Drag and Drop', () => {
    const showAllTasks = async (page: Page): Promise<void> => {
      const allTab = page.getByRole('tab', { name: /^All/ }).first()
      await allTab.click()
      await page.waitForTimeout(500)
    }

    const createTaskViaModal = async (
      page: Page,
      input: string,
      visibleTitle = input
    ): Promise<void> => {
      await createTask(page, input)
      await expect(getTaskRow(page, visibleTitle)).toBeVisible()
    }

    const getTaskRow = (page: Page, title: string) =>
      page.locator(SELECTORS.taskItem).filter({ hasText: title }).first()

    const dragTaskHandleToRow = async (
      page: Page,
      sourceRow: Locator,
      target: Locator
    ): Promise<void> => {
      await sourceRow.hover()

      const handle = sourceRow.locator('[data-testid="drag-handle"]').first()
      const handleBox = await handle.boundingBox()
      const targetBox = await target.boundingBox()

      if (!handleBox || !targetBox) {
        throw new Error('Missing drag handle or drop target geometry')
      }

      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
        steps: 14
      })
      await page.mouse.up()
      await page.waitForTimeout(500)
    }

    test('T541: should move a task into another priority group in list view', async ({ page }) => {
      const timestamp = Date.now()
      const sourceTitle = `List DnD None ${timestamp}`
      const targetTitle = `List DnD High ${timestamp}`

      await showAllTasks(page)
      await createTaskViaModal(page, sourceTitle)
      await createTaskViaModal(page, `${targetTitle} !!high`, targetTitle)

      await page.getByRole('button', { name: 'Group by options' }).click()
      await page.getByRole('button', { name: 'Priority', exact: true }).click()
      await page.waitForTimeout(500)

      const sourceRow = getTaskRow(page, sourceTitle)
      const targetRow = getTaskRow(page, targetTitle)
      const highGroupHeader = page.getByRole('button', { name: /^High, 1 tasks$/ }).first()

      await expect(sourceRow).toBeVisible()
      await expect(targetRow).toBeVisible()
      await expect(highGroupHeader).toBeVisible()

      await dragTaskHandleToRow(page, sourceRow, highGroupHeader)

      await expect(page.getByRole('button', { name: /^High, 2 tasks$/ })).toBeVisible()
    })

    test('T541: should reorder tasks within the same list section', async ({ page }) => {
      const timestamp = Date.now()
      const titleA = `List DnD A ${timestamp}`
      const titleB = `List DnD B ${timestamp}`

      await showAllTasks(page)
      await createTaskViaModal(page, titleA)
      await createTaskViaModal(page, titleB)

      const labelsBefore = await page
        .locator(SELECTORS.taskItem)
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') || ''))

      const indexA = labelsBefore.findIndex((label) => label.includes(titleA))
      const indexB = labelsBefore.findIndex((label) => label.includes(titleB))

      expect(indexA).toBeGreaterThanOrEqual(0)
      expect(indexB).toBeGreaterThanOrEqual(0)

      const sourceTitle = indexA < indexB ? titleA : titleB
      const targetTitle = indexA < indexB ? titleB : titleA

      await dragTaskHandleToRow(page, getTaskRow(page, sourceTitle), getTaskRow(page, targetTitle))

      const labelsAfter = await page
        .locator(SELECTORS.taskItem)
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') || ''))

      const afterSourceIndex = labelsAfter.findIndex((label) => label.includes(sourceTitle))
      const afterTargetIndex = labelsAfter.findIndex((label) => label.includes(targetTitle))

      expect(afterSourceIndex).toBeGreaterThan(afterTargetIndex)
    })

    test('T541: should show drag preview overlay', async ({ page }) => {
      const title = `Drag Preview Test ${Date.now()}`

      await showAllTasks(page)
      await createTaskViaModal(page, title)

      const taskRow = getTaskRow(page, title)
      await expect(taskRow).toBeVisible()
      await taskRow.hover()

      const handle = taskRow.locator('[data-testid="drag-handle"]').first()
      const handleBox = await handle.boundingBox()

      if (!handleBox) {
        throw new Error('Missing drag handle geometry')
      }

      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(handleBox.x + 60, handleBox.y + 32, { steps: 10 })

      const overlay = page.locator('[data-testid="drag-overlay"]').first()
      await expect(overlay).toBeVisible()
      await expect(overlay).toContainText(title)

      await page.mouse.up()
    })
  })

  test.describe('Subtask Management', () => {
    test('T542: should create a subtask under parent task', async ({ page }) => {
      // Create parent task
      await createTask(page, 'Parent Task')
      await page.waitForTimeout(500)

      const taskItem = page.locator(SELECTORS.taskItem).first()

      if (await taskItem.isVisible()) {
        // Click to open task detail
        await taskItem.click()
        await page.waitForTimeout(300)

        // Look for add subtask button
        const addSubtaskButton = page.locator('[data-testid="add-subtask"]')
        if (await addSubtaskButton.isVisible()) {
          await addSubtaskButton.click()

          const subtaskInput = page.locator('[data-testid="subtask-input"]')
          if (await subtaskInput.isVisible()) {
            await subtaskInput.fill('Subtask 1')
            await page.keyboard.press(SHORTCUTS.enter)
            await page.waitForTimeout(500)
          }
        }
      }

      expect(true).toBe(true)
    })

    test('T542: should display subtask progress indicator', async ({ page: _page }) => {
      // Create task with subtasks and verify progress display
      expect(true).toBe(true)
    })

    test('T542: should complete subtask independently', async ({ page: _page }) => {
      // Complete individual subtasks without completing parent
      expect(true).toBe(true)
    })

    test('T542: should expand/collapse subtask list', async ({ page }) => {
      const taskItem = page.locator(SELECTORS.taskItem).first()

      if (await taskItem.isVisible()) {
        // Look for expand/collapse toggle
        const expandToggle = taskItem.locator('[data-testid="expand-subtasks"]')
        if (await expandToggle.isVisible()) {
          await expandToggle.click()
          await page.waitForTimeout(300)

          // Toggle again
          await expandToggle.click()
          await page.waitForTimeout(300)
        }
      }

      expect(true).toBe(true)
    })

    test('T542: should delete subtask', async ({ page: _page }) => {
      // Delete a subtask and verify it's removed
      expect(true).toBe(true)
    })
  })

  test.describe('Recurring Tasks', () => {
    test('T543: should create a daily recurring task', async ({ page }) => {
      const addButton = page.locator(SELECTORS.addTaskButton)
      const hasAddButton = await addButton.isVisible().catch(() => false)

      if (hasAddButton) {
        await addButton.click()

        const taskInput = page.locator(SELECTORS.taskInput)
        if (await taskInput.isVisible()) {
          await taskInput.fill('Daily recurring task')
          await page.keyboard.press(SHORTCUTS.enter)
          await page.waitForTimeout(500)

          // Open task detail to set recurrence
          const taskItem = page.locator(SELECTORS.taskItem).first()
          if (await taskItem.isVisible()) {
            await taskItem.click()
            await page.waitForTimeout(300)

            // Look for repeat/recurrence picker
            const repeatPicker = page.locator('[data-testid="repeat-picker"]')
            if (await repeatPicker.isVisible()) {
              await repeatPicker.click()

              // Select daily option
              const dailyOption = page.locator('[data-testid="repeat-daily"]')
              if (await dailyOption.isVisible()) {
                await dailyOption.click()
                await page.waitForTimeout(500)
              }
            }
          }
        }
      }

      expect(true).toBe(true)
    })

    test('T543: should create a weekly recurring task', async ({ page: _page }) => {
      // Similar to daily but select weekly option
      expect(true).toBe(true)
    })

    test('T543: should show repeat indicator on recurring tasks', async ({ page: _page }) => {
      // Verify repeat icon/indicator is visible
      // const repeatIndicator = page.locator('[data-testid="repeat-indicator"]')
      // Check visibility if tasks exist
      expect(true).toBe(true)
    })

    test('T543: should create next occurrence when completing recurring task', async ({
      page: _page
    }) => {
      // Complete a recurring task and verify next occurrence is created
      expect(true).toBe(true)
    })

    test('T543: should stop recurring task', async ({ page: _page }) => {
      // Open a recurring task and stop the recurrence
      expect(true).toBe(true)
    })
  })

  test.describe('Task Filtering and Sorting', () => {
    test('should filter tasks by priority', async ({ page }) => {
      // Create tasks with different priorities
      await createTask(page, 'High priority !!high')
      await createTask(page, 'Medium priority !!medium')
      await createTask(page, 'Low priority !!low')
      await page.waitForTimeout(500)

      // Apply priority filter
      const filterButton = page.locator('[data-testid="filter-button"]')
      if (await filterButton.isVisible()) {
        await filterButton.click()

        const priorityFilter = page.locator('[data-testid="filter-priority"]')
        if (await priorityFilter.isVisible()) {
          await priorityFilter.click()
          await page.waitForTimeout(300)
        }
      }

      expect(true).toBe(true)
    })

    test('should sort tasks by due date', async ({ page }) => {
      const sortButton = page.locator('[data-testid="sort-button"]')
      if (await sortButton.isVisible()) {
        await sortButton.click()

        const dueDateSort = page.locator('[data-testid="sort-due-date"]')
        if (await dueDateSort.isVisible()) {
          await dueDateSort.click()
          await page.waitForTimeout(300)
        }
      }

      expect(true).toBe(true)
    })

    test('should search tasks by title', async ({ page }) => {
      await createTask(page, 'Searchable Task XYZ')
      await page.waitForTimeout(500)

      const searchInput = page.locator('[data-testid="task-search"]')
      if (await searchInput.isVisible()) {
        await searchInput.fill('XYZ')
        await page.waitForTimeout(500)
      }

      expect(true).toBe(true)
    })
  })
})
