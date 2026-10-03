import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useAuth } from '../../lib/authStore'

type AuthMode = 'login' | 'register'

export function LoginForm() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<AuthMode>('login')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function switchMode(next: AuthMode) {
    setMode(next)
    setError(null)
    setSuccessMessage(null)
    setPassword('')
    setConfirmPassword('')
    setShowPassword(false)
    setShowConfirmPassword(false)
  }

  async function handleSubmit() {
    setError(null)
    setSuccessMessage(null)

    if (mode === 'login') {
      if (!email.trim() || !password) {
        setError('Vui lòng nhập email và mật khẩu')
        return
      }
      setLoading(true)
      try {
        await login(email.trim(), password)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Đăng nhập thất bại')
      } finally {
        setLoading(false)
      }
      return
    }

    // Register mode
    if (!email.trim() || !password) {
      setError('Vui lòng nhập đầy đủ email và mật khẩu')
      return
    }
    if (password.length < 8) {
      setError('Mật khẩu phải từ 8 ký tự trở lên')
      return
    }
    if (password !== confirmPassword) {
      setError('Mật khẩu xác nhận không khớp')
      return
    }

    setLoading(true)
    try {
      await register(email.trim(), password, fullName.trim() || undefined)
      setSuccessMessage('Đăng ký tài khoản thành công! Vui lòng nhập mật khẩu để đăng nhập.')
      setMode('login')
      setPassword('')
      setConfirmPassword('')
      setShowPassword(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Đăng ký thất bại')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h2 className="m-0 text-[32px] xl:text-[34px] font-bold tracking-[-0.02em] text-[#0f1712]">
          {mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản mới'}
        </h2>
        <p className="m-0 text-[15px] xl:text-[16px] text-[#5b6862]">
          {mode === 'login'
            ? 'Chào mừng trở lại. Nhập thông tin để tiếp tục.'
            : 'Nhập thông tin để bắt đầu sử dụng SMART AIR.'}
        </p>
      </div>

      {/* Success banner */}
      {successMessage ? (
        <div className="rounded-[12px] border border-[#b7f2cb] bg-[#e6fbef] px-4 py-3 text-[14px] font-medium leading-relaxed text-[#0a7a3e]">
          {successMessage}
        </div>
      ) : null}

      {/* Error banner */}
      {error ? (
        <div className="rounded-[12px] border border-[#f8b4b4] bg-[#fdecec] px-4 py-3 text-[14px] font-medium leading-relaxed text-[#a12828]">
          {error}
        </div>
      ) : null}

      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          void handleSubmit()
        }}
      >
        {mode === 'register' ? (
          <label htmlFor="auth-fullname" className="flex flex-col gap-2">
            <span className="text-[14px] font-semibold text-[#0f1712]">Họ và tên</span>
            <input
              id="auth-fullname"
              type="text"
              placeholder="Nguyễn Văn A"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="h-[52px] px-4 rounded-[12px] border border-[#d6dfd9] bg-white text-[16px] text-[#0f1712] placeholder:text-[#9aa69f] outline-none transition-all focus:border-[#0a8f4e] focus:ring-4 focus:ring-[#1ee07f]/22"
            />
          </label>
        ) : null}

        <label htmlFor="auth-email" className="flex flex-col gap-2">
          <span className="text-[14px] font-semibold text-[#0f1712]">Email</span>
          <input
            id="auth-email"
            type="email"
            required
            placeholder="ban@congty.vn"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-[52px] px-4 rounded-[12px] border border-[#d6dfd9] bg-white text-[16px] text-[#0f1712] placeholder:text-[#9aa69f] outline-none transition-all focus:border-[#0a8f4e] focus:ring-4 focus:ring-[#1ee07f]/22"
          />
        </label>

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="auth-password" className="text-[14px] font-semibold text-[#0f1712] cursor-pointer">
              Mật khẩu
            </label>
            {mode === 'login' ? (
              <a
                href="#"
                onClick={(e) => e.preventDefault()}
                className="text-[14px] font-medium text-[#0a8f4e] hover:text-[#066b39] hover:underline whitespace-nowrap"
              >
                Quên mật khẩu?
              </a>
            ) : null}
          </div>
          <div className="relative flex items-center">
            <input
              id="auth-password"
              type={showPassword ? 'text' : 'password'}
              required
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-[52px] pl-4 pr-12 rounded-[12px] border border-[#d6dfd9] bg-white text-[16px] text-[#0f1712] placeholder:text-[#9aa69f] outline-none transition-all focus:border-[#0a8f4e] focus:ring-4 focus:ring-[#1ee07f]/22"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1.5 h-10 w-10 grid place-items-center rounded-lg text-[#4a5750] hover:bg-[#eef3f0] transition-colors cursor-pointer border-0 bg-transparent p-0"
              aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
            >
              {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
            </button>
          </div>
        </div>

        {mode === 'register' ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="auth-confirm-password" className="text-[14px] font-semibold text-[#0f1712] cursor-pointer">
              Xác nhận mật khẩu
            </label>
            <div className="relative flex items-center">
              <input
                id="auth-confirm-password"
                type={showConfirmPassword ? 'text' : 'password'}
                required
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full h-[52px] pl-4 pr-12 rounded-[12px] border border-[#d6dfd9] bg-white text-[16px] text-[#0f1712] placeholder:text-[#9aa69f] outline-none transition-all focus:border-[#0a8f4e] focus:ring-4 focus:ring-[#1ee07f]/22"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-2 top-1.5 h-10 w-10 grid place-items-center rounded-lg text-[#4a5750] hover:bg-[#eef3f0] transition-colors cursor-pointer border-0 bg-transparent p-0"
                aria-label={showConfirmPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              >
                {showConfirmPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
              </button>
            </div>
          </div>
        ) : null}

        {mode === 'login' ? (
          <label className="flex items-center gap-3 text-[15px] text-[#3d4842] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="w-4.5 h-4.5 rounded accent-[#0a8f4e] cursor-pointer m-0"
            />
            <span>Ghi nhớ đăng nhập</span>
          </label>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="h-[54px] w-full border-0 rounded-[12px] bg-[#1ee07f] hover:bg-[#17cc72] text-[#06210f] text-[16px] font-bold cursor-pointer transition-colors flex items-center justify-center disabled:opacity-60 shadow-xs"
        >
          {loading ? (
            <span className="inline-block animate-spin mr-2">⟳</span>
          ) : null}
          {loading
            ? mode === 'login' ? 'Đang đăng nhập…' : 'Đang xử lý…'
            : mode === 'login' ? 'Đăng nhập' : 'Đăng ký tài khoản'}
        </button>
      </form>

      {/* Bottom helper link */}
      <p className="m-0 text-center text-[15px] text-[#5b6862]">
        {mode === 'login' ? (
          <>
            Chưa có tài khoản?{' '}
            <button
              type="button"
              onClick={() => switchMode('register')}
              className="font-semibold text-[#0a8f4e] hover:text-[#066b39] hover:underline cursor-pointer border-0 bg-transparent p-0"
            >
              Đăng ký ngay
            </button>
          </>
        ) : (
          <>
            Đã có tài khoản?{' '}
            <button
              type="button"
              onClick={() => switchMode('login')}
              className="font-semibold text-[#0a8f4e] hover:text-[#066b39] hover:underline cursor-pointer border-0 bg-transparent p-0"
            >
              Đăng nhập ngay
            </button>
          </>
        )}
      </p>
    </div>
  )
}
