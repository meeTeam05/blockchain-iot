// Ported from app_new/src/components/atoms/Field.tsx. Used for the API
// login form (B1).
import type { InputHTMLAttributes, ReactNode } from 'react'

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string
  errorText?: string | null
  labelRight?: ReactNode
  rightElement?: ReactNode
}

export function Field({ label, errorText, id, labelRight, rightElement, ...inputProps }: FieldProps) {
  const hasError = Boolean(errorText)
  const inputId = id ?? label.toLowerCase().replace(/\s+/g, '-')
  return (
    <div>
      <div className="flex items-center justify-between">
        <label htmlFor={inputId} className="text-sm font-semibold text-ink">
          {label}
        </label>
        {labelRight}
      </div>
      <div className="relative mt-2">
        <input
          id={inputId}
          autoCapitalize="none"
          className={`h-12 w-full rounded-xl border bg-paper px-4 text-sm text-ink transition-colors focus:border-emerald-500 focus:outline-hidden ${rightElement ? 'pr-11' : ''} ${hasError ? 'border-danger' : 'border-line'}`}
          {...inputProps}
        />
        {rightElement ? (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center">
            {rightElement}
          </div>
        ) : null}
      </div>
      {hasError ? <p className="mt-1 text-[13px] text-danger">{errorText}</p> : null}
    </div>
  )
}
