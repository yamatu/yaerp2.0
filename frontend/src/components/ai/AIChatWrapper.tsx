'use client'

import { useEffect, useState } from 'react'
import AIChatFAB from '@/components/ai/AIChatFAB'
import AIChatPanel from '@/components/ai/AIChatPanel'
import { isAuthenticated, getStoredUser } from '@/lib/auth'
import { isBooleanPreference, useUserPreference } from '@/hooks/useUserPreference'

export default function AIChatWrapper() {
  const userId = getStoredUser()?.id
  const [chatOpen, setChatOpen, chatPreferenceReady] = useUserPreference(
    userId,
    'ai.chat-open',
    false,
    isBooleanPreference
  )
  const [hidden, setHidden] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Listen for panels/modals opening in the editor that should hide the FAB
  useEffect(() => {
    if (!mounted) return
    const observer = new MutationObserver(() => {
      setHidden(document.body.classList.contains('fab-hidden'))
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [mounted])

  if (!mounted || !chatPreferenceReady) return null
  if (!isAuthenticated()) return null
  if (hidden && !chatOpen) return null

  return (
    <>
      <AIChatFAB
        onClick={() => setChatOpen((v) => !v)}
        isOpen={chatOpen}
      />
      <AIChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
    </>
  )
}
