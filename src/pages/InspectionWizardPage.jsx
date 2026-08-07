import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useBeforeUnload, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import PageHeader from '../components/ui/PageHeader'
import WizardStickyFooter from '../components/ui/WizardStickyFooter'
import Stepper from '../components/ui/Stepper'
import Icon from '../components/ui/Icon'
import StatusChip from '../components/ui/StatusChip'
import Modal from '../components/ui/Modal'
import Step1Documents from './inspection/Step1Documents'
import Step2Location from './inspection/Step2Location'
import Step3Photos from './inspection/Step3Photos'
import Step5Review from './inspection/Step5Review'
import { useInspectionState } from './inspection/useInspectionState'
import { useToast } from '../context/ToastContext'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { determinarPlan } from '../utils/planEngine'
import { getDynamicSequences, getSequenceCompletionStats } from '../utils/sequencesConfig'
import ResultadoPlan from '../components/inspection/ResultadoPlan'
import PaymentStep from '../components/inspection/PaymentStep'
import PaymentSuccess from '../components/inspection/PaymentSuccess'
import { validateStep1 } from './inspection/step1Validation'
import { shouldBypassLeaveGuard } from '../utils/navigationGuard'
import { payments } from '../services/api'
import {
  loadInspectionDraft,
  saveInspectionDraft,
  updateInspectionDraft,
} from '../utils/inspectionDraft'
import {
  buildIdOperacion,
  buildPaymentRedirectUrl,
  checkoutAmountsForIframe,
  isPaymentCallbackUrl,
  resolvePayerFromDraft,
} from '../utils/checkoutPago'
import { upsertInspectionRecord } from '../utils/emissionResult'
import {
  INSPECTION_WIZARD_STEPS as STEPS,
  RESULT_STEP,
  PAYMENT_STEP,
  EMISSION_STEP,
} from '../utils/inspectionWizardSteps'

