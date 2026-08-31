'use client'

import { useEffect, useState, type ReactNode } from 'react'

interface Props {
  src?: string | null
  alt?: string
  className?: string
  fallback: ReactNode
}

export function WhatsAppAvatarImage({ src, alt = '', className = 'h-full w-full object-cover', fallback }: Props) {
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [src])

  if (!src || failed) return <>{fallback}</>
  return <img src={src} alt={alt} className={className} onError={() => setFailed(true)} referrerPolicy="no-referrer" />
}
