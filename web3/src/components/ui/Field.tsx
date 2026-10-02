// Ported from app_new/src/components/atoms/Field.tsx. Used for the API
// login form (B1).
import type { InputHTMLAttributes } from 'react'

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string
  errorText?: string | null
}

export function Field({ label, errorText, id, ...inputProps }: FieldProps) {
  const hasError = Boolean(errorText)
  const inputId = id ?? label.toLowerCase().replace(/\s+/g, '-')
  return (
    <div>
      <label htmlFor={inputId} className="text-[15px] font-medium text-ink">
        {label}
      </label>
      <input
        id={inputId}
        autoCapitalize="none"
        className={`mt-2 h-14 w-full rounded-input border bg-paper px-4 text-[15px] text-ink ${hasError ? 'border-danger' : 'border-line'}`}
        {...inputProps}
      />
      {hasError ? <p className="mt-1 text-[13px] text-danger">{errorText}</p> : null}
    </div>
  )
}
