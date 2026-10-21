/** Drag data for handing workbooks or a folder to the AI chat as context. */
export const AI_CONTEXT_DRAG_MIME = 'application/x-yaerp-ai-context'

export interface AIContextDragPayload {
  workbooks?: { id: number; name: string }[]
  folder?: { id: number; name: string }
}

/** Dispatched with an AIContextDragPayload when something is dropped on the AI button. */
export const AI_CONTEXT_DROP_EVENT = 'yaerp:ai-context-drop'

export function isContextDrag(dataTransfer: DataTransfer | null) {
  return Boolean(dataTransfer && Array.from(dataTransfer.types || []).includes(AI_CONTEXT_DRAG_MIME))
}

export function readContextDrag(dataTransfer: DataTransfer): AIContextDragPayload | null {
  try {
    const payload = JSON.parse(dataTransfer.getData(AI_CONTEXT_DRAG_MIME) || 'null')
    return payload && (payload.folder || Array.isArray(payload.workbooks)) ? payload : null
  } catch {
    return null
  }
}

export const ACTIVE_SHEET_EVENT = 'yaerp:active-sheet'

export interface ActiveSheetDetail {
  workbookId: number
  sheetId: number
}

// The sheet the employee is looking at, so the AI panel can default its
// context to it. Kept in module state because the panel may mount later.
let activeSheet: ActiveSheetDetail | null = null

export function getActiveSheet() {
  return activeSheet
}

export function publishActiveSheet(detail: ActiveSheetDetail | null) {
  if (typeof window === 'undefined') return
  if (activeSheet?.workbookId === detail?.workbookId && activeSheet?.sheetId === detail?.sheetId) return
  activeSheet = detail
  window.dispatchEvent(new CustomEvent<ActiveSheetDetail | null>(ACTIVE_SHEET_EVENT, { detail }))
}

export function subscribeActiveSheet(listener: (detail: ActiveSheetDetail | null) => void) {
  if (typeof window === 'undefined') return () => undefined
  const handler = (event: Event) => listener((event as CustomEvent<ActiveSheetDetail | null>).detail)
  window.addEventListener(ACTIVE_SHEET_EVENT, handler)
  return () => window.removeEventListener(ACTIVE_SHEET_EVENT, handler)
}

export const DATA_CHANGED_EVENT = 'yaerp:data-changed'
export const PREPARE_DATA_MUTATION_EVENT = 'yaerp:prepare-data-mutation'

export interface DataChangedDetail {
  source: 'ai'
  sheetIds: number[]
  resourcesChanged: boolean
}

export function notifyDataChanged(detail: DataChangedDetail) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<DataChangedDetail>(DATA_CHANGED_EVENT, { detail }))
}

export function subscribeDataChanged(listener: (detail: DataChangedDetail) => void) {
  if (typeof window === 'undefined') return () => undefined

  const handler = (event: Event) => {
    listener((event as CustomEvent<DataChangedDetail>).detail)
  }
  window.addEventListener(DATA_CHANGED_EVENT, handler)
  return () => window.removeEventListener(DATA_CHANGED_EVENT, handler)
}

interface PrepareDataMutationDetail {
  waitUntil: (promise: Promise<unknown>) => void
}

export async function prepareDataMutation() {
  if (typeof window === 'undefined') return

  const pending: Promise<unknown>[] = []
  const detail: PrepareDataMutationDetail = {
    waitUntil: (promise) => pending.push(promise),
  }
  window.dispatchEvent(new CustomEvent<PrepareDataMutationDetail>(PREPARE_DATA_MUTATION_EVENT, { detail }))
  await Promise.all(pending)
}

export function subscribePrepareDataMutation(listener: () => Promise<unknown>) {
  if (typeof window === 'undefined') return () => undefined

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<PrepareDataMutationDetail>).detail
    detail?.waitUntil(listener())
  }
  window.addEventListener(PREPARE_DATA_MUTATION_EVENT, handler)
  return () => window.removeEventListener(PREPARE_DATA_MUTATION_EVENT, handler)
}
