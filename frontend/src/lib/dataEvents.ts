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
