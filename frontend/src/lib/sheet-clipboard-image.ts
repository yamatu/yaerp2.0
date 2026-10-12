/**
 * Renders the `text/html` table of a sheet copy into a PNG, so chat apps (WeChat,
 * WPS, DingTalk, ...) that prefer an image paste a faithful picture of the
 * range instead of converting the HTML table into a markdown table. Their
 * "paste as plain text" still receives the TSV `text/plain` flavour.
 *
 * Only inline styles are read (Univer writes every style inline), the table is
 * never attached to the document, and anything unexpected returns `null` so a
 * copy never fails because of the picture.
 */

export const CLIPBOARD_IMAGE_MAX_ROWS = 200
export const CLIPBOARD_IMAGE_MAX_COLUMNS = 30
/** Largest bitmap edge in device pixels; bigger ranges are downscaled. */
const MAX_BITMAP_EDGE = 8000
const MAX_BITMAP_AREA = 24_000_000
const DEFAULT_COLUMN_WIDTH = 88
const DEFAULT_ROW_HEIGHT = 24
const DEFAULT_FONT_SIZE = 13
const DEFAULT_FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", Arial, sans-serif'
const GRID_COLOR = '#d9dee5'
const PADDING = 4

interface CellBox {
  row: number
  column: number
  rowSpan: number
  columnSpan: number
  element: HTMLTableCellElement
}

function parseLength(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback
  const match = /^(-?\d+(?:\.\d+)?)(px|pt)?$/i.exec(value.trim())
  if (!match) return fallback
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return fallback
  return match[2]?.toLowerCase() === 'pt' ? (amount * 4) / 3 : amount
}

function cellText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement
  clone.querySelectorAll('br').forEach((node) => node.replaceWith('\n'))
  clone.querySelectorAll('p, div').forEach((node, index) => {
    if (index > 0) node.prepend('\n')
  })
  return (clone.textContent || '').replace(/ /g, ' ').replace(/\n+$/, '')
}

/** Lays the table out on a grid, honouring `rowspan` / `colspan`. */
function layoutTable(table: HTMLTableElement) {
  const rows = Array.from(table.querySelectorAll('tr'))
  const occupied = new Set<string>()
  const cells: CellBox[] = []
  let columnCount = 0
  rows.forEach((tr, rowIndex) => {
    let column = 0
    Array.from(tr.children).forEach((child) => {
      if (!(child instanceof HTMLTableCellElement)) return
      while (occupied.has(`${rowIndex}:${column}`)) column += 1
      const rowSpan = Math.max(1, Number(child.getAttribute('rowspan')) || 1)
      const columnSpan = Math.max(1, Number(child.getAttribute('colspan')) || 1)
      for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
        for (let c = column; c < column + columnSpan; c += 1) occupied.add(`${r}:${c}`)
      }
      cells.push({ row: rowIndex, column, rowSpan, columnSpan, element: child })
      column += columnSpan
      columnCount = Math.max(columnCount, column)
    })
  })
  return { rows, cells, columnCount }
}

function columnWidths(table: HTMLTableElement, columnCount: number): number[] {
  const cols = Array.from(table.querySelectorAll('col'))
  return Array.from({ length: columnCount }, (_, index) => {
    const col = cols[index]
    if (!col) return DEFAULT_COLUMN_WIDTH
    return Math.min(600, parseLength(col.style.width || col.getAttribute('width'), DEFAULT_COLUMN_WIDTH))
  })
}

function isNumericText(text: string) {
  return /^[-+]?[$¥€£]?\s?\d[\d,]*(?:\.\d+)?%?$/.test(text.trim())
}

function drawBorder(
  context: CanvasRenderingContext2D,
  width: string,
  style: string,
  color: string,
  from: [number, number],
  to: [number, number]
) {
  if (!style || style === 'none' || style === 'hidden') return
  const lineWidth = Math.max(1, Math.min(3, parseLength(width, 1)))
  context.save()
  context.strokeStyle = color || '#000'
  context.lineWidth = lineWidth
  context.setLineDash(style === 'dashed' ? [4, 2] : style === 'dotted' ? [1, 2] : [])
  context.beginPath()
  context.moveTo(from[0], from[1])
  context.lineTo(to[0], to[1])
  context.stroke()
  context.restore()
}

