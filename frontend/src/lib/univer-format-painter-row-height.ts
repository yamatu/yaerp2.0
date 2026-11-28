import { ICommandService, IUniverInstanceService } from '@univerjs/core'

/**
 * Applying the format painter downwards can change the height of the rows it paints
 * (seen on macOS). The painter only writes cell styles, so a row height must
 * never move because of it. Row heights are snapshotted just before
 * `ApplyFormatPainterCommand` runs and every row that differs afterwards gets its
 * previous `h` / `ah` / `ia` written back. The restore runs twice, right after
 * the command and again once Univer's idle auto-height pass has had a chance to
 * run. The restore uses plain mutations, so it does not add an undo step.
 */

const APPLY_FORMAT_PAINTER_ID = 'sheet.command.apply-format-painter'
const SET_ROW_AUTO_HEIGHT_ID = 'sheet.mutation.set-worksheet-row-auto-height'
const SET_ROW_HEIGHT_ID = 'sheet.mutation.set-worksheet-row-height'
const SET_ROW_IS_AUTO_HEIGHT_ID = 'sheet.mutation.set-worksheet-row-is-auto-height'
const RESTORE_DELAYS_MS = [0, 400]
const RETRY_INTERVAL_MS = 100
const MAX_ATTEMPTS = 100

type Injector = { get: <T>(token: unknown) => T }
type RowState = { h?: number; ah?: number; ia?: number }
type RowSnapshot = Record<string, RowState>
type Disposable = { dispose: () => void }
type CommandInfo = { id?: string; params?: unknown } | null | undefined

type CommandServiceLike = {
  beforeCommandExecuted?: (callback: (info: CommandInfo) => void) => Disposable | null | undefined
  onCommandExecuted?: (callback: (info: CommandInfo) => void) => Disposable | null | undefined
  syncExecuteCommand?: (id: string, params?: unknown) => unknown
}

type WorksheetLike = {
  getRowManager?: () => { getRowData?: () => Record<string, RowState | undefined> | undefined } | undefined
}

type PendingPaint = { unitId: string; subUnitId: string; before: RowSnapshot }

function pickRowState(row: RowState | undefined): RowState {
  const state: RowState = {}
  if (typeof row?.h === 'number') state.h = row.h
  if (typeof row?.ah === 'number') state.ah = row.ah
  if (typeof row?.ia === 'number') state.ia = row.ia
  return state
}

function readRows(worksheet: WorksheetLike | null | undefined): RowSnapshot | null {
  const rowData = worksheet?.getRowManager?.()?.getRowData?.()
  if (!rowData) return null
  const snapshot: RowSnapshot = {}
  Object.keys(rowData).forEach((key) => {
    snapshot[key] = pickRowState(rowData[key])
  })
  return snapshot
}

function getWorksheet(injector: Injector, unitId: string, subUnitId: string): WorksheetLike | null {
  const instances = injector.get<{ getUnit?: (id: string) => unknown } | undefined>(IUniverInstanceService)
  const unit = instances?.getUnit?.(unitId) as { getSheetBySheetId?: (id: string) => unknown } | null | undefined
  return (unit?.getSheetBySheetId?.(subUnitId) as WorksheetLike | null | undefined) ?? null
}

function readTarget(params: unknown): { unitId: string; subUnitId: string } | null {
  const { unitId, subUnitId } = (params ?? {}) as { unitId?: unknown; subUnitId?: unknown }
  return typeof unitId === 'string' && typeof subUnitId === 'string' ? { unitId, subUnitId } : null
}