export default function InspectionWizardPage() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { addInspection, updateInspection, getInspection, addActivity, getVehicle, vehicles, setVehicles } = useData()
  const { user } = useAuth()

  const isEditing = !!id
  const existingInspection = isEditing ? getInspection(id) : null
  const resumeDraft = !isEditing && searchParams.get('resume') === '1'
  const initialStep = isEditing ? 3 : 0

  const [step, setStep]           = useState(initialStep)
  const [resultado, setResultado] = useState(null)   // plan result post-envío
  const [phase, setPhase]         = useState('result')   // 'result' | 'success'
  const [paymentData, setPaymentData] = useState(null)
  const [selectedPlan, setSelectedPlan] = useState(null)
  const [confirmPlanOpen, setConfirmPlanOpen] = useState(false)
  const [sumaValidationTick, setSumaValidationTick] = useState(0)
  const [iframeUrl, setIframeUrl] = useState('')
  const [iframeLoading, setIframeLoading] = useState(false)
  const [iframeError, setIframeError] = useState('')
  const [idOperacion, setIdOperacion] = useState(null)
  const [step1ValidateTrigger, setStep1ValidateTrigger] = useState(0)
  const state = useInspectionState()
  const hydratedRef = useRef(false)
  const ssoKeyRef = useRef('')

  const inspectionNumber = useMemo(() => {
    if (existingInspection) return existingInspection.numero
    return `INS-2026-${String(900 + Math.floor(Math.random() * 99)).padStart(3, '0')}`
  }, [existingInspection])

  const planParaPago = selectedPlan
  const frecuenciaLabel =
    planParaPago?.frecuencia?.xdescripcion
    || (typeof planParaPago?.frecuenciaCodigo === 'string' ? planParaPago.frecuenciaCodigo : null)
    || null
  const coberturaLabel =
    planParaPago?.casco?.nombre
    || null
  const sumaAseguradaLabel = (() => {
    const n = Number(planParaPago?.casco?.sumaAsegurada)
    if (!Number.isFinite(n) || n <= 0) return null
    const hasDecimals = Math.abs(n % 1) > 1e-9
    return `$${n.toLocaleString('es-VE', {
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: 2,
    })}`
  })()
  const tasaLabel = (() => {
    const n = Number(planParaPago?.casco?.tasa)
    if (!Number.isFinite(n) || n < 0) return null
    return `${String(n.toFixed(2)).replace('.', ',')} %`
  })()
  const montoPagarLabel = (() => {
    const n = Number(
      planParaPago?.prima?.cuota
      ?? planParaPago?.prima?.monto
      ?? planParaPago?.prima?.anual,
    )
    if (!Number.isFinite(n) || n <= 0) return null
    return `$${n.toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  })()

  const assertPlanReadyForPayment = () => {
    if (!planParaPago?.id) {
      toast.error('Selecciona un plan antes de continuar.', { title: 'Plan requerido' })
      return false
    }
    if (!planParaPago?.casco?.cobertura) {
      toast.error('Selecciona una cobertura de casco para continuar.', {
        title: 'Cobertura requerida',
      })
      return false
    }
    const suma = Number(planParaPago?.casco?.sumaAsegurada)
    const sumaOk = planParaPago?.casco?.sumaValida === true && Number.isFinite(suma) && suma > 0
    if (!sumaOk) {
      setSumaValidationTick((n) => n + 1)
      toast.error('La suma asegurada es obligatoria y debe ser mayor a 0.', {
        title: 'Suma asegurada',
      })
      return false
    }
    if (!planParaPago?.frecuenciaCodigo && !planParaPago?.frecuencia?.cvalor) {
      toast.error('Selecciona una frecuencia de pago para continuar.', {
        title: 'Frecuencia requerida',
      })
      return false
    }
    return true
  }

  // Reanudar borrador tras fallo de pago / redirect
  useEffect(() => {
    if (isEditing || hydratedRef.current) return
    if (!resumeDraft) return
    const draft = loadInspectionDraft()
    if (!draft) return
    hydratedRef.current = true
    if (draft.titular) state.setTitular(draft.titular)
    if (draft.tomador) state.setTomador(draft.tomador)
    if (typeof draft.tomadorEsTitular === 'boolean') state.setTomadorEsTitular(draft.tomadorEsTitular)
    if (draft.docs) state.setDocs((prev) => ({ ...prev, ...draft.docs }))
    if (draft.vehiculo) state.setVehiculo((prev) => ({ ...prev, ...draft.vehiculo }))
    if (draft.ubicacion) state.setUbicacion((prev) => ({ ...prev, ...draft.ubicacion }))
    if (draft.resultado) setResultado(draft.resultado)
    if (draft.selectedPlan) setSelectedPlan(draft.selectedPlan)
    if (draft.idOperacion) setIdOperacion(draft.idOperacion)
    if (typeof draft.step === 'number') setStep(draft.step)
    toast.info('Se restauraron los datos de tu inspección.', { title: 'Borrador recuperado' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once
  }, [resumeDraft, isEditing])

  // Persistir borrador en cada avance relevante (sin perder datos si falla el pago)
  useEffect(() => {
    if (isEditing || phase === 'success') return
    saveInspectionDraft({
      inspectionNumber,
      step,
      idOperacion,
      titular: state.titular,
      tomador: state.tomador,
      tomadorEsTitular: state.tomadorEsTitular,
      docs: state.docs,
      vehiculo: state.vehiculo,
      ubicacion: state.ubicacion,
      resultado,
      selectedPlan: planParaPago,
      photos: state.photos,
    })
  }, [
    isEditing,
    phase,
    step,
    idOperacion,
    resultado,
    planParaPago,
    state.titular,
    state.tomador,
    state.tomadorEsTitular,
    state.docs,
    state.vehiculo,
    state.ubicacion,
    state.photos,
    inspectionNumber,
  ])

  const startCheckoutSso = useCallback(async () => {
    const plan = planParaPago
    if (!plan?.id) {
      setIframeError('Selecciona un plan antes de pagar.')
      return
    }

    const opId = idOperacion || buildIdOperacion(inspectionNumber)
    setIframeLoading(true)
    setIframeError('')
    setIdOperacion(opId)

    let amounts
    try {
      amounts = await checkoutAmountsForIframe(plan, state.vehiculo)
    } catch (err) {
      setIframeLoading(false)
      setIframeError(err?.message || 'No se pudo cotizar el plan seleccionado para el pago.')
      toast.error(err?.message || 'Error al cotizar plan de pago', { title: 'Pagos' })
      return
    }

    if (!amounts.totalUsd && !amounts.totalVes) {
      setIframeLoading(false)
      setIframeError('No hay montos de cotización para iniciar el pago.')
      return
    }

    const ssoKey = `${opId}:${amounts.planId}:${amounts.totalUsd}:${amounts.totalVes}`
    if (ssoKeyRef.current === ssoKey && iframeUrl) {
      setIframeLoading(false)
      return
    }

    const payer = resolvePayerFromDraft({
      tomador: state.tomador,
      titular: state.titular,
      tomadorEsTitular: state.tomadorEsTitular,
    })
    const redirectUrl = buildPaymentRedirectUrl(opId)

    saveInspectionDraft({
      inspectionNumber,
      step: PAYMENT_STEP,
      idOperacion: opId,
      titular: state.titular,
      tomador: state.tomador,
      tomadorEsTitular: state.tomadorEsTitular,
      docs: state.docs,
      vehiculo: state.vehiculo,
      ubicacion: state.ubicacion,
      resultado,
      selectedPlan: plan,
      photos: state.photos,
      checkout: {
        ...amounts,
        redirectUrl,
        createdAt: new Date().toISOString(),
      },
    })

    try {
      const data = await payments.createCheckoutSso({
        idOperacion: opId,
        title: `Pago ${plan.nombre || 'póliza Auto'}`,
        subtitle: 'La Mundial de Seguros',
        totalVes: amounts.totalVes,
        totalUsd: amounts.totalUsd,
        exchangeRate: amounts.exchangeRate,
        lines: [
          {
            label: `Prima ${amounts.label}`,
            amountVes: amounts.totalVes,
            amountUsd: amounts.totalUsd,
          },
        ],
        documentType: payer.documentType,
        documentNumber: payer.documentNumber,
        payerName: payer.name,
        payerPhone: payer.phone,
        redirectUrl,
        cproductor: '80080',
      })
      const url = data?.redirect_url || data?.redirectUrl || ''
      if (!url) throw new Error('Nexus no devolvió URL de pagos')
      ssoKeyRef.current = ssoKey
      setIframeUrl(url)
    } catch (err) {
      ssoKeyRef.current = ''
      setIframeUrl('')
      setIframeError(err?.message || 'No se pudo iniciar el portal de pagos')
      toast.error(err?.message || 'Error al iniciar SSO de pagos', { title: 'Pagos' })
    } finally {
      setIframeLoading(false)
    }
  }, [
    planParaPago,
    idOperacion,
    iframeUrl,
    inspectionNumber,
    state.tomador,
    state.titular,
    state.tomadorEsTitular,
    state.docs,
    state.vehiculo,
    state.ubicacion,
    state.photos,
    toast,
  ])

  useEffect(() => {
    if (step !== PAYMENT_STEP || !resultado?.elegible) return
    startCheckoutSso()
    // Solo al entrar / cambiar plan·frecuencia — evita bucles SSO
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, resultado?.elegible, selectedPlan?.id, selectedPlan?.frecuenciaCodigo])

  /** Si el iframe aterriza en /pago/resultado, promover a la ventana principal. */
  const handleIframeCallback = useCallback((href) => {
    if (!href || !isPaymentCallbackUrl(href)) return
    try {
      const u = new URL(href, window.location.origin)
      navigate(`${u.pathname}${u.search}`)
    } catch {
      window.location.assign(href)
    }
  }, [navigate])

  /** postMessage desde el portal (si lo envía) o polling del notify. */
  useEffect(() => {
    if (step !== PAYMENT_STEP || !idOperacion) return undefined

    const onMessage = (event) => {
      const data = event?.data
      if (!data || typeof data !== 'object') return
      const verified =
        data.paymentVerified === true
        || data.status === 'ok'
        || String(data.code || '').toUpperCase() === 'ACCP'
        || data.type === 'payment.success'
        || data.event === 'payment.success'
      const op = String(data.idOperacion || data.referenceId || '')
      if (!verified) return
      if (op && op !== idOperacion) return
      navigate(`/pago/resultado?idOperacion=${encodeURIComponent(idOperacion)}&status=ok`)
    }
    window.addEventListener('message', onMessage)

    let cancelled = false
    let attempts = 0
    const poll = async () => {
      if (cancelled) return
      try {
        const st = await payments.getCheckoutStatus(idOperacion)
        if (cancelled) return
        if (st?.paymentVerified || st?.status === 'ok') {
          navigate(`/pago/resultado?idOperacion=${encodeURIComponent(idOperacion)}&status=ok`)
          return
        }
        if (st?.status === 'error') {
          navigate(`/pago/resultado?idOperacion=${encodeURIComponent(idOperacion)}&status=error`)
          return
        }
      } catch {
        /* ignore */
      }
      attempts += 1
      // Poll largo: el notify solo llega si NEXUS_NOTIFY_URL es alcanzable
      if (attempts < 60) window.setTimeout(poll, 2500)
    }
    const t0 = window.setTimeout(poll, 3000)

    return () => {
      cancelled = true
      window.clearTimeout(t0)
      window.removeEventListener('message', onMessage)
    }
  }, [step, idOperacion, navigate])

  // Al cambiar de paso (o fase de pago), partir siempre desde el tope de la página
  useLayoutEffect(() => {
    if (isEditing) return undefined

    const scrollTop = () => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
    }

    scrollTop()
    const frame = window.requestAnimationFrame(scrollTop)
    return () => window.cancelAnimationFrame(frame)
  }, [step, phase, isEditing])

  // Confirmar al abandonar el flujo (sidebar, back, etc.).
  // No bloquear la transición natural al resultado de pago / emisión.
  // Tampoco bloquear si el usuario ya confirmó cerrar sesión.
  const blocker = useBlocker(({ nextLocation }) => {
    if (shouldBypassLeaveGuard()) return false
    if (isEditing || phase === 'success') return false
    if (String(nextLocation?.pathname || '').startsWith('/pago/')) return false
    return true
  })

  // Si el logout activó el bypass con el blocker ya en "blocked", avanzar sin pedir confirmación de inspección.
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (!shouldBypassLeaveGuard()) return
    blocker.proceed?.()
  }, [blocker])

  const shouldWarnUnload = !isEditing && phase !== 'success'

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!shouldWarnUnload) return
        event.preventDefault()
      },
      [shouldWarnUnload],
    ),
  )

  const leaveConfirmModal = (
    <Modal
      open={blocker.state === 'blocked'}
      onClose={() => blocker.reset?.()}
      title="Confirmación"
      subtitle="¿Deseas salir de la inspección?"
      icon="warning"
      size="sm"
      headerSize="compact"
      footer={
        <>
          <button type="button" onClick={() => blocker.reset?.()} className="btn-soft flex-1 sm:flex-none">
            Cancelar
          </button>
          <button type="button" onClick={() => blocker.proceed?.()} className="btn-accent flex-1 sm:flex-none">
            Si, deseo salir
          </button>
        </>
      }
    >
      <p className="text-body-md text-on-surface-variant">
        Si sales ahora, se perderán los datos y fotos cargados en este flujo.
      </p>
    </Modal>
  )

  const planConfirmModal = (
    <Modal
      open={confirmPlanOpen}
      onClose={() => setConfirmPlanOpen(false)}
      title="Confirmación"
      subtitle="¿Deseas continuar con esta selección?"
      icon="verified_user"
      size="sm"
      headerSize="compact"
      footer={
        <>
          <button
            type="button"
            onClick={() => setConfirmPlanOpen(false)}
            className="btn-soft flex-1 sm:flex-none"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!assertPlanReadyForPayment()) {
                setConfirmPlanOpen(false)
                return
              }
              const plan = planParaPago
              setSelectedPlan(plan)
              try {
                const saved = await upsertInspectionRecord(
                  { getInspection, addInspection, updateInspection, vehicles, setVehicles },
                  {
                    id: inspectionNumber,
                    numero: inspectionNumber,
                    estado: 'Pendiente de pago',
                    tipo: 'Auto-Gestionable',
                    progreso: 90,
                    asignadoA: user?.id,
                    titular: state.titular,
                    tomador: state.tomador,
                    tomadorEsTitular: state.tomadorEsTitular,
                    vehiculo: state.vehiculo,
                    ubicacion: state.ubicacion,
                    resultado,
                    selectedPlan: plan,
                    planRecomendado: plan?.cplan || plan?.id || null,
                    danios: Array.isArray(state.danios) ? state.danios : [],
                  },
                )
                if (saved?.dbId) {
                  updateInspectionDraft({ inspectionDbId: saved.dbId, inspectionNumber })
                }
                if (saved?.persisted) {
                  toast.success(`Inspección ${saved.numero || inspectionNumber} guardada`, {
                    title: 'Base de datos',
                    duration: 3500,
                  })
                } else {
                  toast.warning(saved?.error || 'No se pudo guardar en BD (queda en el dispositivo)', {
                    title: 'Aviso de guardado',
                    duration: 5500,
                  })
                }
              } catch (err) {
                toast.error(err?.message || 'Error al guardar la inspección', {
                  title: 'Base de datos',
                  duration: 6000,
                })
              }
              setConfirmPlanOpen(false)
              setStep(PAYMENT_STEP)
            }}
            className="btn-primary flex-1 sm:flex-none"
          >
            Aceptar y continuar
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-xl bg-surface-container-low border border-outline-variant/30 px-4 py-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-caption text-on-surface-variant font-bold uppercase tracking-wide">
              Plan
            </span>
            <span className="text-label-md font-semibold text-primary text-right truncate">
              {planParaPago?.nombre || '—'}
            </span>
          </div>
          {frecuenciaLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-caption text-on-surface-variant font-bold uppercase tracking-wide">
                Frecuencia
              </span>
              <span className="text-label-md font-semibold text-on-surface text-right truncate">
                {frecuenciaLabel}
              </span>
            </div>
          )}
          {coberturaLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-caption text-on-surface-variant font-bold uppercase tracking-wide">
                Cobertura
              </span>
              <span className="text-label-md font-semibold text-on-surface text-right truncate">
                {coberturaLabel}
              </span>
            </div>
          )}
          {sumaAseguradaLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-caption text-on-surface-variant font-bold uppercase tracking-wide">
                Suma asegurada
              </span>
              <span className="text-label-md font-semibold text-on-surface text-right tabular-nums truncate">
                {sumaAseguradaLabel}
              </span>
            </div>
          )}
          {tasaLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-caption text-on-surface-variant font-bold uppercase tracking-wide">
                Tasa
              </span>
              <span className="text-label-md font-semibold text-on-surface text-right tabular-nums truncate">
                {tasaLabel}
              </span>
            </div>
          )}
          {montoPagarLabel && (
            <div className="flex items-center justify-between gap-3 pt-1 border-t border-outline-variant/25">
              <span className="text-caption text-on-surface-variant font-bold uppercase tracking-wide">
                Monto a pagar
              </span>
              <span className="text-label-md font-bold text-primary text-right tabular-nums truncate">
                {montoPagarLabel}
              </span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )

  // Validación: no avanzar desde el paso de fotos sin el mínimo de fotos analizadas
  const hayFotosAnalizando = Object.values(state.photos).some((p) => p.analyzing)
  const fotoCompletion = getSequenceCompletionStats(
    getDynamicSequences(state.vehiculo, state.photos),
    state.photos,
  )
  const hayFotosAnalizadas = fotoCompletion.canAdvance

  const step1EmissionLoading =
    !state.vehiculo?.is0km
    && !!state.vehiculo?.placa?.trim()
    && !!state.vehiculo?.serial?.trim()
    && state.emissionValidation?.status === 'loading'

  const finalizeInspection = () => {
    const result = determinarPlan(state.photos)

    if (!resultado && !isEditing) {
      const newInspection = {
        id:              inspectionNumber,
        numero:          inspectionNumber,
        estado:          'Completada',
        tipo:            'Auto-Gestionable',
        fechaCreacion:   new Date().toISOString(),
        progreso:        100,
        vehicleId:       'veh-001',
        asignadoA:       user?.id,
        ubicacion:       state.ubicacion,
        danios:          state.danios.length,
        planRecomendado: result.plan?.id ?? null,
      }
      addInspection(newInspection)
      addActivity({
        type:     'inspection-start',
        title:    `Inspección ${inspectionNumber}`,
        subtitle: `Auto-Gestión · ${user?.name} · Plan: ${result.plan?.nombre ?? 'No elegible'}`,
        when:     'Hace un momento',
        icon:     result.elegible ? 'verified' : 'gpp_bad',
        tone:     result.elegible ? 'primary' : 'error',
      })
      toast.success('Inspección completada — revisa tu resultado IA', { title: '¡Listo!', duration: 4500 })
    }

    setResultado(result)
    setPhase('result')
    return result
  }

  const next = () => {
    if (step === 0) {
      const step1 = validateStep1(state)
      if (!step1.valid) {
        setStep1ValidateTrigger((t) => t + 1)
        toast.error('Debes completar todos los datos requeridos antes de continuar.', {
          title: 'Documentos incompletos',
        })
        return
      }
    }

    if (step === 2 && !fotoCompletion.canAdvance) {
      toast.error(
        `Debes completar todas las fotos obligatorias correctamente legibles. Llevas ${fotoCompletion.requiredAnalyzed} de ${fotoCompletion.requiredTotal} (las opcionales no cuentan).`,
        { title: 'Fotos incompletas' },
      )
      return
    }
    if (step === 2 && hayFotosAnalizando) {
      toast.info('Espera a que termine el análisis IA antes de continuar.', { title: 'IA analizando…' })
      return
    }

    if (step === 3) {
      finalizeInspection()
    }

    setStep((s) => Math.min(PAYMENT_STEP, s + 1))
  }
  const back = () => {
    setStep((s) => Math.max(0, s - 1))
  }

  // ── Vista de inspección existente ──────────────────────────────────────────
  if (isEditing && existingInspection) {
    const v = getVehicle(existingInspection.vehicleId)
    return (
      <>
        {leaveConfirmModal}
        <PageHeader
          breadcrumbs={[
            { label: 'Inicio', to: '/dashboard' },
            { label: 'Inspecciones', to: '/inspecciones' },
            { label: existingInspection.numero },
          ]}
          eyebrow={existingInspection.numero}
          title={`${v?.marca} ${v?.modelo} ${v?.anio}`}
          subtitle={`Auto-Gestionable · Creada ${new Date(existingInspection.fechaCreacion).toLocaleString('es-VE')}`}
          actions={
            <>
              <StatusChip status={existingInspection.estado} />
              <button onClick={() => navigate('/inspecciones')} className="btn-soft">
                <Icon name="arrow_back" /> Volver
              </button>
            </>
          }
        />
        <div className="flex flex-col gap-4">
          <div className="card p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4"
            style={{ borderTop: '3px solid #0F1A5A' }}>
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: '#EEF0FA', color: '#0F1A5A' }}>
              <Icon name="manage_search" className="text-[32px]" filled />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-caption text-on-surface-variant uppercase tracking-wide mb-1">Estado</p>
              <h3 className="text-headline-lg font-bold" style={{ color: '#0F1A5A' }}>
                {existingInspection.estado}
              </h3>
              <p className="text-body-md text-on-surface-variant mt-0.5">
                La IA analizó tus fotos. Puedes iniciar la emisión de póliza desde el menú principal.
              </p>
            </div>
            <StatusChip status={existingInspection.estado} />
          </div>
          {v && (
            <div className="card p-4 sm:p-5">
              <h4 className="text-headline-md mb-3 flex items-center gap-2">
                <Icon name="directions_car" className="text-primary" filled /> Vehículo
              </h4>
              <div className="flex gap-3 items-center">
                <img src={v.image} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0" />
                <div className="min-w-0">
                  <p className="font-bold text-on-surface">{v.marca} {v.modelo} {v.anio}</p>
                  <p className="text-caption text-on-surface-variant font-mono tracking-wider">{v.placa}</p>
                  <p className="text-caption text-on-surface-variant">{v.color}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </>
    )
  }

  // ── Éxito de pago (fuera del stepper; cierra el flujo) ─────────────────────
  if (resultado && phase === 'success') {
    return (
      <>
        {leaveConfirmModal}
        <PaymentSuccess
          payment={paymentData}
          plan={planParaPago}
          inspectionNumber={inspectionNumber}
          navigate={navigate}
        />
      </>
    )
  }

  // ── Wizard de nueva inspección ─────────────────────────────────────────────
  return (
    <div className="wizard-page flex flex-col">
      {leaveConfirmModal}
      {planConfirmModal}
      <div className="rounded-xl px-4 py-3 mb-4 flex items-center gap-3 bg-brand-50 border border-brand-200">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-primary text-on-primary">
          <Icon name="auto_awesome" className="text-[20px]" filled />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xl font-bold truncate text-primary">Inspección de Vehículo</p>
          <p className="text-caption text-sm truncate text-on-surface-variant">
            Carga y verifica los datos solicitados en cada paso ·  Análisis de datos basado en IA.
          </p>
        </div>
      </div>

      <div className="mb-4">
        <Stepper steps={STEPS} current={step} onStepClick={(i) => {
          if (i === EMISSION_STEP) return
          if (i === RESULT_STEP && !resultado) return
          if (i === PAYMENT_STEP) {
            if (!resultado?.elegible) return
            if (!planParaPago) return
          }
          // No saltar al pago desde pasos anteriores al resultado
          if (i === PAYMENT_STEP && step < RESULT_STEP) return
          setStep(i)
        }} />
      </div>

      <div className="route-enter pb-2 md:pb-4" key={step}>
        {step === 0 && <Step1Documents state={state} validateTrigger={step1ValidateTrigger} />}
        {step === 1 && <Step2Location state={state} />}
        {step === 2 && <Step3Photos state={state} autoGestion />}
        {step === 3 && <Step5Review state={state} inspectionNumber={inspectionNumber} />}
        {step === RESULT_STEP && resultado && (
          <ResultadoPlan
            embedded
            resultado={resultado}
            inspectionNumber={inspectionNumber}
            navigate={navigate}
            photos={state.photos}
            iaDiagnostico={state.iaDiagnostico}
            setIaDiagnostico={state.setIaDiagnostico}
            iaDiagnosticoKey={state.iaDiagnosticoKey}
            setIaDiagnosticoKey={state.setIaDiagnosticoKey}
            vehiculo={state.vehiculo}
            danios={state.danios}
            valrepPlanes={state.valrepPlanes}
            setValrepPlanes={state.setValrepPlanes}
            valrepPlanesKey={state.valrepPlanesKey}
            setValrepPlanesKey={state.setValrepPlanesKey}
            valrepPlanesStatus={state.valrepPlanesStatus}
            setValrepPlanesStatus={state.setValrepPlanesStatus}
            valrepPlanesError={state.valrepPlanesError}
            setValrepPlanesError={state.setValrepPlanesError}
            onPlanChange={setSelectedPlan}
            sumaValidationTick={sumaValidationTick}
          />
        )}
        {step === PAYMENT_STEP && resultado && (
          <PaymentStep
            embedded
            plan={planParaPago}
            tomador={state.tomador}
            titular={state.titular}
            tomadorEsTitular={state.tomadorEsTitular}
            vehiculo={state.vehiculo}
            onBack={() => setStep(RESULT_STEP)}
            iframeUrl={iframeUrl}
            iframeLoading={iframeLoading}
            iframeError={iframeError}
            onRetryIframe={startCheckoutSso}
            onIframeCallback={handleIframeCallback}
          />
        )}
      </div>

      {/* Footer — flotante en todos los pasos */}
      <WizardStickyFooter anchorKey={step}>
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="btn-soft flex-1 sm:flex-none"
          >
            <Icon name="close" /> <span className="hidden xs:inline">Cancelar</span>
          </button>
          <p className="text-caption text-on-surface-variant absolute left-1/2 -translate-x-1/2 hidden md:block">
            Paso {step + 1} de {STEPS.length} · {STEPS[step].label}
          </p>
          <div className="flex items-center gap-2 flex-1 sm:flex-none justify-end">
            {step > 0 && (
              <button type="button" onClick={back} className="btn-soft flex-1 sm:flex-none">
                <Icon name="arrow_back" /> <span className="hidden xs:inline">Anterior</span>
              </button>
            )}
            {step === RESULT_STEP ? (
              resultado?.elegible ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!assertPlanReadyForPayment()) return
                    setConfirmPlanOpen(true)
                  }}
                  className="btn-primary flex-1 sm:flex-none"
                >
                  <span className="hidden xs:inline">Siguiente</span>
                  <Icon name="arrow_forward" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate('/inspecciones')}
                  className="btn-accent flex-1 sm:flex-none"
                >
                  <Icon name="list" />
                  Ver inspecciones
                </button>
              )
            ) : step === PAYMENT_STEP ? null : (
              <button
                type="button"
                onClick={next}
                disabled={
                  step1EmissionLoading ||
                  (step === 2 && !hayFotosAnalizadas) ||
                  (step === 2 && hayFotosAnalizando)
                }
                className={clsx(
                  'btn-primary flex-1 sm:flex-none',
                  (step1EmissionLoading ||
                    (step === 2 && !hayFotosAnalizadas) ||
                    (step === 2 && hayFotosAnalizando)) &&
                    'opacity-40 cursor-not-allowed',
                )}
              >
                <span className="hidden xs:inline">Siguiente</span>
                <Icon name="arrow_forward" />
              </button>
            )}
          </div>
      </WizardStickyFooter>
    </div>
  )
}
