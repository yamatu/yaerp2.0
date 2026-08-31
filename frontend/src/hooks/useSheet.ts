'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Sheet, Row, Workbook } from '@/types'
import { api } from '@/lib/api'
import { subscribeDataChanged } from '@/lib/dataEvents'

function normalizeRows(rows: Row[]): Row[] {
  return rows
    .filter((row) => Number.isInteger(row.row_index) && row.row_index >= 0)
    .sort((left, right) => left.row_index - right.row_index || left.id - right.id)
}

export function useWorkbooks() {
  const [workbooks, setWorkbooks] = useState<Workbook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchWorkbooks = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const res = await api.get<Workbook[]>('/workbooks')
      if (res.code === 0 && res.data) {
        setWorkbooks(res.data)
      } else {
        setError(res.message || '加载失败')
      }
    } catch {
      setError('网络错误')
    }
    if (!silent) setLoading(false)
  }, [])

  useEffect(() => {
    fetchWorkbooks()
  }, [fetchWorkbooks])

  useEffect(() => subscribeDataChanged((detail) => {
    if (!detail.resourcesChanged) return
    void fetchWorkbooks(true)
  }), [fetchWorkbooks])

  const refresh = useCallback(() => fetchWorkbooks(false), [fetchWorkbooks])
  const refreshSilently = useCallback(() => fetchWorkbooks(true), [fetchWorkbooks])

  return { workbooks, loading, error, refresh, refreshSilently }
}

export function useWorkbook(id: string | number) {
  const [workbook, setWorkbook] = useState<Workbook | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchWorkbook = useCallback(async (silent = false) => {
    if (!id) return
    if (!silent) setLoading(true)
    setError(null)
    try {
      const res = await api.get<Workbook>(`/workbooks/${id}`)
      if (res.code === 0 && res.data) {
        setWorkbook(res.data)
      } else {
        setError(res.message || '工作簿未找到')
      }
    } catch {
      setError('网络错误')
    }
    if (!silent) setLoading(false)
  }, [id])

  useEffect(() => {
    fetchWorkbook()
  }, [fetchWorkbook])

  useEffect(() => subscribeDataChanged((detail) => {
    if (!detail.resourcesChanged) return
    void fetchWorkbook(true)
  }), [fetchWorkbook])

  const refresh = useCallback(() => fetchWorkbook(false), [fetchWorkbook])
  const refreshSilently = useCallback(() => fetchWorkbook(true), [fetchWorkbook])

  return { workbook, loading, error, refresh, refreshSilently }
}

export function useSheetData(sheetId: number, initialSheet?: Sheet | null) {
  const [rows, setRows] = useState<Row[]>([])
  const [sheet, setSheet] = useState<Sheet | null>(initialSheet ?? null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setSheet(initialSheet ?? null)
  }, [initialSheet])

  const fetchData = useCallback(async () => {
    if (!sheetId) return
    setLoading(true)
    try {
      const res = await api.get<Row[]>(`/sheets/${sheetId}/data`)
      if (res.code === 0) {
        setRows(Array.isArray(res.data) ? normalizeRows(res.data) : [])
      } else {
        setRows([])
      }
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [sheetId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { sheet, rows, loading, refresh: fetchData, setRows, setSheet }
}
