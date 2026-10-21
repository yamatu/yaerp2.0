import { IRenderManagerService } from '@univerjs/engine-render'
import { SheetRenderController } from '@univerjs/sheets-ui'

const EDITOR_TEXT_MUTATION = 'doc.mutation.rich-text-editing'
const RETRY_INTERVAL_MS = 100
const MAX_ATTEMPTS = 100

interface MutationLike {
  id?: string
  params?: { unitId?: unknown } | null
}

interface RenderControllerLike {
  _markUnitDirty?: (command: MutationLike) => void
}

/**
 * Univer's sheet render controller repaints every visible cell after *any*
 * mutation, including the text mutations of its own cell editor and formula
 * bar documents. Those run on every selection move and twice per keystroke
 * while typing, so each one cost a full sheet repaint although no cell
 * changed. Text mutations of another document are skipped here; everything
 * that touches the workbook still repaints as before.
 *
 * The render unit is created after the workbook, hence the short retry.
 */
export function skipEditorTextRepaints(univer: unknown, unitId: string): { dispose: () => void } {
  let restore: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  let disposed = false

  const install = (): boolean => {
    const injector = (univer as { __getInjector?: () => { get: <T>(token: unknown) => T } } | null)?.__getInjector?.()
    const renderManager = injector?.get<IRenderManagerService | undefined>(IRenderManagerService)
    const controller = renderManager?.getRenderUnitById(unitId)?.with(SheetRenderController) as unknown as RenderControllerLike | undefined
    const original = controller?._markUnitDirty
    if (!controller || typeof original !== 'function') return false
    const patched = function patchedMarkUnitDirty(this: RenderControllerLike, command: MutationLike) {
      const target = command?.params?.unitId
      if (command?.id === EDITOR_TEXT_MUTATION && typeof target === 'string' && target !== unitId) return
      original.call(this, command)
    }
    controller._markUnitDirty = patched
    restore = () => {
      if (controller._markUnitDirty === patched) controller._markUnitDirty = original
    }
    return true
  }

  const attempt = () => {
    timer = null
    if (disposed) return
    let installed = false
    try {
      installed = install()
    } catch {
      installed = false
    }
    if (installed) return
    attempts += 1
    if (attempts >= MAX_ATTEMPTS) {
      console.warn('The editor repaint filter could not be installed; the sheet keeps the default repaint behaviour.')
      return
    }
    timer = setTimeout(attempt, RETRY_INTERVAL_MS)
  }
  attempt()

  return {
    dispose: () => {
      disposed = true
      if (timer) clearTimeout(timer)
      restore?.()
    },
  }
}
