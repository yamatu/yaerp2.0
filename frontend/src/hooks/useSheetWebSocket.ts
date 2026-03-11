'use client'

import { useEffect, useRef } from 'react'
import { wsClient } from '@/lib/ws'

export function useSheetWebSocket(sheetId: number, onReload?: () => Promise<void> | void) {
  const onReloadRef = useRef(onReload)

  useEffect(() => {
    onReloadRef.current = onReload
  }, [onReload])

  useEffect(() => {
    if (!sheetId) return

    wsClient.connect()
    wsClient.joinSheet(sheetId)

    const unsubscribeReload = wsClient.on('sheet_reload', (msg) => {
      if (msg.sheetId !== sheetId) return
      void onReloadRef.current?.()
    })

    return () => {
      unsubscribeReload()
    }
  }, [sheetId])
}
