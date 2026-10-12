import { CellValueType, CommandType, ICommandService } from '@univerjs/core'
import { ISheetClipboardService, SheetPasteShortKeyCommand } from '@univerjs/sheets-ui'
import {
  ContextMenuGroup,
  ContextMenuPosition,
  IClipboardInterfaceService,
  IMenuManagerService,
  MenuItemType,
  MenuManagerPosition,
  type IMenuItem,
} from '@univerjs/ui'
import { renderClipboardTableImage } from './sheet-clipboard-image'

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
  onCommandExecuted?: (listener: (info: { id?: string; params?: unknown }) => void) => { dispose?: () => void }
}

export interface DisposableLike {
  dispose?: () => void
}

interface ClipboardInterfaceLike {
  write?: (text: string, html: string) => Promise<void> | void
}

/**
 * Copies through a hidden textarea and a one-shot `copy` listener, which is
 * the only way to set several flavours when the async clipboard API is not
 * available (plain http, older Firefox). Runs synchronously so it stays inside
 * the user gesture that triggered the copy.
 */
function legacyCopy(text: string, html: string): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.opacity = '0'
  const listener = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', text)
    event.clipboardData.setData('text/html', html)
    event.preventDefault()
  }
  document.body.appendChild(textarea)
  document.addEventListener('copy', listener, true)
  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.removeEventListener('copy', listener, true)
    document.body.removeChild(textarea)
    if (active instanceof HTMLElement) active.focus({ preventScroll: true })
  }
}

/**
 * Writes a sheet copy the way WPS / Excel do: `text/plain` is the TSV of the
 * range (no markdown pipes, no padding), `text/html` keeps the table with its
 * inline styles and the copy id Univer uses to paste formulas and formats back
 * into our own sheets, and `image/png` is a picture of the range for chat apps
 * that paste an image by default. The image is optional: when the range is too
 * large or the browser refuses image flavours, text and HTML are written alone.
 */
export async function writeSheetClipboard(text: string, html: string): Promise<void> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  const ItemConstructor = typeof ClipboardItem !== 'undefined' ? ClipboardItem : undefined
  if (!clipboard || typeof clipboard.write !== 'function' || !ItemConstructor) {
    if (!legacyCopy(text, html)) throw new Error('Clipboard is not available')
    return
  }
  const textItems = {
    'text/plain': new Blob([text], { type: 'text/plain' }),
    'text/html': new Blob([html], { type: 'text/html' }),
  }
  const supports = (ItemConstructor as unknown as { supports?: (type: string) => boolean }).supports
  const imageSupported = typeof supports !== 'function' || supports.call(ItemConstructor, 'image/png')
  if (imageSupported) {
    try {
      // Handed over as a promise so the write starts inside the user gesture
      // while the bitmap is still being encoded.
      const image = renderClipboardTableImage(html).then((blob) => {
        if (!blob) throw new Error('No clipboard image for this range')
        return blob
      })
      await clipboard.write([new ItemConstructor({ ...textItems, 'image/png': image })])
      return
    } catch {
      // Too large, unsupported or rejected: fall back to text and HTML only.
    }
  }
  await clipboard.write([new ItemConstructor(textItems)])
}

/** Turns clipboard text into cell values: numbers stay numbers, everything else is text. */
export function plainTextCellValue(text: string): { v: string | number; t: CellValueType } {
  const trimmed = text.trim()
  if (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(trimmed) && !/^[-+]?0\d/.test(trimmed)) {
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) return { v: numeric, t: CellValueType.NUMBER }
  }
  // A leading `=` stays literal text: this is a values-only paste.
  return { v: text, t: CellValueType.STRING }
}

// Method syntax on purpose: the facade narrows the parameters, which stays
// assignable this way.
interface PlainPasteSheetLike {
  getActiveRange?(): { getRow?(): number; getColumn?(): number } | null | undefined
  getMaxRows?(): number
  getMaxColumns?(): number
  setRowCount?(count: number): unknown
  setColumnCount?(count: number): unknown
  getRange(row: number, column: number, numRows: number, numColumns: number): {
    setValues?(values: unknown): unknown
  }
}

