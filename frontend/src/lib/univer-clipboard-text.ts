import { ICommandService } from '@univerjs/core'
import { ISheetClipboardService, SheetPasteShortKeyCommand } from '@univerjs/sheets-ui'

/**
 * Excel and LibreOffice put tab separated text on the clipboard in the RFC 4180
 * dialect: a field that contains a line break, a tab or a quote is wrapped in
 * double quotes (an inner quote is doubled). Univer ignores that quoting.
 *
 * On the copy side that means a row with a multi line cell (a note, an address,
 * a multi line remark) reaches the plain text flavour unquoted, and the
 * information "this line break belongs to a cell" is gone. On the paste side the
 * plain text is then split on every newline, so that row lands on two rows and
 * everything below it shifts - which is exactly what the RFC 4180 quoting
 * prevents.
 *
 * This module fixes both ends: copies quote fields that need it (the produced
 * text is byte identical to Univer's whenever no field needs quoting, so Excel
 * round trips stay unchanged), and pastes that do carry quoted line breaks are
 * re-encoded through Univer's HTML paste path, which understands a line break
 * inside a cell.
 */

export interface ParsedClipboardText {
  matrix: string[][]
  /** True when a quoted field itself contains a line break. */
  quotedLineBreak: boolean
}

const FIELD_DELIMITER = '\t'

function isLineBreak(character: string): boolean {
  return character === '\n' || character === '\r'
}

/**
 * Parses spreadsheet style delimited text. Line breaks outside of quotes start a
 * new row, tab characters outside of quotes start a new cell, and quoted fields
 * keep their line breaks and tabs.
 */
export function parseClipboardText(text: string): ParsedClipboardText {
  const matrix: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let quotedLineBreak = false

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    matrix.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
          continue
        }
        inQuotes = false
        continue
      }
      if (isLineBreak(character)) quotedLineBreak = true
      field += character
      continue
    }

    // A quote only opens a quoted field at its start, otherwise it is literal
    // text (spreadsheets are forgiving here, and so is this parser).
    if (character === '"' && field === '') {
      inQuotes = true
      continue
    }
    if (character === FIELD_DELIMITER) {
      pushField()
      continue
    }
    if (isLineBreak(character)) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      pushRow()
      continue
    }
    field += character
  }

  // A trailing line break (spreadsheets always append one) must not create an
  // extra empty row.
  if (field !== '' || row.length > 0) pushRow()

  return {
    matrix: matrix.map((cells) => cells.map((cell) => cell.replace(/\r\n?/g, '\n'))),
    quotedLineBreak,
  }
}

function needsQuoting(field: string): boolean {
  return field.includes('"') || field.includes('\n') || field.includes('\r') || field.includes(FIELD_DELIMITER)
}

