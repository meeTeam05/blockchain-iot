// Ported from app_new/src/components/atoms/AtmosphereCard.tsx.
import type { ReactNode } from 'react'

interface CardProps {
  children: ReactNode
  elevated?: boolean
  className?: string
}

export function Card({ children, elevated = false, className = '' }: CardProps) {
  return (
    <div
      className={`rounded-card border border-line bg-paper p-4 ${elevated ? 'shadow-[0_4px_12px_rgba(0,0,0,0.067)]' : ''} ${className}`}
    >
      {children}
    </div>
  )
}