/** Writes clipboard text into the sheet as plain values starting at the active cell. */
export function pastePlainTextValues(sheet: PlainPasteSheetLike | null | undefined, text: string): number {
  if (!sheet || !text) return 0
  const { matrix } = parseClipboardText(text.replace(/\r?\n$/, ''))
  if (matrix.length === 0) return 0
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0)
  if (width === 0) return 0
  const range = sheet.getActiveRange?.()
  const startRow = Math.max(0, Number(range?.getRow?.() ?? 0) || 0)
  const startColumn = Math.max(0, Number(range?.getColumn?.() ?? 0) || 0)
  const neededRows = startRow + matrix.length
  const neededColumns = startColumn + width
  if (typeof sheet.getMaxRows === 'function' && sheet.getMaxRows() < neededRows) sheet.setRowCount?.(neededRows)
  if (typeof sheet.getMaxColumns === 'function' && sheet.getMaxColumns() < neededColumns) sheet.setColumnCount?.(neededColumns)
  const values = matrix.map((row) => Array.from({ length: width }, (_, index) => plainTextCellValue(row[index] ?? '')))
  sheet.getRange(startRow, startColumn, matrix.length, width).setValues?.(values)
  return matrix.length * width
}

export const PLAIN_PASTE_COMMAND_ID = 'yaerp-paste-plain-text'
const PLAIN_PASTE_MENU_KEY = 'yaerpPastePlainText'

/**
 * Registers `粘贴为纯文本（仅值）`: the clipboard text is written as plain
 * values, without formulas or formatting. When the page may not read the
 * clipboard (plain http, Firefox), the next native paste is used instead -
 * `onNeedsKeyboardPaste` tells the user to press Ctrl+V. `Ctrl+Shift+V` arms the
 * same plain paste for keyboard users.
 */
export function registerPlainTextPaste(
  univer: unknown,
  resolveSheet: () => PlainPasteSheetLike | null | undefined,
  callbacks: { onPasted?: (cells: number) => void; onNeedsKeyboardPaste?: () => void; canEdit?: () => boolean } = {}
): { dispose: () => void; pastePlain: () => Promise<void> } | null {
  const disposables: Array<{ dispose?: () => void }> = []
  let armedUntil = 0

  const apply = (text: string) => {
    if (callbacks.canEdit && !callbacks.canEdit()) return
    const cells = pastePlainTextValues(resolveSheet(), text)
    if (cells > 0) callbacks.onPasted?.(cells)
  }

  const pastePlain = async () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (clipboard && typeof clipboard.readText === 'function') {
      try {
        apply(await clipboard.readText())
        return
      } catch {
        // Permission denied: fall through to the keyboard paste.
      }
    }
    armedUntil = Date.now() + 15000
    callbacks.onNeedsKeyboardPaste?.()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'v' || event.key === 'V')) {
      armedUntil = Date.now() + 1500
    }
  }
  const onPaste = (event: ClipboardEvent) => {
    if (Date.now() > armedUntil) return
    armedUntil = 0
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    event.preventDefault()
    event.stopImmediatePropagation()
    apply(text)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('paste', onPaste, true)
    disposables.push({
      dispose: () => {
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('paste', onPaste, true)
      },
    })
  }

  try {
    const injector = getInjector(univer)
    const commandService = injector?.get<ICommandService | undefined>(ICommandService)
    if (commandService?.registerCommand) {
      disposables.push(
        commandService.registerCommand({
          id: PLAIN_PASTE_COMMAND_ID,
          type: CommandType.OPERATION,
          handler: () => {
            void pastePlain()
            return true
          },
        })
      )
    }
    const menuManager = injector?.get<{ mergeMenu?: (source: unknown) => unknown } | undefined>(IMenuManagerService)
    if (menuManager?.mergeMenu) {
      const entry = {
        // Right after `粘贴` (order 2) and before `选择性粘贴` (order 3).
        order: 2.5,
        menuItemFactory: (): IMenuItem => ({
          id: PLAIN_PASTE_MENU_KEY,
          commandId: PLAIN_PASTE_COMMAND_ID,
          title: '粘贴为纯文本（仅值）',
          type: MenuItemType.BUTTON,
        }),
      }
      menuManager.mergeMenu({
        [MenuManagerPosition.CONTEXT_MENU]: {
          [ContextMenuPosition.MAIN_AREA]: { [ContextMenuGroup.FORMAT]: { [PLAIN_PASTE_MENU_KEY]: entry } },
        },
      })
    }
  } catch (error) {
    console.warn('Failed to register the plain text paste:', error)
  }

  return {
    pastePlain,
    dispose: () => disposables.forEach((disposable) => disposable?.dispose?.()),
  }
}

