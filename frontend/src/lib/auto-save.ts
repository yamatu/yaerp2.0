import type { CellUpdate } from '@/types'
import { api } from './api'
import { wsClient } from './ws'

type SaveCallback = (success: boolean, error?: string) => void

class AutoSave {
  private pendingChanges: Map<string, CellUpdate> = new Map()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private debounceMs = 500
  private saving = false
  private callback: SaveCallback | null = null

  onSave(cb: SaveCallback) {
    this.callback = cb
  }

  addChange(change: CellUpdate) {
    const key = `${change.sheet_id}:${change.row}:${change.col}`
    this.pendingChanges.set(key, change)
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs)
  }

  async flush() {
    if (this.saving || this.pendingChanges.size === 0) return

    this.saving = true
    const changes = Array.from(this.pendingChanges.values())
    this.pendingChanges.clear()

    try {
      // Group by sheet
      const bySheet = new Map<number, CellUpdate[]>()
      for (const c of changes) {
        if (!bySheet.has(c.sheet_id)) bySheet.set(c.sheet_id, [])
        bySheet.get(c.sheet_id)!.push(c)
      }

      for (const [sheetId, sheetChanges] of bySheet) {
        const res = await api.post(`/sheets/${sheetId}/cells`, {
          changes: sheetChanges,
        })
        if (res.code !== 0) {
          throw new Error(res.message)
        }
        // Broadcast via WebSocket
        wsClient.sendBatchUpdate(
          sheetChanges.map((c) => ({
            sheet_id: c.sheet_id,
            row: c.row,
            col: c.col,
            value: c.value,
          }))
        )
      }
      this.callback?.(true)
    } catch (e) {
      // Re-add failed changes
      for (const c of changes) {
        const key = `${c.sheet_id}:${c.row}:${c.col}`
        if (!this.pendingChanges.has(key)) {
          this.pendingChanges.set(key, c)
        }
      }
      this.callback?.(false, (e as Error).message)
    } finally {
      this.saving = false
    }
  }

  hasPendingChanges(): boolean {
    return this.pendingChanges.size > 0
  }
}

export const autoSave = new AutoSave()
