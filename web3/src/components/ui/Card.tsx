// Ported from app/src/components/atoms/AtmosphereCard.tsx.
import type { CSSProperties, ReactNode } from 'react'

interface CardProps {
  children: ReactNode
  elevated?: boolean
  className?: string
  style?: CSSProperties
}

export function Card({ children, elevated = false, className = '', style }: CardProps) {
  const shadow = elevated
    ? 'shadow-[0_1px_2px_rgba(14,18,16,0.04),0_14px_40px_-14px_rgba(10,122,62,0.22)]'
    : 'shadow-[0_1px_2px_rgba(14,18,16,0.04),0_6px_24px_-8px_rgba(14,18,16,0.08)]'
  return (
    <div className={`rounded-card border border-line bg-paper p-5 ${shadow} ${className}`} style={style}>
      {children}
    </div>
  )
}