/**
 * Reports every paste, whoever triggered it.
 *
 * A paste runs through `SheetPasteShortKeyCommand`, and that command carries the
 * clipboard payload instead of a `unitId`. The facade callback
 * (`FWorkbook.onCommandExecuted`) filters on `params.unitId`, so it never sees a
 * paste; the raw command service does. Callers use this to re-inspect the sheet
 * after the paste has been applied.
 */
export function registerPasteNotifier(univer: unknown, onPaste: () => void): DisposableLike | null {
  try {
    const injector = getInjector(univer)
    const commandService = injector?.get<ICommandService | undefined>(ICommandService)
    const subscriber = commandService as unknown as CommandServiceLike | undefined
    if (!subscriber?.onCommandExecuted) return null
    const disposable = subscriber.onCommandExecuted((info) => {
      if (!info || info.id !== SheetPasteShortKeyCommand.id) return
      onPaste()
    })
    return disposable ?? null
  } catch (error) {
    console.warn('Failed to subscribe to clipboard pastes:', error)
    return null
  }
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
    // The last range copied from the sheet: `write` uses it to recognise a sheet
    // copy (documents and other editors share the same clipboard service).
    let lastSheetCopy: { html: string; plain: string } | null = null
    if (clipboardService && typeof clipboardService.generateCopyContent === 'function') {
      const original = clipboardService.generateCopyContent
      const patched = function patchedGenerateCopyContent(this: ClipboardServiceLike, ...args: unknown[]) {
        const content = quoteCopyContent(original.apply(this, args), readDisplayValues(args, resolveSheet))
        if (content && typeof content.html === 'string' && typeof content.plain === 'string') {
          lastSheetCopy = { html: content.html, plain: content.plain }
        }
        return content
      }
      clipboardService.generateCopyContent = patched
      disposables.push({
        dispose: () => {
          if (clipboardService.generateCopyContent === patched) clipboardService.generateCopyContent = original
        },
      })
    }

    // Copy side, part two: write plain TSV + HTML + a PNG of the range in one
    // clipboard item (see `writeSheetClipboard`).
    const clipboardInterface = injector.get<ClipboardInterfaceLike | null | undefined>(IClipboardInterfaceService)
    if (clipboardInterface && typeof clipboardInterface.write === 'function') {
      const originalWrite = clipboardInterface.write
      const patchedWrite = function patchedWrite(this: ClipboardInterfaceLike, text: string, html: string) {
        const copy = lastSheetCopy
        lastSheetCopy = null
        if (!copy || copy.html !== html) return originalWrite.call(this, text, html)
        return writeSheetClipboard(text, html).catch((error) => {
          console.warn('Failed to write the sheet clipboard, using the default copy:', error)
          return originalWrite.call(this, text, html)
        })
      }
      clipboardInterface.write = patchedWrite
      disposables.push({
        dispose: () => {
          if (clipboardInterface.write === patchedWrite) clipboardInterface.write = originalWrite
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