/** Writes back every row whose height state differs from `before`. Returns the number of rows restored. */
function restoreRows(commandService: CommandServiceLike, injector: Injector, pending: PendingPaint): number {
  const { unitId, subUnitId, before } = pending
  const current = readRows(getWorksheet(injector, unitId, subUnitId))
  if (!current || !commandService.syncExecuteCommand) return 0

  const autoHeights: Array<{ row: number; autoHeight: number | undefined }> = []
  let restored = 0
  new Set([...Object.keys(before), ...Object.keys(current)]).forEach((key) => {
    const row = Number(key)
    if (!Number.isInteger(row) || row < 0) return
    const previous = before[key] ?? {}
    const now = current[key] ?? {}
    let changed = false
    if (previous.ah !== now.ah) {
      autoHeights.push({ row, autoHeight: previous.ah })
      changed = true
    }
    if (previous.h !== now.h && typeof previous.h === 'number') {
      commandService.syncExecuteCommand?.(SET_ROW_HEIGHT_ID, {
        unitId,
        subUnitId,
        ranges: [{ startRow: row, endRow: row, startColumn: 0, endColumn: 0 }],
        rowHeight: previous.h,
      })
      changed = true
    }
    if (previous.ia !== now.ia) {
      commandService.syncExecuteCommand?.(SET_ROW_IS_AUTO_HEIGHT_ID, {
        unitId,
        subUnitId,
        ranges: [{ startRow: row, endRow: row, startColumn: 0, endColumn: 0 }],
        autoHeightInfo: { [row]: previous.ia },
      })
      changed = true
    }
    if (changed) restored += 1
  })
  if (autoHeights.length > 0) {
    commandService.syncExecuteCommand(SET_ROW_AUTO_HEIGHT_ID, { unitId, subUnitId, rowsAutoHeightInfo: autoHeights })
  }
  return restored
}

export function registerFormatPainterRowHeightGuard(
  univer: unknown,
  onRestored?: (count: number) => void
): { dispose: () => void } {
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  let pending: PendingPaint | null = null
  const restoreTimers = new Set<ReturnType<typeof setTimeout>>()
  const subscriptions: Array<Disposable | null | undefined> = []

  const install = (): boolean => {
    const injector = (univer as { __getInjector?: () => Injector } | null)?.__getInjector?.()
    const commandService = injector?.get<CommandServiceLike | undefined>(ICommandService)
    if (!injector || !commandService?.beforeCommandExecuted || !commandService.onCommandExecuted) return false

    subscriptions.push(
      commandService.beforeCommandExecuted((info) => {
        // Checked first: this fires for every mutation, and a large paste dispatches thousands.
        if (info?.id !== APPLY_FORMAT_PAINTER_ID) return
        try {
          const target = readTarget(info.params)
          const before = target ? readRows(getWorksheet(injector, target.unitId, target.subUnitId)) : null
          pending = target && before ? { ...target, before } : null
        } catch {
          pending = null
        }
      })
    )
    subscriptions.push(
      commandService.onCommandExecuted((info) => {
        if (info?.id !== APPLY_FORMAT_PAINTER_ID || !pending) return
        const paint = pending
        pending = null
        RESTORE_DELAYS_MS.forEach((delay) => {
          const timer = setTimeout(() => {
            restoreTimers.delete(timer)
            if (disposed) return
            try {
              const restored = restoreRows(commandService, injector, paint)
              if (restored > 0) onRestored?.(restored)
            } catch {
              // A failed restore leaves Univer's own heights in place.
            }
          }, delay)
          restoreTimers.add(timer)
        })
      })
    )
    return true
  }

  const attempt = () => {
    retryTimer = null
    if (disposed) return
    let installed = false
    try {
      installed = install()
    } catch {
      installed = false
    }
    if (installed) return
    attempts += 1
    if (attempts < MAX_ATTEMPTS) retryTimer = setTimeout(attempt, RETRY_INTERVAL_MS)
  }
  attempt()

  return {
    dispose: () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      restoreTimers.forEach((timer) => clearTimeout(timer))
      restoreTimers.clear()
      subscriptions.forEach((subscription) => subscription?.dispose?.())
      subscriptions.length = 0
      pending = null
    },
  }
}
