import { useState } from 'react'
import { Field } from '../../components/ui/Field'
import { PrimaryButton } from '../../components/ui/PrimaryButton'
import { useAuth } from '../../lib/authStore'

export function LoginForm() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit() {
    setError(null)
    setLoading(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Đăng nhập thất bại')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void handleSubmit()
      }}
    >
      <Field
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        errorText={error}
      />
      <Field label="Mật khẩu" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <PrimaryButton label="Đăng nhập" loading={loading} onClick={() => void handleSubmit()} />
    </form>
  )
}
