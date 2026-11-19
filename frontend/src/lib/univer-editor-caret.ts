import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY } from '@univerjs/core'
import { DocSelectionRenderService } from '@univerjs/docs-ui'
import { DeviceInputEventType, IRenderManagerService } from '@univerjs/engine-render'
import { IEditorBridgeService } from '@univerjs/sheets-ui'

/**
 * Single click on a cell opens Univer's cell editor and focuses its hidden
 * contentEditable input. Univer never touches the DOM selection of that input
 * (docs-ui has no getSelection call), so whatever selection the browser leaves
 * on the freshly focused element stays. On macOS that can be a non collapsed
 * selection, which shows up as the whole cell text being selected after one
 * click. Once the editor is open from a pointer press, the DOM selection of the
 * hidden input is collapsed to its start. Univer's own caret (a canvas drawn
 * range) is not changed.
 */

const RETRY_INTERVAL_MS = 100
const MAX_ATTEMPTS = 100

type Injector = { get: <T>(token: unknown) => T }

// `afterVisible$` exists on the implementation class but is missing from the
// `IEditorBridgeService` interface the injector token is typed with.
type EditorBridgeWithAfterVisible = IEditorBridgeService & {
  afterVisible$?: { subscribe: (next: (params: unknown) => void) => { unsubscribe: () => void } }
}

function collapseHiddenInputSelection(injector: Injector) {
  try {
    const render = injector.get<IRenderManagerService | undefined>(IRenderManagerService)?.getRenderUnitById(DOCS_NORMAL_EDITOR_UNIT_ID_KEY)
    const input = render?.with(DocSelectionRenderService)?.inputElement
    if (!input || input.ownerDocument.activeElement !== input) return
    const selection = input.ownerDocument.defaultView?.getSelection()
    if (!selection || selection.isCollapsed || !selection.anchorNode || !input.contains(selection.anchorNode)) return
    selection.collapse(input, 0)
  } catch {
    // never break the editor because of a cosmetic fix
  }
}

export function registerEditorCaretCollapse(univer: unknown): { dispose: () => void } {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  let unsubscribe: (() => void) | null = null

  const install = (): boolean => {
    const injector = (univer as { __getInjector?: () => Injector } | null)?.__getInjector?.()
    const bridge = injector?.get<EditorBridgeWithAfterVisible | undefined>(IEditorBridgeService)
    if (!injector || !bridge?.afterVisible$) return false
    const subscription = bridge.afterVisible$.subscribe((params) => {
      const { visible, eventType } = params as { visible?: boolean; eventType?: unknown }
      if (!visible || eventType !== DeviceInputEventType.PointerDown) return
      collapseHiddenInputSelection(injector)
      requestAnimationFrame(() => collapseHiddenInputSelection(injector))
    })
    unsubscribe = () => subscription.unsubscribe()
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
    if (attempts < MAX_ATTEMPTS) timer = setTimeout(attempt, RETRY_INTERVAL_MS)
  }
  attempt()

  return {
    dispose: () => {
      disposed = true
      if (timer) clearTimeout(timer)
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
