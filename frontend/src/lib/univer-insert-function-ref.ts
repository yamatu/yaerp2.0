import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, DOCS_NORMAL_EDITOR_UNIT_ID_KEY, ICommandService, IContextService } from '@univerjs/core'
import { IEditorService } from '@univerjs/docs-ui'
import { REF_SELECTIONS_ENABLED } from '@univerjs/sheets'

/**
 * The toolbar functions (求和, 平均值, ...) open the cell editor with a guessed
 * range, e.g. `=SUM(A2:A6`. Univer only lets the mouse pick references once the
 * user has typed into a reference slot (`(`, `,`, an operator); a formula that
 * was written programmatically never unlocks it, so clicking or dragging cells
 * committed the guessed formula instead of replacing its range, and Ctrl+click
 * could not add more cells.
 *
 * Writing the draft as `=SUM(` first (the slot that unlocks picking) and then
 * restoring the guessed range puts the editor into the same state as if the
 * user had picked that range: a click or drag replaces it, Ctrl+click adds.
 */

const INSERT_FUNCTION_OPERATION = 'formula-ui.operation.insert-function'
const SETTLE_FRAMES = 2
const MAX_FRAMES = 30
const SUGGESTED_FORMULA = /^(=[A-Za-z_][\w.]*\()(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/

type Injector = { get: <T>(token: unknown) => T }

interface EditorLike {
  replaceText: (text: string, resetCursor?: boolean) => void
  getDocumentDataModel?: () => { getBody?: () => { dataStream?: string } | null | undefined } | null | undefined
}

function draftText(editor: EditorLike | null | undefined) {
  const stream = editor?.getDocumentDataModel?.()?.getBody?.()?.dataStream ?? ''
  return stream.replace(/[\r\n]+$/, '')
}

export function registerInsertFunctionRefPicking(univer: unknown): { dispose: () => void } | null {
  const injector = (univer as { __getInjector?: () => Injector } | null)?.__getInjector?.()
  if (!injector) return null
  let commandService: ICommandService
  let contextService: IContextService
  let editorService: IEditorService
  try {
    commandService = injector.get<ICommandService>(ICommandService)
    contextService = injector.get<IContextService>(IContextService)
    editorService = injector.get<IEditorService>(IEditorService)
  } catch {
    return null
  }

  let frame: number | null = null
  let run = 0
  const editors = () => ({
    cell: editorService.getEditor(DOCS_NORMAL_EDITOR_UNIT_ID_KEY) as unknown as EditorLike | undefined,
    bar: editorService.getEditor(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY) as unknown as EditorLike | undefined,
  })
  const write = (text: string) => {
    const { cell, bar } = editors()
    cell?.replaceText(text)
    bar?.replaceText(text, false)
  }
  const picking = () => Boolean(contextService.getContextValue(REF_SELECTIONS_ENABLED))
  const everyFrame = (id: number, step: (frameIndex: number) => boolean) => {
    let index = 0
    const tick = () => {
      frame = null
      if (id !== run) return
      if (step(index++)) frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
  }

  // The editor re-renders its highlighting from the text it saw in the
  // previous React pass, which writes stale text back; every step waits for
  // the editor to settle and re-checks the draft.
  const unlock = (formula: string, prefix: string) => {
    const id = ++run
    write(prefix)
    let settled = 0
    everyFrame(id, (index) => {
      const text = draftText(editors().cell)
      if (text !== prefix && text !== formula) return false
      settled = picking() && text === prefix ? settled + 1 : 0
      if (settled < SETTLE_FRAMES) return index < MAX_FRAMES
      write(formula)
      let stable = 0
      everyFrame(id, (restoreIndex) => {
        const current = draftText(editors().cell)
        if (current === prefix) {
          write(formula)
          stable = 0
        } else if (current === formula) {
          stable += 1
        } else {
          return false
        }
        return stable < SETTLE_FRAMES && restoreIndex < MAX_FRAMES
      })
      return false
    })
  }

  const subscription = commandService.onCommandExecuted((command) => {
    if (command.id !== INSERT_FUNCTION_OPERATION) return
    const formula = draftText(editors().cell)
    const match = SUGGESTED_FORMULA.exec(formula)
    if (match) unlock(formula, match[1])
  })

  return {
    dispose: () => {
      run += 1
      subscription.dispose()
      if (frame !== null) window.cancelAnimationFrame(frame)
    },
  }
}
