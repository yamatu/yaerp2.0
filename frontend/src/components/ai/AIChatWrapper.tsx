'use client'

import { useEffect, useState } from 'react'
import AIChatFAB from '@/components/ai/AIChatFAB'
import AIChatPanel from '@/components/ai/AIChatPanel'
import { isAuthenticated } from '@/lib/auth'

export default function AIChatWrapper() {
  const [chatOpen, setChatOpen] = useState(false)
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

  if (!mounted) return null
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
