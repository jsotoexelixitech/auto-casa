import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import Icon from '../components/ui/Icon'
import { useAuth } from '../context/AuthContext'
import { ROLE_LABELS } from '../data/mockData'
import { useToast } from '../context/ToastContext'

export default function LoginPage() {
  const { users, login, user } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [selected, setSelected] = useState(user?.id ?? users[0].id)
  const [email, setEmail] = useState(
    users.find((u) => u.id === (user?.id ?? users[0].id))?.email,
  )
  const [password, setPassword] = useState('Demo1234!')
  const [loading, setLoading] = useState(false)
  const [showPwd, setShowPwd] = useState(false)

  const handleSelect = (id) => {
    setSelected(id)
    setEmail(users.find((u) => u.id === id)?.email)
  }

  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const u = await login(email, password)
      toast.success(`Bienvenido, ${u.name.split(' ')[0]}`, {
        title: 'Sesión iniciada',
      })
      navigate('/dashboard')
    } catch (err) {
      const msg =
        err?.status === 401 || err?.status === 400
          ? 'Email o contraseña incorrectos.'
          : err?.message ?? 'Credenciales inválidas'
      toast.error(msg, { title: 'Error de acceso' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="min-h-screen flex"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
    >
      {/* Left brand panel — desktop only */}
      <aside className="hidden lg:flex flex-col justify-between bg-gradient-brand text-on-primary p-10 xl:p-12 w-[44%] xl:w-[40%] relative overflow-hidden">
        {/* Decorative gradient orbs */}
        <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-accent-500/30 rounded-full blur-3xl" />
        <div className="absolute -top-20 -left-20 w-80 h-80 bg-brand-400/20 rounded-full blur-3xl" />
        <div className="absolute inset-0 opacity-20 mix-blend-overlay">
          <img
            src="https://images.unsplash.com/photo-1502920917128-1aa500764cbd?auto=format&fit=crop&w=1600&q=80"
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
        {/* Subtle dot pattern */}
        <svg className="absolute inset-0 w-full h-full opacity-10" aria-hidden>
          <defs>
            <pattern id="dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1.2" fill="white" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#dots)" />
        </svg>

        <div className="relative z-10">
          <img
            src="/logo-lamundial-sidebar.png"
            alt="La Mundial de Seguros"
            className="h-12 w-auto object-contain"
            draggable="false"
          />
        </div>

        <div className="relative z-10 max-w-md">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent-500/20 border border-accent-400/40 text-accent-100 text-caption uppercase tracking-widest font-bold mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-400" />
            52 años contigo
          </span>
          <h1 className="text-display-2xl font-bold leading-[1.05] mb-4 tracking-tight">
            Protege tu vehículo en{' '}
            <span className="text-accent-400">minutos</span>, no en días.
          </h1>
          <p className="text-body-lg opacity-90">
            Captura guiada con IA, validación automática de piezas y trazabilidad
            total — desde tu celular, en minutos y sin intermediarios.
          </p>
        </div>

        <div className="relative z-10 grid grid-cols-3 gap-3">
          <Stat icon="speed" label="Inspección" value="< 8 min" />
          <Stat icon="lock" label="Trazabilidad" value="100%" />
          <Stat icon="auto_awesome" label="IA" value="98% acc." />
        </div>
      </aside>

      {/* Right form panel */}
      <main className="flex-1 flex items-center justify-center container-pad py-8 sm:py-10 bg-background relative overflow-hidden">
        {/* Mobile decorative bg */}
        <div className="lg:hidden absolute inset-x-0 top-0 h-64 bg-gradient-brand">
          <div className="absolute -bottom-20 -right-20 w-64 h-64 bg-accent-500/30 rounded-full blur-3xl" />
          <svg className="absolute inset-0 w-full h-full opacity-15" aria-hidden>
            <defs>
              <pattern id="dotsm" x="0" y="0" width="18" height="18" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="1" fill="white" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#dotsm)" />
          </svg>
        </div>

        <div className="w-full max-w-md relative z-10">
          {/* Mobile brand block */}
          <div className="lg:hidden text-center text-white mb-6 mt-2">
            <img
              src="/logo-lamundial-sidebar.png"
              alt="La Mundial de Seguros"
              className="h-12 w-auto object-contain mx-auto mb-2"
              draggable="false"
            />
            <p className="text-caption opacity-80 mt-1 uppercase tracking-widest">
              52 años contigo · Auto Casco
            </p>
          </div>

          <div className="card-elev2 p-5 sm:p-7">
            <h2 className="text-headline-lg font-bold text-primary mb-1">
              Iniciar Sesión
            </h2>
            <p className="text-body-md text-on-surface-variant mb-4">
              Selecciona un perfil de demostración para explorar la plataforma.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => handleSelect(u.id)}
                  className={clsx(
                    'p-2.5 rounded-xl border-2 text-left transition-all flex flex-col gap-1.5 min-h-[80px] active:scale-[0.98]',
                    selected === u.id
                      ? 'border-primary bg-primary-fixed/40 ring-2 ring-primary/20'
                      : 'border-outline-variant/60 hover:border-primary/40 bg-white',
                  )}
                >
                  <div
                    className={clsx(
                      'w-9 h-9 rounded-full text-white font-bold flex items-center justify-center text-sm shrink-0',
                      u.color,
                    )}
                  >
                    {u.avatar}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-on-surface truncate leading-tight">
                      {u.name.split(' ')[0]}
                    </p>
                    <p className="text-[11px] text-on-surface-variant truncate">
                      {ROLE_LABELS[u.role]}
                    </p>
                  </div>
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="flex flex-col gap-3">
              <div>
                <label className="label">Correo electrónico</label>
                <div className="relative">
                  <Icon
                    name="mail"
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[20px]"
                  />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input pl-10"
                    required
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="label mb-0">Contraseña</label>
                  <button
                    type="button"
                    onClick={() => setPassword('Demo1234!')}
                    className="text-[11px] text-primary hover:underline font-semibold flex items-center gap-1"
                    title="Auto-rellenar"
                  >
                    <Icon name="auto_fix_high" className="text-[14px]" />
                    Demo: <code className="font-mono bg-primary-fixed px-1.5 py-0.5 rounded">Demo1234!</code>
                  </button>
                </div>
                <div className="relative">
                  <Icon
                    name="lock"
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[20px]"
                  />
                  <input
                    type={showPwd ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input pl-10 pr-10"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd((s) => !s)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 btn-icon"
                    aria-label="Mostrar/ocultar contraseña"
                  >
                    <Icon name={showPwd ? 'visibility_off' : 'visibility'} className="text-[20px]" />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 flex-wrap text-caption">
                <label className="flex items-center gap-1.5 text-on-surface-variant min-h-[44px]">
                  <input
                    type="checkbox"
                    defaultChecked
                    className="w-4 h-4 rounded text-primary focus:ring-primary/20"
                  />
                  Mantener sesión
                </label>
                <a href="#" className="text-primary hover:underline font-semibold min-h-[44px] flex items-center">
                  ¿Olvidaste tu contraseña?
                </a>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="btn-primary text-body-md py-3 mt-1"
              >
                {loading ? (
                  <>
                    <Icon name="progress_activity" className="animate-spin" />
                    Verificando…
                  </>
                ) : (
                  <>
                    <Icon name="login" /> Entrar
                  </>
                )}
              </button>
            </form>
          </div>

          <p className="text-center text-caption text-on-surface-variant mt-4">
            Demo con datos de prueba — No se realizan transacciones reales.
          </p>
        </div>
      </main>
    </div>
  )
}

function Stat({ icon, label, value }) {
  return (
    <div className="bg-white/10 backdrop-blur-md rounded-xl p-3 border border-white/20">
      <Icon name={icon} className="text-[22px] text-accent-400 mb-1" />
      <p className="text-[11px] opacity-80 uppercase tracking-wider">{label}</p>
      <p className="font-bold text-body-md leading-tight">{value}</p>
    </div>
  )
}
