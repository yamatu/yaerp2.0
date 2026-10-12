import { CellAlertManagerService } from '@univerjs/sheets-ui'

/**
 * Univer explains a formula error (`#NAME?`, `#REF!`, `#DIV/0!`, ...) with a
 * 200 x 74 popup attached next to the hovered cell. That popup is real DOM on
 * top of the canvas: it covers the neighbouring cells (or the cell itself
 * when it flips at the right edge / on a phone), swallows the clicks meant for
 * them and - because the canvas no longer sees the pointer - never goes away
 * while the pointer rests on it. Selecting and deleting the broken cell, or
 * the cell next to it, becomes a fight with the popup.
 *
 * This module keeps the explanation but takes the popup out of the grid: the
 * formula alert is reported to the app instead of being attached as a popup,
 * and the app renders a small tooltip that never receives pointer events.
 * The green corner triangle Univer paints on error cells stays as the marker.
 */

/** Key the formula plugin uses for its alert (`SHEET_FORMULA_ALERT`). */
export const FORMULA_ALERT_KEY = 'SHEET_FORMULA_ALERT'

export interface FormulaErrorHint {
  row: number
  column: number
  title: string
  message: string
}

interface AlertLike {
  key?: string
  title?: unknown
  message?: unknown
  location?: { row?: number; col?: number }
}

interface CellAlertServiceLike {
  showAlert?: (alert: AlertLike) => void
  removeAlert?: (key: string) => void
  __yaerpFormulaHint?: boolean
}

type Injector = { get: <T>(token: unknown) => T }

function getInjector(univer: unknown): Injector | undefined {
  return (univer as { __getInjector?: () => Injector } | null)?.__getInjector?.()
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

/**
 * Routes Univer's formula error alert to `onHint`. Other alerts (data
 * validation, ...) keep their default popup. Returns a disposer.
 */
export function registerFormulaErrorHint(
  univer: unknown,
  onHint: (hint: FormulaErrorHint | null) => void
): { dispose: () => void } | null {
  try {
    const service = getInjector(univer)?.get<CellAlertServiceLike | undefined>(CellAlertManagerService)
    if (!service || typeof service.showAlert !== 'function' || service.__yaerpFormulaHint) return null
    const originalShow = service.showAlert
    const originalRemove = service.removeAlert
    let active = false

    service.showAlert = function patchedShowAlert(this: CellAlertServiceLike, alert: AlertLike) {
      if (alert?.key !== FORMULA_ALERT_KEY) return originalShow.call(this, alert)
      const row = alert.location?.row
      const column = alert.location?.col
      if (typeof row !== 'number' || typeof column !== 'number') return
      active = true
      onHint({ row, column, title: textOf(alert.title) || '公式错误', message: textOf(alert.message) })
    }
    if (typeof originalRemove === 'function') {
      service.removeAlert = function patchedRemoveAlert(this: CellAlertServiceLike, key: string) {
        if (key === FORMULA_ALERT_KEY && active) {
          active = false
          onHint(null)
        }
        return originalRemove.call(this, key)
      }
    }
    service.__yaerpFormulaHint = true

    return {
      dispose: () => {
        service.showAlert = originalShow
        if (originalRemove) service.removeAlert = originalRemove
        service.__yaerpFormulaHint = false
        if (active) onHint(null)
      },
    }
  } catch (error) {
    console.warn('Failed to install the formula error hint:', error)
    return null
  }
}

/** Short Chinese explanation for an error value shown in a cell. */
export function describeFormulaError(message: string, value?: string): string {
  const explanations: Record<string, string> = {
    '#NAME?': '公式里有无法识别的函数名或名称，检查拼写。',
    '#REF!': '公式引用的单元格已被删除或移动。',
    '#VALUE!': '参与计算的值类型不对，例如文本参与了数学运算。',
    '#DIV/0!': '除数为 0 或为空。',
    '#N/A': '查找函数没有找到匹配的值。',
    '#NUM!': '数值超出范围或无效。',
    '#NULL!': '区域没有交集。',
    '#SPILL!': '数组结果的溢出区域被占用。',
    '#CALC!': '计算失败。',
  }
  const known = value ? explanations[value.trim().toUpperCase()] : undefined
  return known ? `${message ? `${message}：` : ''}${known}` : message
}
