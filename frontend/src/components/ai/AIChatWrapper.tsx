'use client'

import { useState } from 'react'
import AIChatFAB from '@/components/ai/AIChatFAB'
import AIChatPanel from '@/components/ai/AIChatPanel'
import { isAuthenticated } from '@/lib/auth'

export default function AIChatWrapper() {
  const [chatOpen, setChatOpen] = useState(false)

  if (typeof window === 'undefined') return null
  if (!isAuthenticated()) return null

  return (
    <>
      <AIChatFAB onClick={() => setChatOpen(true)} />
      <AIChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
    </>
  )
}
