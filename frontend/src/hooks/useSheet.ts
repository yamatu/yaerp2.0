'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Sheet, Row, Workbook } from '@/types'
import { api } from '@/lib/api'

export function useWorkbooks() {
  const [workbooks, setWorkbooks] = useState<Workbook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchWorkbooks = useCallback(async () => {
    setLoading(true)
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
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchWorkbooks()
  }, [fetchWorkbooks])

  return { workbooks, loading, error, refresh: fetchWorkbooks }
}

export function useWorkbook(id: string | number) {
  const [workbook, setWorkbook] = useState<Workbook | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchWorkbook = useCallback(async () => {
    if (!id) return
    setLoading(true)
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
    setLoading(false)
  }, [id])

  useEffect(() => {
    fetchWorkbook()
  }, [fetchWorkbook])

  return { workbook, loading, error, refresh: fetchWorkbook }
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
        setRows(Array.isArray(res.data) ? res.data : [])
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