/** Returns a PNG of the copied table, or `null` when it is too large or unsupported. */
export async function renderClipboardTableImage(html: string): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof DOMParser === 'undefined' || !html) return null
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const table = parsed.querySelector('table')
  if (!table) return null
  const { rows, cells, columnCount } = layoutTable(table)
  if (rows.length === 0 || columnCount === 0) return null
  if (rows.length > CLIPBOARD_IMAGE_MAX_ROWS || columnCount > CLIPBOARD_IMAGE_MAX_COLUMNS) return null

  const widths = columnWidths(table, columnCount)
  const heights = rows.map((tr) => Math.min(400, parseLength(tr.style.height || tr.getAttribute('height'), DEFAULT_ROW_HEIGHT)))
  const xs = [0]
  widths.forEach((width) => xs.push(xs[xs.length - 1] + width))
  const ys = [0]
  heights.forEach((height) => ys.push(ys[ys.length - 1] + height))
  const totalWidth = Math.ceil(xs[xs.length - 1]) + 1
  const totalHeight = Math.ceil(ys[ys.length - 1]) + 1

  let scale = Math.min(2, Math.max(1, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1))
  scale = Math.min(scale, MAX_BITMAP_EDGE / totalWidth, MAX_BITMAP_EDGE / totalHeight)
  if (totalWidth * totalHeight * scale * scale > MAX_BITMAP_AREA) scale = Math.sqrt(MAX_BITMAP_AREA / (totalWidth * totalHeight))
  if (!Number.isFinite(scale) || scale < 0.25) return null

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(totalWidth * scale))
  canvas.height = Math.max(1, Math.round(totalHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.scale(scale, scale)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, totalWidth, totalHeight)
  context.textBaseline = 'middle'

  const tableFont = table.style.fontFamily || ''
  cells.forEach((cell) => {
    const x = xs[cell.column] + 0.5
    const y = ys[cell.row] + 0.5
    const width = xs[Math.min(columnCount, cell.column + cell.columnSpan)] - xs[cell.column]
    const height = ys[Math.min(rows.length, cell.row + cell.rowSpan)] - ys[cell.row]
    const style = cell.element.style

    if (style.backgroundColor && style.backgroundColor !== 'transparent') {
      context.fillStyle = style.backgroundColor
      context.fillRect(x, y, width, height)
    }
    context.strokeStyle = GRID_COLOR
    context.lineWidth = 1
    context.strokeRect(x, y, width, height)

    const text = cellText(cell.element)
    if (text) {
      const fontSize = Math.min(48, parseLength(style.fontSize, DEFAULT_FONT_SIZE))
      const weight = style.fontWeight === 'bold' || Number(style.fontWeight) >= 600 ? 'bold' : 'normal'
      const italic = style.fontStyle === 'italic' ? 'italic' : 'normal'
      const family = style.fontFamily || tableFont
      context.font = `${italic} ${weight} ${fontSize}px ${family ? `${family}, ` : ''}${DEFAULT_FONT_FAMILY}`
      context.fillStyle = style.color || '#1f2937'
      const align = style.textAlign || (isNumericText(text) ? 'right' : 'left')
      const lines = text.split('\n')
      const lineHeight = fontSize * 1.3
      const vertical = style.verticalAlign
      const blockHeight = lines.length * lineHeight
      let top =
        vertical === 'top'
          ? y + PADDING + lineHeight / 2
          : vertical === 'bottom'
            ? y + height - PADDING - blockHeight + lineHeight / 2
            : y + (height - blockHeight) / 2 + lineHeight / 2
      context.save()
      context.beginPath()
      context.rect(x + 1, y + 1, width - 2, height - 2)
      context.clip()
      lines.forEach((line) => {
        let textX = x + PADDING
        context.textAlign = 'left'
        if (align === 'center') {
          textX = x + width / 2
          context.textAlign = 'center'
        } else if (align === 'right' || align === 'end') {
          textX = x + width - PADDING
          context.textAlign = 'right'
        }
        context.fillText(line, textX, top)
        if (style.textDecorationLine?.includes('underline') || style.textDecoration?.includes('underline')) {
          const measured = context.measureText(line).width
          const start = context.textAlign === 'center' ? textX - measured / 2 : context.textAlign === 'right' ? textX - measured : textX
          context.fillRect(start, top + fontSize / 2, measured, 1)
        }
        top += lineHeight
      })
      context.restore()
    }

    drawBorder(context, style.borderTopWidth, style.borderTopStyle, style.borderTopColor, [x, y], [x + width, y])
    drawBorder(context, style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor, [x, y + height], [x + width, y + height])
    drawBorder(context, style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor, [x, y], [x, y + height])
    drawBorder(context, style.borderRightWidth, style.borderRightStyle, style.borderRightColor, [x + width, y], [x + width, y + height])
  })

  return new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png')
    } catch {
      resolve(null)
    }
  })
}
