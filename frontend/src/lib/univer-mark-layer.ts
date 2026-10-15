import type { IRange } from '@univerjs/core'
import type { ISelectionStyle } from '@univerjs/sheets'
import { IMarkSelectionService } from '@univerjs/sheets-ui'

/**
 * Cell highlights (protected areas, pending approvals, collaborators) are
 * drawn as Univer "mark selections". Two properties of that service matter:
 *
 *  - `addShape` (what `FRange.highlight` uses) redraws every existing shape, so
 *    adding N highlights one by one costs O(N²) shape creations;
 *  - `removeAllShapes` runs whenever a cell editor opens or closes, on copy/cut
 *    and for the format painter, silently wiping every highlight.
 *
 * A layer adds its shapes in one batch with a single redraw, and the watcher
 * reports every wipe so the layers can be drawn again.
 */

type Injector = { get: <T>(token: unknown) => T }

export interface MarkShape {
  range: IRange
  style: Partial<ISelectionStyle>
}

function markService(univer: unknown): IMarkSelectionService | null {
  try {
    const injector = (univer as { __getInjector?: () => Injector } | null)?.__getInjector?.()
    return injector?.get<IMarkSelectionService>(IMarkSelectionService) ?? null
  } catch {
    return null
  }
}

export interface MarkLayer {
  /** Replaces the layer's shapes with `shapes`, redrawing once. */
  replace: (shapes: MarkShape[]) => void
  clear: () => void
}

export function createMarkLayer(univer: unknown, zIndex?: number): MarkLayer | null {
  const service = markService(univer)
  if (!service) return null
  let ids: string[] = []
  const clear = () => {
    ids.forEach((id) => service.removeShape(id))
    ids = []
  }
  return {
    clear,
    replace(shapes) {
      clear()
      if (shapes.length === 0) return
      const next: string[] = []
      shapes.forEach((shape) => {
        const id = service.addShapeWithNoFresh({ range: shape.range, style: shape.style as ISelectionStyle, primary: null }, [], zIndex)
        if (id) next.push(id)
      })
      ids = next
      service.refreshShapes()
    },
  }
}

/** Calls onWipe after Univer removed every mark shape. Returns the undo. */
export function watchMarkShapeWipes(univer: unknown, onWipe: () => void): (() => void) | null {
  const service = markService(univer) as (IMarkSelectionService & { removeAllShapes: () => void }) | null
  if (!service) return null
  const original = service.removeAllShapes
  service.removeAllShapes = function patchedRemoveAllShapes(this: unknown) {
    original.call(service)
    onWipe()
  }
  return () => {
    service.removeAllShapes = original
  }
}
