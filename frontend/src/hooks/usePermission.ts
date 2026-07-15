'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { PermissionMatrix, ScopedPermissionLayer } from '@/types'
import { api } from '@/lib/api'

type PermissionSource = 'user' | 'department' | 'role' | 'default'
type PermissionScope = 'cell' | 'row' | 'column' | 'sheet'

function resolveLayerPermission(layer: ScopedPermissionLayer | undefined, col: string, row?: number) {
  if (!layer) return undefined
  if (row !== undefined) {
    const cellPermission = layer.cells?.[`${row}:${col}`]
    if (cellPermission) return { permission: cellPermission, scope: 'cell' as const }
    const rowPermission = layer.rows?.[`${row}`]
    if (rowPermission) return { permission: rowPermission, scope: 'row' as const }
  }
  const columnPermission = layer.columns?.[col]
  return columnPermission ? { permission: columnPermission, scope: 'column' as const } : undefined
}

export function resolveCellPermissionDetail(permissions: PermissionMatrix, col: string, row?: number): { permission: string; source: PermissionSource; scope: PermissionScope } {
  const userPermission = resolveLayerPermission(permissions.userOverrides, col, row)
  if (userPermission) return { ...userPermission, source: 'user' }
  const departmentPermission = resolveLayerPermission(permissions.departmentOverrides, col, row)
  if (departmentPermission) return { ...departmentPermission, source: 'department' }
  const basePermission = resolveLayerPermission({
    rows: permissions.rows || {},
    columns: permissions.columns || {},
    cells: permissions.cells || {},
  }, col, row)
  if (basePermission) return { ...basePermission, source: 'role' }
  return {
    permission: permissions.defaultPermission || (permissions.sheet.canEdit ? 'write' : permissions.sheet.canView ? 'read' : 'none'),
    source: 'default',
    scope: 'sheet',
  }
}

export function resolveCellPermission(permissions: PermissionMatrix, col: string, row?: number) {
  return resolveCellPermissionDetail(permissions, col, row).permission
}

export function usePermission(sheetId: number) {
  const [permissions, setPermissions] = useState<PermissionMatrix | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const loadedSheetIdRef = useRef(0)

  const refreshPermissions = useCallback(() => setRefreshVersion((current) => current + 1), [])

  useEffect(() => {
    let active = true

    async function fetch() {
      if (!sheetId) {
        if (active) {
          setPermissions(null)
          setLoading(false)
        }
        return
      }

      if (active) {
        setLoading(true)
        if (loadedSheetIdRef.current !== sheetId) setPermissions(null)
      }

      try {
        const res = await api.get<PermissionMatrix>(`/sheets/${sheetId}/permissions`)
        if (!active) return
        if (res.code === 0 && res.data) {
          setPermissions(res.data)
          loadedSheetIdRef.current = sheetId
        } else {
          setPermissions(null)
        }
      } catch {
        if (active) {
          setPermissions(null)
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }
    fetch()

    return () => {
      active = false
    }
  }, [refreshVersion, sheetId])

  const canEditCell = (col: string, row?: number): boolean => {
    if (!permissions) return false
    if (!permissions.sheet.canEdit) return false
    return resolveCellPermission(permissions, col, row) === 'write'
  }

  const canViewColumn = (col: string): boolean => {
    if (!permissions) return false
    if (!permissions.sheet.canView) return false
    return resolveCellPermission(permissions, col) !== 'none'
  }

  const isColumnReadOnly = (col: string): boolean => {
    if (!permissions) return true
    return resolveCellPermission(permissions, col) !== 'write'
  }

  return {
    permissions,
    loading,
    canEditCell,
    canViewColumn,
    isColumnReadOnly,
    refreshPermissions,
  }
}