/** Writes a matrix back as spreadsheet style text, quoting fields that need it. */
export function clipboardTextFromMatrix(matrix: string[][]): string {
  return matrix
    .map((cells) => cells.map((cell) => (needsQuoting(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(FIELD_DELIMITER))
    .join('\r\n')
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Builds the `text/html` flavour for a parsed matrix. `<br>` is what a line break
 * inside a cell is written as, so a multi line cell stays one cell with two
 * lines instead of becoming two rows.
 */
export function clipboardHtmlFromMatrix(matrix: string[][]): string {
  const rows = matrix
    .map((cells) => `<tr>${cells.map((cell) => `<td>${escapeHtml(cell).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`)
    .join('')
  return `<table><tbody>${rows}</tbody></table>`
}

interface PasteByShortKeyParams {
  htmlContent?: string
  textContent?: string
  files?: File[]
}

interface CellMatrixLike {
  forRow: (callback: (row: number, columnIndexes: number[]) => void) => void
  getValue: (row: number, column: number) => { displayV?: unknown; v?: unknown } | undefined | null
}

interface CopyContentLike {
  plain?: string
  html?: string
  matrixFragment?: CellMatrixLike
}

interface ClipboardServiceLike {
  generateCopyContent?: (...args: unknown[]) => CopyContentLike | null | undefined
}

interface FacadeRangeLike {
  getDisplayValues?: () => unknown
}

interface FacadeSheetLike {
  getRange: (startRow: number, startColumn: number, numRows: number, numColumns: number) => FacadeRangeLike
}

interface CopyRangeLike {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

interface CommandServiceLike {
  beforeCommandExecuted?: (listener: (info: { id?: string; params?: unknown }) => void) => { dispose?: () => void }
}

function getInjector(univer: unknown): { get: <T>(token: unknown) => T } | undefined {
  return (univer as { __getInjector?: () => { get: <T>(token: unknown) => T } } | null)?.__getInjector?.()
}

function cellText(cell: { displayV?: unknown; v?: unknown } | undefined | null): string {
  if (!cell) return ''
  if (typeof cell.displayV === 'string') return cell.displayV
  if (cell.v === undefined || cell.v === null) return ''
  return String(cell.v)
}

/**
 * Rebuilds the plain text of a copy with RFC 4180 quoting. It is only applied
 * when the rebuilt text reproduces the text Univer produced exactly - otherwise
 * the copy is left untouched. Fields without a line break, tab or quote stay
 * unquoted, which keeps ordinary copies byte identical.
 */
function quoteCopyContent(content: CopyContentLike | null | undefined, displayValues?: string[][]): CopyContentLike | null | undefined {
  if (!content || typeof content.plain !== 'string') return content
  const matrix = content.matrixFragment
  const candidates: string[][][] = []
  if (displayValues && displayValues.length > 0) candidates.push(displayValues)
  if (matrix && typeof matrix.forRow === 'function' && typeof matrix.getValue === 'function') {
    try {
      const rows: string[][] = []
      matrix.forRow((row, columnIndexes) => {
        const cells: string[] = []
        columnIndexes.forEach((column) => cells.push(cellText(matrix.getValue(row, column))))
        rows.push(cells)
      })
      if (rows.length > 0) candidates.push(rows)
    } catch (error) {
      console.warn('Failed to read the copied range:', error)
    }
  }

  try {
    for (const rows of candidates) {
      const rebuilt = rows.map((cells) => cells.join(FIELD_DELIMITER)).join('\n')
      // Only reformat when the text is understood completely: `plain` is what the
      // clipboard actually carries, so a mismatch means a cell renders
      // differently (number formats, rich text) and quoting must not be guessed.
      if (rebuilt !== content.plain) continue
      const quoted = clipboardTextFromMatrix(rows)
      return quoted === content.plain ? content : { ...content, plain: quoted }
    }
    return content
  } catch (error) {
    console.warn('Failed to quote the copied spreadsheet text:', error)
    return content
  }
}

/** Reads the displayed text of the copied range, so formatted cells keep their
 *  on-screen wording when the plain text is rebuilt for quoting. */
function readDisplayValues(
  args: unknown[],
  resolveSheet?: () => FacadeSheetLike | null | undefined
): string[][] | undefined {
  if (!resolveSheet) return undefined
  const range = args[2] as CopyRangeLike | undefined
  if (!range || typeof range !== 'object') return undefined
  const numRows = range.endRow - range.startRow + 1
  const numColumns = range.endColumn - range.startColumn + 1
  if (!Number.isFinite(numRows) || !Number.isFinite(numColumns) || numRows <= 0 || numColumns <= 0) return undefined
  try {
    const sheet = resolveSheet()
    const values = sheet?.getRange(range.startRow, range.startColumn, numRows, numColumns)?.getDisplayValues?.()
    if (!Array.isArray(values)) return undefined
    return values.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []))
  } catch (error) {
    console.warn('Failed to read the displayed values of a copied range:', error)
    return undefined
  }
}

/**
 * Installs the two clipboard fixes for the given Univer instance. Both are
 * additive: unchanged clipboard content keeps the default Univer behaviour.
 */
export function registerQuotedClipboardFixes(
  univer: unknown,
  resolveSheet?: () => FacadeSheetLike | null | undefined
): { dispose: () => void } | null {
  const disposables: Array<{ dispose?: () => void }> = []
  try {
    const injector = getInjector(univer)
    if (!injector) return null

    // Copy side: quote fields that carry a line break / tab / quote so the plain
    // text flavour stays unambiguous.
    const clipboardService = injector.get<ClipboardServiceLike | null | undefined>(ISheetClipboardService)
    if (clipboardService && typeof clipboardService.generateCopyContent === 'function') {
      const original = clipboardService.generateCopyContent
      const patched = function patchedGenerateCopyContent(this: ClipboardServiceLike, ...args: unknown[]) {
        return quoteCopyContent(original.apply(this, args), readDisplayValues(args, resolveSheet))
      }
      clipboardService.generateCopyContent = patched
      disposables.push({
        dispose: () => {
          if (clipboardService.generateCopyContent === patched) clipboardService.generateCopyContent = original
        },
      })
    }

    // Paste side: when the clipboard text is quoted, it - and not the (line break
    // losing) HTML flavour - describes the intended layout.
    const commandService = injector.get<CommandServiceLike | null | undefined>(ICommandService)
    if (commandService && typeof commandService.beforeCommandExecuted === 'function') {
      const listener = commandService.beforeCommandExecuted((info) => {
        if (info?.id !== SheetPasteShortKeyCommand.id) return
        const params = info.params as PasteByShortKeyParams | undefined
        if (!params || typeof params !== 'object') return
        const text = params.textContent
        if (typeof text !== 'string' || text === '') return
        const { matrix, quotedLineBreak } = parseClipboardText(text)
        if (!quotedLineBreak) return
        params.htmlContent = clipboardHtmlFromMatrix(matrix)
      })
      disposables.push({ dispose: () => listener?.dispose?.() })
    }

    if (disposables.length === 0) return null
    return {
      dispose: () => disposables.forEach((disposable) => disposable?.dispose?.()),
    }
  } catch (error) {
    console.warn('Failed to register the quoted clipboard fixes:', error)
    disposables.forEach((disposable) => disposable?.dispose?.())
    return null
  }
}
