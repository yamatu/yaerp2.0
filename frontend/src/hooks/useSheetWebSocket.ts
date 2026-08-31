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
      wsClient.leaveSheet(sheetId)
      // The client is a singleton, but this hook owns the connection used by
      // the workbook screen. Closing it on unmount prevents an abandoned tab
      // from keeping a server-side WebSocket forever.
      wsClient.disconnect()
    }
  }, [sheetId])
}
