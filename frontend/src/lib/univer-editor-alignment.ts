import {
  HorizontalAlign,
  IUniverInstanceService,
  UniverInstanceType,
  VerticalAlign,
  type DocumentDataModel,
  type ICellData,
} from '@univerjs/core'
import { BEFORE_CELL_EDIT, SheetInterceptorService } from '@univerjs/sheets'
import { IEditorBridgeService, SheetCellEditorResizeService } from '@univerjs/sheets-ui'

type Injector = { get: <T>(token: unknown) => T }

function getInjector(univer: unknown): Injector | undefined {
  return (univer as { __getInjector?: () => Injector } | null)?.__getInjector?.()
}

/**
 * Univer's inline cell editor reads the cell's own style only, while the cell
 * renderer composes the worksheet default/row/column styles with the cell
 * style. As a result worksheet- or column-level alignment never reached the
 * editor and the draft text was aligned differently from the committed cell
 * content. This interceptor hands the editor the same composed style the
 * renderer uses so both stay in sync. Cells that already pin their own
 * alignment keep it, and empty cells receive a synthetic style because they
 * have no style to mirror.
 */
export function registerEditorComposedStyleInterceptor(univer: unknown, attempt = 0) {
  const injector = getInjector(univer)
  if (!injector) return

  try {
    const service = injector.get<SheetInterceptorService | undefined>(SheetInterceptorService)
    if (!service?.writeCellInterceptor) {
      throw new Error('SheetInterceptorService is not available yet')
    }

    service.writeCellInterceptor.intercept(BEFORE_CELL_EDIT, {
      priority: 100,
      handler: (cell, context) => {
        const vt = VerticalAlign.MIDDLE
        try {
          const worksheet = context?.worksheet
          // The renderer resolves the effective style as
          // default + row + column + cell style. Mirror that resolution so a
          // column-wide alignment behaves the same while editing.
          const composedStyle =
            typeof context?.row === 'number' && typeof context?.col === 'number'
              ? worksheet?.getComposedCellStyle?.(context.row, context.col)
              : undefined
          const composed = (composedStyle || undefined) as unknown as Record<string, unknown> | undefined

          // Empty cells carry no style at all, so the inline editor would fall
          // back to Univer's bottom/left alignment while the committed
          // (rendered) cell follows the worksheet default. Hand the editor a
          // synthetic style so the draft text matches the final cell content.
          if (!cell) return { s: { ...(composed || {}), vt } } as ICellData

          const rawStyle = cell.s
          let base: Record<string, unknown> | undefined
          if (composed && Object.keys(composed).length > 0) {
            base = composed
          } else if (typeof rawStyle === 'string') {
            const getStyleDataByHash = worksheet?.getStyleDataByHash
            const styleData =
              typeof getStyleDataByHash === 'function' ? getStyleDataByHash.call(worksheet, rawStyle) : undefined
            base = (styleData || undefined) as unknown as Record<string, unknown> | undefined
          } else if (rawStyle && typeof rawStyle === 'object') {
            base = rawStyle as Record<string, unknown>
          }

          if (base && base.vt !== undefined && base.vt !== null) return { ...cell, s: { ...base } as ICellData['s'] }

          return { ...cell, s: { ...(base || {}), vt } as ICellData['s'] }
        } catch {
          return cell
        }
      },
    })
  } catch (error) {
    // Univer instantiates its plugins - and therefore registers
    // SheetInterceptorService - lazily, during the first unit creation. If the
    // interceptor is wired up before that, the service is missing. Retry on a
    // short timer so the alignment fix is never silently dropped.
    if (attempt < 40) {
      setTimeout(() => registerEditorComposedStyleInterceptor(univer, attempt + 1), 50)
      return
    }
    console.warn('Failed to register the sheet editor alignment interceptor:', error)
  }
}

/**
 * Restores the inline editor layout for centre aligned cells.
 *
 * Univer lays the editor document out in two passes: first it widens the page
 * so that a long value can grow symmetrically, then it narrows the page back to
 * the cell width and offsets the text through the document margin instead. For
 * centre aligned cells the paragraph itself is also centred, so the paragraph
 * ends up centred *inside* the already offset content box and the draft text is
 * painted roughly `(cellWidth - textWidth) / 2` pixels to the right of the
 * committed cell content (about 40px in a 200px wide cell).
 *
 * Writing the cell padding back as the left margin makes the paragraph
 * centring the only active offset: `marginLeft + (pageWidth - marginLeft -
 * marginRight - textWidth) / 2` collapses to `(pageWidth - textWidth) / 2`,
 * which is exactly where the renderer paints the committed value. The skeleton
 * has to be recalculated because its lines kept the padding computed against
 * the widened first pass.
 */
function normalizeCenteredCellEditorMargin(injector: Injector, resizeService: unknown) {
  const bridge = injector.get<IEditorBridgeService | undefined>(IEditorBridgeService)
  const state = bridge?.getEditCellState?.()
  const layout = state?.documentLayoutObject
  // Only centre aligned cells combine a paragraph alignment with the margin
  // based offset, so only they need this correction.
  if (!layout || layout.horizontalAlign !== HorizontalAlign.CENTER) return

  const paddingLeft = layout.paddingData?.l ?? 0
  const instanceService = injector.get<IUniverInstanceService | undefined>(IUniverInstanceService)
  const documentUnit = instanceService?.getCurrentUnitForType<DocumentDataModel>(UniverInstanceType.UNIVER_DOC)
  if (!documentUnit?.updateDocumentDataMargin) return

  documentUnit.updateDocumentDataMargin({ l: paddingLeft })

  const skeleton = (
    resizeService as { _getEditorSkeleton?: () => { calculate?: () => void } | null } | null
  )?._getEditorSkeleton?.()
  skeleton?.calculate?.()
}

/**
 * Univer re-runs `fitTextSize` for every keystroke and after every editor
 * resize, so the correction above has to run after each of those passes.
 */
export function installCellEditorAlignmentRecalculation(univer: unknown, attempt = 0) {
  const injector = getInjector(univer)
  if (!injector) return

  try {
    const resizeService = injector.get<SheetCellEditorResizeService | undefined>(SheetCellEditorResizeService)
    if (!resizeService) throw new Error('SheetCellEditorResizeService is not available yet')

    const prototype = Object.getPrototypeOf(resizeService) as {
      fitTextSize?: (callback?: () => void) => void
      __yaerpCenteredEditorMarginFix?: boolean
    } | null
    const originalFitTextSize = prototype?.fitTextSize
    if (!prototype || typeof originalFitTextSize !== 'function') {
      throw new Error('SheetCellEditorResizeService.fitTextSize is not available yet')
    }
    // Patch once - the prototype is shared by every editor instance and a
    // second wrapper would recalculate the same layout twice.
    if (prototype.__yaerpCenteredEditorMarginFix) return

    prototype.fitTextSize = function patchedFitTextSize(this: unknown, callback?: () => void) {
      const result = originalFitTextSize.call(this, callback)
      try {
        normalizeCenteredCellEditorMargin(injector, this)
      } catch {
        // Never break editing because of a cosmetic alignment correction.
      }
      return result
    }
    prototype.__yaerpCenteredEditorMarginFix = true
  } catch (error) {
    // Same lazy plugin instantiation as above: retry until the editor services
    // exist, otherwise centred cells keep drifting while editing.
    if (attempt < 40) {
      setTimeout(() => installCellEditorAlignmentRecalculation(univer, attempt + 1), 50)
      return
    }
    console.warn('Failed to install the sheet editor alignment recalculation:', error)
  }
}
