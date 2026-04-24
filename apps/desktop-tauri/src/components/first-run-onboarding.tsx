import { useState, useCallback } from 'react'
import { Sparkles, FileText, CheckSquare, RefreshCw, ArrowRight, X } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { notesService } from '@/services/notes-service'
import { tasksService } from '@/services/tasks-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('FirstRunOnboarding')

interface FirstRunOnboardingProps {
  onComplete: () => void
}

type Step = 'welcome' | 'note' | 'task' | 'sync'

const STEPS: Step[] = ['welcome', 'note', 'task', 'sync']

export function FirstRunOnboarding({ onComplete }: FirstRunOnboardingProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('welcome')
  const [noteTitle, setNoteTitle] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const stepIndex = STEPS.indexOf(step)
  const progressPct = ((stepIndex + 1) / STEPS.length) * 100

  const advance = useCallback((): void => {
    const next = STEPS[stepIndex + 1]
    if (next) {
      setStep(next)
    } else {
      onComplete()
    }
  }, [stepIndex, onComplete])

  const handleCreateNote = useCallback(async (): Promise<void> => {
    const title = noteTitle.trim() || 'My first note'
    setIsSubmitting(true)
    try {
      await notesService.create({ title, content: '' })
    } catch (err) {
      log.warn('Failed to create onboarding note:', err)
    } finally {
      setIsSubmitting(false)
      advance()
    }
  }, [noteTitle, advance])

  const handleCreateTask = useCallback(async (): Promise<void> => {
    const title = taskTitle.trim() || 'My first task'
    setIsSubmitting(true)
    try {
      // Resolve a real project ID — use the first existing project, or create a default one
      const listResult = await tasksService.listProjects()
      let projectId: string
      if (listResult.projects.length > 0) {
        projectId = listResult.projects[0].id
      } else {
        const created = await tasksService.createProject({ name: 'Personal', color: '#6366f1' })
        if (!created.success || !created.project)
          throw new Error('Failed to create default project')
        projectId = created.project.id
      }
      await tasksService.create({ projectId, title })
    } catch (err) {
      log.warn('Failed to create onboarding task:', err)
    } finally {
      setIsSubmitting(false)
      advance()
    }
  }, [taskTitle, advance])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="relative w-full max-w-md mx-4 bg-background border border-border rounded-2xl shadow-2xl overflow-hidden">
        {/* Progress bar */}
        <div className="h-0.5 bg-muted">
          <div
            className="h-full bg-indigo-500 transition-all duration-500 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        {/* Skip / close */}
        <button
          onClick={onComplete}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Skip onboarding"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="p-8">
          {step === 'welcome' && <WelcomeStep onNext={advance} />}
          {step === 'note' && (
            <NoteStep
              value={noteTitle}
              onChange={setNoteTitle}
              onNext={handleCreateNote}
              onSkip={advance}
              isSubmitting={isSubmitting}
            />
          )}
          {step === 'task' && (
            <TaskStep
              value={taskTitle}
              onChange={setTaskTitle}
              onNext={handleCreateTask}
              onSkip={advance}
              isSubmitting={isSubmitting}
            />
          )}
          {step === 'sync' && <SyncStep onNext={onComplete} onSkip={onComplete} />}
        </div>

        {/* Step dots */}
        <div className="flex justify-center gap-1.5 pb-5">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`rounded-full transition-all duration-300 ${
                i === stepIndex
                  ? 'w-4 h-1.5 bg-indigo-500'
                  : i < stepIndex
                    ? 'w-1.5 h-1.5 bg-indigo-300'
                    : 'w-1.5 h-1.5 bg-muted-foreground/30'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function WelcomeStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  return (
    <div className="text-center space-y-6">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-500/10 text-indigo-500">
        <Sparkles className="w-7 h-7" />
      </div>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">Welcome to Memry</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Your personal knowledge base. Let's take 2 minutes to get you started.
        </p>
      </div>
      <Button onClick={onNext} className="w-full bg-indigo-500 hover:bg-indigo-600 text-white">
        Get started <ArrowRight className="w-4 h-4 ml-2" />
      </Button>
    </div>
  )
}

function NoteStep({
  value,
  onChange,
  onNext,
  onSkip,
  isSubmitting
}: {
  value: string
  onChange: (v: string) => void
  onNext: () => void
  onSkip: () => void
  isSubmitting: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-tint-lighter text-tint shrink-0">
          <FileText className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Create your first note</h2>
          <p className="text-xs text-muted-foreground">
            Markdown-based, stored locally as plain files.
          </p>
        </div>
      </div>
      <Input
        placeholder="e.g. Meeting notes, ideas, anything..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void onNext()
        }}
        autoFocus
      />
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onSkip} className="text-muted-foreground">
          Skip
        </Button>
        <Button
          onClick={() => void onNext()}
          disabled={isSubmitting}
          className="flex-1 bg-indigo-500 hover:bg-indigo-600 text-white"
        >
          Create note <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  )
}

function TaskStep({
  value,
  onChange,
  onNext,
  onSkip,
  isSubmitting
}: {
  value: string
  onChange: (v: string) => void
  onNext: () => void
  onSkip: () => void
  isSubmitting: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-500 shrink-0">
          <CheckSquare className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Add your first task</h2>
          <p className="text-xs text-muted-foreground">
            Tasks link to your notes, with priorities and due dates.
          </p>
        </div>
      </div>
      <Input
        placeholder="e.g. Review project proposal..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void onNext()
        }}
        autoFocus
      />
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onSkip} className="text-muted-foreground">
          Skip
        </Button>
        <Button
          onClick={() => void onNext()}
          disabled={isSubmitting}
          className="flex-1 bg-indigo-500 hover:bg-indigo-600 text-white"
        >
          Create task <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  )
}

function SyncStep({
  onNext,
  onSkip
}: {
  onNext: () => void
  onSkip: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-violet-500/10 text-violet-500 shrink-0">
          <RefreshCw className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Sync across devices</h2>
          <p className="text-xs text-muted-foreground">
            End-to-end encrypted. Set up later in Settings → Sync.
          </p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Keep your notes and tasks in sync across all your devices. You can always set this up later.
      </p>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onSkip} className="text-muted-foreground">
          Skip for now
        </Button>
        <Button onClick={onNext} className="flex-1 bg-indigo-500 hover:bg-indigo-600 text-white">
          Done — let's go! <Sparkles className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  )
}
