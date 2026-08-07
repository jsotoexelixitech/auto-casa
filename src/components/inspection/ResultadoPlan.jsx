import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import Icon from '../ui/Icon'
import { PLAN_TONES, BRAND, getAnalisisGradientTone } from '../../theme/tokens'
import { getActiveSequences } from '../../utils/sequencesConfig'
import {
  generateIaDiagnosticoAsync,
  getIaDiagnosticoSourceKey,
} from '../../utils/generateIaDiagnostico'
import { fetchPlanesV2, fetchCotizacion, fetchFrecuencias } from '../../services/valrepApi'
import { mapValrepPlanesToUi, selectTopPlanesFromIa, parseSumaAsegurada } from '../../utils/mapValrepPlanes'
import { resolveInmaVehicle, primaFromMprimaext } from '../../utils/resolveInmaVehicle'
import {
  pickDefaultFrecuencia,
  cuotaFromPrimaAnual,
  isFrecuenciaAnual,
} from '../../utils/primaFrecuencia'

/** Estilo general del card de planes / detalle (navy). */
const SELECT_TONE = {
  bg: '#EEF0FA',
  fg: BRAND.navy,
  border: BRAND.navy,
}

/** Solo el ítem seleccionado de la lista usa `secondary`. */
const SELECTED_ITEM_TONE = {
  bg: '#ffdedf', // secondary-fixed
  fg: '#b23f44', // secondary
  border: '#b23f44',
}

const CASCO_KEYS = ['CA', 'PT', 'PP']

const CASCO_NOMBRES = {
  CA: 'COBERTURA AMPLIA',
  PT: 'PERDIDA TOTAL',
  PP: 'PERDIDA PARCIAL',
}

/** Cobertura de casco sugerida según el plan IA (misma lógica de recomendación). */
function pickDefaultCasco(iaPlan) {
  const id = iaPlan?.id || ''
  if (id === 'perdida_total') return 'PT'
  if (id === 'rcv') return 'PP'
  return 'CA'
}

/** Formato moneda USD con decimales (es-VE: 7.000,50). */
function formatSumaDisplay(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  const hasDecimals = Math.abs(n % 1) > 1e-9
  return n.toLocaleString('es-VE', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  })
}

function countDigits(str = '') {
  return String(str).replace(/\D/g, '').length
}

/** Posición de caret tras N dígitos en `str` (0 = inicio). */
function caretPosAfterDigits(str, digitCount) {
  if (digitCount <= 0) return 0
  let seen = 0
  for (let i = 0; i < str.length; i += 1) {
    if (/\d/.test(str[i])) {
      seen += 1
      if (seen >= digitCount) return i + 1
    }
  }
  return str.length
}

function valueHasDecimals(value) {
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n % 1) > 1e-9
}

/**
 * ¿El texto pide modo decimal?
 * - `,` → sí
 * - `.` final (teclado numérico) → sí
 * - Si ya estábamos en decimal y queda `entero.d` con grupos de miles válidos → sí
 * - `8.52` al borrar miles (sin haber escrito decimal) → NO (son enteros)
 */
function resolveSumaDecimalMode(raw, prevMode, { maxDecimals = 2 } = {}) {
  const s = String(raw ?? '').replace(/[^\d.,]/g, '')
  if (!s) return false
  if (s.includes(',')) return true
  if (s.endsWith('.')) return true

  if (!prevMode || !s.includes('.')) return false

  // Mantener decimal solo si el último punto parece decimal con miles bien formados:
  // "7.000.5" sí · "8.52" no (grupo incompleto de miles al borrar)
  const parts = s.split('.')
  const last = parts[parts.length - 1]
  if (last.length === 0 || last.length > maxDecimals) return false
  const middle = parts.slice(1, -1)
  if (middle.some((p) => p.length !== 3)) return false
  // Con un solo punto ("852.5") y prevMode: el usuario escribió el decimal
  if (parts.length === 2) return true
  // Varios puntos: el penúltimo grupo debe ser miles completo (3)
  return parts[parts.length - 2]?.length === 3
}

/**
 * Parsea input es-VE. En modo entero los `.` son solo miles (nunca decimal).
 * @returns {{ value: number|null, display: string, decimalMode: boolean }}
 */
function parseSumaInput(raw, { maxDecimals = 2, decimalMode: prevMode = false } = {}) {
  const cleaned = String(raw ?? '').trim().replace(/[^\d.,]/g, '')
  if (!cleaned) return { value: null, display: '', decimalMode: false }

  const decimalMode = resolveSumaDecimalMode(cleaned, prevMode, { maxDecimals })

  let intDigits = ''
  let decDigits = ''
  let trailingComma = false

  if (decimalMode) {
    let s = cleaned
    if (!s.includes(',') && s.endsWith('.')) {
      s = `${s.slice(0, -1)},`
    } else if (!s.includes(',') && s.includes('.')) {
      const parts = s.split('.')
      const last = parts[parts.length - 1]
      const intPart = parts.slice(0, -1).join('.')
      s = `${intPart},${last}`
    }

    const idx = s.indexOf(',')
    if (idx >= 0) {
      intDigits = s.slice(0, idx).replace(/\D/g, '')
      decDigits = s.slice(idx + 1).replace(/\D/g, '').slice(0, maxDecimals)
      trailingComma = s.endsWith(',') && decDigits === ''
    } else {
      intDigits = s.replace(/\D/g, '')
    }
  } else {
    // Solo enteros: ignorar puntos/comas residuales de la máscara
    intDigits = cleaned.replace(/\D/g, '')
  }

  if (!intDigits && !decDigits && !trailingComma) {
    return { value: null, display: '', decimalMode: false }
  }

  const intNum = Number(intDigits || '0')
  if (!Number.isFinite(intNum)) return { value: null, display: '', decimalMode: false }

  const normalized = decDigits
    ? `${intDigits || '0'}.${decDigits}`
    : (intDigits || '0')
  const value = Number(normalized)
  if (!Number.isFinite(value)) return { value: null, display: '', decimalMode: false }

  const intDisp = intNum.toLocaleString('es-VE')
  let display = intDisp
  if (trailingComma) display += ','
  else if (decDigits) display += `,${decDigits}`

  return {
    value,
    display,
    decimalMode: Boolean(trailingComma || decDigits),
  }
}

/** Normaliza montos del endpoint (7000 | "7.000" | "7000,00" | "7.000,00"). */
function parseEndpointSuma(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw * 100) / 100
  }
  const s = String(raw).trim().replace(/[$\s]/g, '')
  if (!s) return null
  // 7.000,00 / 7000,00 → quitar miles y usar coma decimal
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    const normalized = s.replace(/\./g, '').replace(',', '.')
    const n = Number(normalized)
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
  }
  if (/^\d+(,\d+)?$/.test(s)) {
    const n = Number(s.replace(',', '.'))
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
  }
  const digits = s.replace(/\D/g, '')
  const n = Number(digits)
  return Number.isFinite(n) && n > 0 ? n : null
}

function pickSumaFromCotizacion(cot) {
  if (!cot) return null
  const raw = cot.raw && typeof cot.raw === 'object' ? cot.raw : {}
  const prima = cot.prima && typeof cot.prima === 'object' ? cot.prima : {}
  const rates = (prima.rates || raw.rates || {})
  const candidates = [
    prima.referenceSuma,
    raw.referenceSuma,
    raw.msumaaseg,
    raw.mSumaAseg,
    raw.sumaAsegurada,
    raw.suma_asegurada,
    raw.suma,
    rates.referenceSuma,
    rates.msumaaseg,
    rates.sumaAsegurada,
  ]
  for (const c of candidates) {
    const n = parseEndpointSuma(c)
    if (n != null) return n
  }
  return null
}

function pickSumaFromPlan(plan) {
  const fromNivel = Number(plan?.nivelPlan)
  if (Number.isFinite(fromNivel) && fromNivel > 0) return Math.round(fromNivel)
  return (
    parseSumaAsegurada(plan?.nombre)
    || parseSumaAsegurada(plan?.subtitulo)
    || null
  )
}

function isValidSumaAsegurada(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0
}

export default function ResultadoPlan({
  resultado,
  inspectionNumber,
  navigate,
  photos,
  onPlanChange,
  embedded = false,
  iaDiagnostico = '',
  setIaDiagnostico,
  iaDiagnosticoKey = '',
  setIaDiagnosticoKey,
  vehiculo,
  danios = [],
  valrepPlanes = [],
  setValrepPlanes,
  valrepPlanesKey = '',
  setValrepPlanesKey,
  valrepPlanesStatus = 'idle',
  setValrepPlanesStatus,
  valrepPlanesError = '',
  setValrepPlanesError,
  /** Incrementar desde el wizard cuando falle la validación al pulsar Siguiente. */
  sumaValidationTick = 0,
}) {
  const {
    plan: iaPlan,
    planesDisponibles: planesLocales,
    elegible,
    piezas,
    motivo,
  } = resultado

  const sourceKey = useMemo(
    () => getIaDiagnosticoSourceKey({ danios, photos, vehiculo }),
    [danios, photos, vehiculo],
  )
  const diagnosisIsCurrent = Boolean(iaDiagnostico && iaDiagnosticoKey === sourceKey)
  const planesAreCurrent = Boolean(
    valrepPlanesKey === sourceKey
    && (valrepPlanesStatus === 'ready' || valrepPlanesStatus === 'error'),
  )

  useEffect(() => {
    if (!setIaDiagnostico) return undefined
    if (diagnosisIsCurrent) return undefined

    let cancelled = false

    generateIaDiagnosticoAsync({
      danios,
      photos,
      vehiculo,
    })
      .then((diag) => {
        if (cancelled) return
        setIaDiagnostico(diag)
        setIaDiagnosticoKey?.(sourceKey)
      })

    return () => { cancelled = true }
  }, [
    danios,
    photos,
    vehiculo,
    sourceKey,
    diagnosisIsCurrent,
    setIaDiagnostico,
    setIaDiagnosticoKey,
  ])

  // Catálogo Valrep: misma huella que el diagnóstico (cambia si cambian fotos del paso 3)
  useEffect(() => {
    if (!setValrepPlanes || !setValrepPlanesStatus) return undefined
    if (planesAreCurrent) return undefined

    let cancelled = false
    setValrepPlanesStatus('loading')
    setValrepPlanesError?.('')

    fetchPlanesV2()
      .then((raw) => {
        if (cancelled) return
        const mapped = mapValrepPlanesToUi(raw)
        setValrepPlanes(mapped)
        setValrepPlanesKey?.(sourceKey)
        setValrepPlanesStatus('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setValrepPlanes([])
        setValrepPlanesKey?.(sourceKey)
        setValrepPlanesStatus('error')
        setValrepPlanesError?.(err?.message || 'Error al cargar planes')
      })

    return () => { cancelled = true }
  }, [
    sourceKey,
    planesAreCurrent,
    setValrepPlanes,
    setValrepPlanesKey,
    setValrepPlanesStatus,
    setValrepPlanesError,
  ])

  const usingValrep = valrepPlanesStatus === 'ready' && valrepPlanes.length > 0
  const rankedValrep = useMemo(
    () => (usingValrep
      ? selectTopPlanesFromIa(valrepPlanes, iaPlan, { limit: 4, piezas })
      : null),
    [usingValrep, valrepPlanes, iaPlan, piezas],
  )
  const planesDisponibles = rankedValrep?.planes?.length
    ? rankedValrep.planes
    : (planesLocales || []).slice(0, 4)
  const planSugerido = rankedValrep?.sugerido ?? iaPlan

  const userPickedRef = useRef(false)
  const [planSel, setPlanSel] = useState(planSugerido ?? iaPlan)
  /** @type {Record<string, { status: string, prima?: object, error?: string, matched?: object }>} */
  const [cotizacionByPlan, setCotizacionByPlan] = useState({})
  /** @type {Record<string, { status: string, list?: Array<{cvalor:string,xdescripcion:string}>, error?: string }>} */
  const [frecuenciasByPlan, setFrecuenciasByPlan] = useState({})
  const [frecuenciaSel, setFrecuenciaSel] = useState(null)
  const cascoSugerido = useMemo(() => pickDefaultCasco(iaPlan), [iaPlan?.id])
  const [cascoSel, setCascoSel] = useState(() => pickDefaultCasco(iaPlan))
  const [sumaAsegurada, setSumaAsegurada] = useState(0)
  const [sumaDisplay, setSumaDisplay] = useState('')
  const [sumaTouched, setSumaTouched] = useState(false)
  /** Valor de referencia (endpoint cotización → fallback plan). */
  const [sumaDefault, setSumaDefault] = useState(null)
  const [sumaEdited, setSumaEdited] = useState(false)
  /** true solo si el usuario/API introdujo decimales de forma explícita (no al borrar miles). */
  const [sumaDecimalMode, setSumaDecimalMode] = useState(false)
  const sumaUserEditedRef = useRef(false)
  const lastSumaPlanIdRef = useRef(null)
  const sumaInputRef = useRef(null)
  /** @type {React.MutableRefObject<{ inDecimals: boolean, digitCount: number, atComma?: boolean } | null>} */
  const sumaCaretRef = useRef(null)

  useLayoutEffect(() => {
    const el = sumaInputRef.current
    const caret = sumaCaretRef.current
    if (!el || !caret || document.activeElement !== el) return
    const text = el.value || ''
    const commaIdx = text.indexOf(',')
    let pos
    if (caret.inDecimals) {
      if (commaIdx < 0) {
        pos = text.length
      } else {
        pos = commaIdx + 1 + caretPosAfterDigits(text.slice(commaIdx + 1), caret.digitCount)
      }
    } else {
      const intPart = commaIdx >= 0 ? text.slice(0, commaIdx) : text
      pos = caretPosAfterDigits(intPart, caret.digitCount)
      // Si el usuario estaba justo en la coma, mantenerlo ahí
      if (caret.atComma && commaIdx >= 0) pos = commaIdx
    }
    const safe = Math.max(0, Math.min(pos, text.length))
    el.setSelectionRange(safe, safe)
    sumaCaretRef.current = null
  }, [sumaDisplay])

  useEffect(() => {
    userPickedRef.current = false
    setCotizacionByPlan({})
    setFrecuenciasByPlan({})
    setFrecuenciaSel(null)
    setCascoSel(pickDefaultCasco(iaPlan))
    sumaUserEditedRef.current = false
    lastSumaPlanIdRef.current = null
    setSumaEdited(false)
    setSumaDefault(null)
    setSumaDecimalMode(false)
  }, [sourceKey, iaPlan?.id])

  useEffect(() => {
    if (!planSugerido) return
    if (!userPickedRef.current) setPlanSel(planSugerido)
  }, [planSugerido])

  // Al cambiar de plan, volver a Anual (la prima API es anual) y cobertura sugerida
  useEffect(() => {
    setFrecuenciaSel(null)
    setCascoSel(pickDefaultCasco(iaPlan))
    sumaUserEditedRef.current = false
    setSumaEdited(false)
    setSumaDecimalMode(false)
  }, [planSel?.id, iaPlan?.id])

  // Cobertura obligatoria: si se pierde la selección, restaurar la sugerida
  useEffect(() => {
    if (CASCO_KEYS.includes(cascoSel)) return
    setCascoSel(cascoSugerido)
  }, [cascoSel, cascoSugerido])

  // Default editable: endpoint (cotización) → nivel/nombre del plan
  useEffect(() => {
    if (!planSel?.id) return
    const cot = cotizacionByPlan[planSel.id]
    const fromApi = cot?.status === 'ready' ? pickSumaFromCotizacion(cot) : null
    const fromPlan = pickSumaFromPlan(planSel)
    const next = fromApi ?? fromPlan
    const planChanged = lastSumaPlanIdRef.current !== planSel.id

    if (planChanged) {
      lastSumaPlanIdRef.current = planSel.id
      sumaUserEditedRef.current = false
      setSumaEdited(false)
    }

    // No pisar edición manual del usuario
    if (sumaUserEditedRef.current && !planChanged) {
      // Sí actualizar la referencia del endpoint si llega después
      if (fromApi != null) setSumaDefault(fromApi)
      return
    }
    // Esperar cotización lista si aún no hay fallback de plan
    if (next == null && cot?.status === 'loading') return
    if (next == null) {
      setSumaAsegurada(0)
      setSumaDisplay('')
      setSumaTouched(false)
      setSumaDefault(null)
      setSumaDecimalMode(false)
      return
    }
    // Si ya mostramos el del plan y llega el del API, actualizar solo si el usuario no editó
    setSumaDefault(fromApi ?? fromPlan)
    setSumaAsegurada(next)
    setSumaDisplay(formatSumaDisplay(next))
    setSumaTouched(false)
    setSumaEdited(false)
    setSumaDecimalMode(valueHasDecimals(next))
  }, [
    planSel?.id,
    planSel?.nombre,
    planSel?.nivelPlan,
    cotizacionByPlan[planSel?.id]?.status,
    cotizacionByPlan[planSel?.id]?.prima?.referenceSuma,
    cotizacionByPlan[planSel?.id]?.raw,
  ])

  useEffect(() => {
    if (!sumaValidationTick) return
    setSumaTouched(true)
  }, [sumaValidationTick])

  const sumaInvalid = !isValidSumaAsegurada(sumaAsegurada)
  const sumaDefaultNum = Number(sumaDefault)
  const canResetSuma = Boolean(
    sumaEdited
    && Number.isFinite(sumaDefaultNum)
    && sumaDefaultNum > 0
    && Math.abs(Number(sumaAsegurada) - sumaDefaultNum) > 1e-9,
  )

  const resetSumaToDefault = () => {
    if (!Number.isFinite(sumaDefaultNum) || sumaDefaultNum <= 0) return
    sumaUserEditedRef.current = false
    setSumaEdited(false)
    setSumaAsegurada(sumaDefaultNum)
    setSumaDisplay(formatSumaDisplay(sumaDefaultNum))
    setSumaDecimalMode(valueHasDecimals(sumaDefaultNum))
    setSumaTouched(false)
    sumaCaretRef.current = null
  }

  // Si Anual está disponible y no hay selección, marcarla (también con frecuencias en caché)
  useEffect(() => {
    if (frecuenciaSel) return
    const list = (frecuenciasByPlan[planSel?.id]?.list || [])
    if (!list?.length) return
    setFrecuenciaSel(pickDefaultFrecuencia(list)?.cvalor ?? list[0].cvalor)
  }, [planSel?.id, frecuenciasByPlan, frecuenciaSel])

  // Cotización + frecuencias Valrep al seleccionar un plan
  useEffect(() => {
    if (!planSel?.id || planSel.source !== 'valrep') return undefined
    if (!vehiculo?.marca?.trim() || !vehiculo?.anio) return undefined

    const planId = planSel.id
    const cotReady = cotizacionByPlan[planId]?.status === 'ready'
    const freqReady = frecuenciasByPlan[planId]?.status === 'ready'
    if (cotReady && freqReady) return undefined

    let cancelled = false

    if (!cotReady) {
      setCotizacionByPlan((prev) => ({
        ...prev,
        [planId]: { ...prev[planId], status: 'loading', error: undefined },
      }))
    }
    if (!freqReady) {
      setFrecuenciasByPlan((prev) => ({
        ...prev,
        [planId]: { ...prev[planId], status: 'loading', error: undefined },
      }))
    }

    ;(async () => {
      const freqPromise = freqReady
        ? Promise.resolve(
            (frecuenciasByPlan[planId]?.list || []),
          )
        : fetchFrecuencias(planId)
            .then((list) => {
              if (cancelled) return []
              const allFrequencies = Array.isArray(list) ? list : []
              setFrecuenciasByPlan((prev) => ({
                ...prev,
                [planId]: { status: 'ready', list: allFrequencies },
              }))
              return allFrequencies
            })
            .catch((err) => {
              if (cancelled) return []
              setFrecuenciasByPlan((prev) => ({
                ...prev,
                [planId]: {
                  status: 'error',
                  list: [],
                  error: err?.message || 'No se pudieron cargar las frecuencias',
                },
              }))
              return []
            })

      const cotPromise = cotReady
        ? Promise.resolve(null)
        : (async () => {
            try {
              const codes = await resolveInmaVehicle(vehiculo)
              const data = await fetchCotizacion({
                cmarca: codes.cmarca,
                cmodelo: codes.cmodelo,
                cversion: codes.cversion,
                fano: codes.fano,
                cplan: planId,
                ccategoria_uso: codes.ccategoria_uso,
              })
              if (cancelled) return null
              const referenceSuma = pickSumaFromCotizacion({
                raw: data,
                prima: { rates: data?.rates, referenceSuma: data?.referenceSuma },
              })
              const prima = primaFromMprimaext(data?.mprimaext, {
                mprima: data?.mprima,
                ptasa: data?.ptasa,
                mprimaext: data?.mprimaext,
                rates: data?.rates,
                referenceSuma,
              })
              setCotizacionByPlan((prev) => ({
                ...prev,
                [planId]: {
                  status: 'ready',
                  prima,
                  matched: codes.matched,
                  codes: {
                    cmarca: codes.cmarca,
                    cmodelo: codes.cmodelo,
                    cversion: codes.cversion,
                    ccategoria_uso: codes.ccategoria_uso,
                    fano: codes.fano,
                    matched: codes.matched,
                  },
                  raw: data,
                },
              }))
              return null
            } catch (err) {
              if (cancelled) return null
              setCotizacionByPlan((prev) => ({
                ...prev,
                [planId]: {
                  status: 'error',
                  error: err?.message || 'No se pudo cotizar el plan',
                },
              }))
              return null
            }
          })()

      const [freqs] = await Promise.all([freqPromise, cotPromise])
      if (cancelled) return

      // Prima API = anual → marcar Anual por defecto
      if (freqs?.length) {
        setFrecuenciaSel((prev) => {
          if (prev && freqs.some((f) => f.cvalor === prev)) return prev
          return pickDefaultFrecuencia(freqs)?.cvalor ?? freqs[0].cvalor
        })
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    planSel?.id,
    planSel?.source,
    vehiculo?.marca,
    vehiculo?.modelo,
    vehiculo?.version,
    vehiculo?.anio,
    vehiculo?.tipo,
  ])

  useLayoutEffect(() => {
    if (!planSel) return
    const cot = cotizacionByPlan[planSel.id]
    const freq = frecuenciasByPlan[planSel.id]
    const frecuencias = (freq?.list || [])
    const frecuencia = frecuencias.find((f) => f.cvalor === frecuenciaSel) || null
    const primaAnual = Number(cot?.prima?.anual ?? cot?.prima?.monto ?? planSel.prima?.anual ?? planSel.prima?.monto)
    
    // Calcular prima de casco con tasas dinámicas
    const dynamicRates = cot?.prima?.rates || { CA: 9.32, PT: 6.52, PP: 3.50 }
    const pctTasa = cascoSel ? (dynamicRates[cascoSel] / 100) : 0
    const primaCascoAnual = Number(sumaAsegurada) * pctTasa
    const totalPrimaAnual = (Number.isFinite(primaAnual) ? primaAnual : 0) + primaCascoAnual

    const cuota = frecuencia
      ? cuotaFromPrimaAnual(totalPrimaAnual, frecuencia)
      : (Number.isFinite(totalPrimaAnual) ? totalPrimaAnual : undefined)

    const cplanApi = String(planSel.raw?.cplan ?? planSel.cplan ?? '').trim()
    const sumaOk = isValidSumaAsegurada(sumaAsegurada)
    const cascoPayload = CASCO_KEYS.includes(cascoSel)
      ? {
          cobertura: cascoSel,
          nombre: CASCO_NOMBRES[cascoSel] || CASCO_NOMBRES.CA,
          tasa: dynamicRates[cascoSel],
          sumaAsegurada: sumaOk ? Number(sumaAsegurada) : 0,
          primaAnual: sumaOk ? primaCascoAnual : 0,
          sugerida: cascoSel === cascoSugerido,
          sumaValida: sumaOk,
        }
      : null
    const base = {
      ...planSel,
      id: cplanApi || planSel.id,
      cplan: cplanApi,
      source: planSel.source || 'valrep',
      frecuencias,
      frecuencia,
      frecuenciaCodigo: frecuencia?.cvalor ?? frecuenciaSel,
      casco: cascoPayload,
    }

    if (cot?.status === 'ready' && cot.prima) {
      onPlanChange?.({
        ...base,
        prima: {
          ...cot.prima,
          monto: cuota ?? totalPrimaAnual,
          cuota,
          anual: totalPrimaAnual,
          mprimaext: totalPrimaAnual,
          mprima: totalPrimaAnual * (cot.prima?.ptasa ?? 1),
        },
        inmaMatched: cot.matched,
        inmaCodes: cot.codes || null,
        cotizacion: cot.raw,
      })
      return
    }
    onPlanChange?.(base)
  }, [planSel, cotizacionByPlan, frecuenciasByPlan, frecuenciaSel, cascoSel, cascoSugerido, sumaAsegurada, onPlanChange])

  // Efecto máquina de escribir solo tras una generación nueva (no al reusar caché)
  const awaitGenerationRef = useRef(!diagnosisIsCurrent)
  const [typedText, setTypedText] = useState(diagnosisIsCurrent ? iaDiagnostico : '')
  const [isTyping, setIsTyping] = useState(false)

  useEffect(() => {
    if (!diagnosisIsCurrent) {
      awaitGenerationRef.current = true
      setTypedText('')
      setIsTyping(false)
      return undefined
    }

    const shouldType = awaitGenerationRef.current
    awaitGenerationRef.current = false

    if (!shouldType) {
      setTypedText(iaDiagnostico)
      setIsTyping(false)
      return undefined
    }

    setIsTyping(true)
    setTypedText('')
    let index = 0
    const charsPerTick = 2
    const tickMs = 16

    const id = window.setInterval(() => {
      index = Math.min(iaDiagnostico.length, index + charsPerTick)
      setTypedText(iaDiagnostico.slice(0, index))
      if (index >= iaDiagnostico.length) {
        window.clearInterval(id)
        setIsTyping(false)
      }
    }, tickMs)

    return () => window.clearInterval(id)
  }, [diagnosisIsCurrent, iaDiagnostico])

  const activeSequences = getActiveSequences()

  const zonasAnalizadas = activeSequences
    .filter((s) => photos?.[s.id]?.analyzed)
    .map((s) => {
      const ph = photos[s.id]
      const todasLasPiezas = [...s.piezas, ...(s.piezasOpcionales || [])]
      const piezasResult = todasLasPiezas.map((nombre) => ({
        nombre,
        ...(ph.piezas?.[nombre] ?? { estado: 'B', comentario: '' }),
      }))
      const counts = { B: 0, R: 0, M: 0, NE: 0 }
      piezasResult.forEach((p) => { if (counts[p.estado] !== undefined) counts[p.estado]++ })
      return { seq: s, ph, piezasResult, counts }
    })

  // % y barras: solo piezas que el vehículo sí tiene (excluye NE / no aplica)
  const piezasPresentes = (piezas.buenas || 0) + (piezas.regulares || 0) + (piezas.malas || 0)
  const denomPct = piezasPresentes || 1
  const pctBuenas = Math.round((piezas.buenas / denomPct) * 100)
  const pctRegulares = Math.round((piezas.regulares / denomPct) * 100)
  const pctMalas = Math.round((piezas.malas / denomPct) * 100)
  const analisisTone = getAnalisisGradientTone(pctBuenas, { elegible })
  const analisisIcon = analisisTone.icon

  const planesLoading = valrepPlanesStatus === 'loading' || (!planesAreCurrent && Boolean(setValrepPlanes))
  const showPlanes = elegible && !planesLoading && planSel
  const showPlanesFallbackNote = valrepPlanesStatus === 'error' && planesLocales?.length > 0

  return (
    <div className={clsx('flex flex-col gap-5', embedded ? 'pb-2' : 'pb-8')}>
      {/* ── Resumen + Diagnóstico IA (mitad / mitad) ───────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <div className="card p-4 sm:p-5 flex flex-col" style={{ borderTop: '3px solid #0F1A5A' }}>
        <h3 className="text-headline-md text-on-surface mb-1 flex items-center gap-2">
          <Icon name="auto_awesome" className="text-primary text-[22px]" filled />
          Resumen del análisis
        </h3>
          <p className="text-caption text-on-surface-variant mb-3">
            {zonasAnalizadas.length} zona(s) analizadas · {piezasPresentes} pieza(s) evaluadas
            {piezas.noExiste > 0 ? ` · ${piezas.noExiste} omitidas (no aplican)` : ''}
          </p>

          <div className="grid grid-cols-4 gap-1.5 mb-3">
          <PiezaStat label="Buenas"    value={piezas.buenas}    tone="success" icon="check_circle" />
          <PiezaStat label="Regulares" value={piezas.regulares} tone="warning" icon="warning" />
          <PiezaStat label="Malas"     value={piezas.malas}     tone="error"   icon="cancel" />
            <PiezaStat label="Total"     value={piezasPresentes} tone="neutral" icon="analytics" />
        </div>

          {piezasPresentes > 0 && (
          <div className="flex h-3 rounded-full overflow-hidden mb-2 gap-0.5">
            {piezas.buenas > 0 && (
              <div className="bg-green-500 transition-all rounded-l-full"
                  style={{ width: `${(piezas.buenas / denomPct) * 100}%` }} />
            )}
            {piezas.regulares > 0 && (
              <div className="bg-amber-400 transition-all"
                  style={{ width: `${(piezas.regulares / denomPct) * 100}%` }} />
            )}
            {piezas.malas > 0 && (
              <div className="bg-red-500 transition-all rounded-r-full"
                  style={{ width: `${(piezas.malas / denomPct) * 100}%` }} />
            )}
          </div>
        )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-on-surface-variant mb-2">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" /> {pctBuenas}% buenas</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> {pctRegulares}% regulares</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> {pctMalas}% malas</span>
          </div>

          <div
            className="mt-auto p-3 rounded-xl border"
            style={{
              backgroundColor: analisisTone.bg,
              borderColor:     analisisTone.border,
              color:           analisisTone.fg,
            }}
          >
            <div className="flex items-start gap-2">
              <Icon name={analisisIcon} className="text-[18px] mt-0.5 shrink-0" filled />
              <p className="font-semibold leading-snug text-caption">{motivo}</p>
            </div>
          </div>
        </div>

        <div
          className="card p-4 sm:p-5 flex flex-col border"
          style={{
            backgroundColor: analisisTone.bg,
            borderColor: analisisTone.border,
            borderTop: `3px solid ${analisisTone.fg}`,
          }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Icon name="auto_awesome" style={{ color: analisisTone.fg }} filled />
            <h3 className="text-headline-md" style={{ color: analisisTone.fg }}>Diagnóstico IA</h3>
          </div>
          {diagnosisIsCurrent ? (
            <p
              className="text-body-md leading-relaxed rounded-xl p-4 flex-1 whitespace-pre-wrap border bg-white/70"
              style={{ borderColor: analisisTone.border, color: analisisTone.fg }}
            >
              {typedText}
              {isTyping && (
                <span
                  className="inline-block w-[2px] h-[1.1em] ml-0.5 align-[-0.15em] animate-pulse"
                  style={{ backgroundColor: analisisTone.fg }}
                  aria-hidden
                />
              )}
            </p>
          ) : (
            <div
              className="flex flex-col items-center justify-center gap-4 p-6 sm:p-8 rounded-xl border flex-1 min-h-[10rem] bg-white/55"
              style={{ borderColor: analisisTone.border }}
            >
              <Icon
                name="progress_activity"
                className="animate-spin text-[40px] sm:text-[44px] shrink-0"
                style={{ color: analisisTone.fg }}
              />
              <p
                className="text-body-md text-center leading-snug max-w-sm italic"
                style={{ color: analisisTone.fg }}
              >
                Ejecutando análisis IA en base a la información cargada...
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Carga de planes Valrep ─────────────────────────────────────── */}
      {elegible && planesLoading && (
        <div className="card p-6 flex flex-col items-center justify-center gap-3 min-h-[12rem]">
          <Icon name="progress_activity" className="animate-spin text-[40px] text-primary" />
          <p className="text-body-md text-on-surface-variant text-center">
            Consultando planes disponibles…
          </p>
                      </div>
                    )}

      {showPlanesFallbackNote && (
        <div className="rounded-xl px-4 py-3 bg-amber-50 border border-amber-200 text-caption text-amber-900">
          No se pudieron cargar los planes Valrep{valrepPlanesError ? `: ${valrepPlanesError}` : ''}.
          Se muestran opciones locales provisionalmente.
        </div>
      )}

      {/* ── Plan: selector (izq) + detalle (der) ───────────────────────── */}
      {showPlanes ? (
        <div
          className={clsx(
            'grid gap-3 items-stretch',
            planesDisponibles.length > 1 ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1',
          )}
        >
          {planesDisponibles.length > 1 && (
            <div className="card p-3 sm:p-4 flex flex-col" style={{ borderTop: `3px solid ${SELECT_TONE.fg}` }}>
              <p className="text-label-md text-on-surface-variant mb-2.5 uppercase tracking-wide text-[11px] font-bold">
                Planes disponibles para tu vehículo
              </p>
              <div className="flex flex-col gap-1.5 flex-1 max-h-[28rem] overflow-y-auto pr-0.5">
                {planesDisponibles.map((p) => {
                  const sel = planSel.id === p.id
                  const sugerido = planSugerido?.id === p.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        userPickedRef.current = true
                        setPlanSel(p)
                      }}
                      className={clsx(
                        'flex items-center gap-2.5 p-2.5 rounded-xl border-2 text-left transition-all',
                        sel ? 'ring-2 ring-offset-1 ring-secondary/30' : 'hover:border-outline-variant',
                      )}
                      style={
                        sel
                          ? { backgroundColor: SELECTED_ITEM_TONE.bg, borderColor: SELECTED_ITEM_TONE.border }
                          : { borderColor: '#E0E0E0', backgroundColor: '#FFFFFF' }
                      }
                    >
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                        style={{
                          backgroundColor: sel ? '#FFFFFF' : SELECT_TONE.bg,
                          color: sel ? SELECTED_ITEM_TONE.fg : SELECT_TONE.fg,
                        }}
                      >
                        <Icon name={p.icono} className="text-[20px]" filled />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="font-bold text-on-surface text-sm leading-tight">{p.nombre}</p>
                          {sugerido && (
                            <span
                              className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-px rounded-full text-white"
                              style={{ backgroundColor: SELECT_TONE.fg }}
                            >
                              Sugerido
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-on-surface-variant truncate leading-snug">
                          {p.subtitulo}
                        </p>
                      </div>
                      {sel && (
                        <Icon
                          name="check_circle"
                          className="text-[18px] shrink-0 text-secondary"
                          filled
                        />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {(() => {
            const cot = cotizacionByPlan[planSel.id]
            const prima = cot?.prima || planSel.prima || {}
            const cotizando = cot?.status === 'loading'
            const cotError = cot?.status === 'error'
            const freqs = (frecuenciasByPlan[planSel.id]?.list || [])
            const frecuencia =
              freqs.find((f) => f.cvalor === frecuenciaSel) || pickDefaultFrecuencia(freqs)
            
            const basePrimaAnual = Number(prima.anual ?? prima.monto)
            const dynamicRates = prima.rates || { CA: 9.32, PT: 6.52, PP: 3.50 }
            const pctTasa = cascoSel ? (dynamicRates[cascoSel] / 100) : 0
            const primaCascoAnual = Number(sumaAsegurada) * pctTasa
            const totalPrimaAnual = (Number.isFinite(basePrimaAnual) ? basePrimaAnual : 0) + primaCascoAnual

            const monto = frecuencia
              ? cuotaFromPrimaAnual(totalPrimaAnual, frecuencia)
              : totalPrimaAnual
            const montoLabel = cotizando
              ? '…'
              : Number.isFinite(monto)
                ? `$${Number(monto).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : '—'
            const primaCaption = frecuencia
              ? (isFrecuenciaAnual(frecuencia)
                ? 'Prima anual'
                : `Cuota ${String(frecuencia.xdescripcion || '').toLowerCase()}`)
              : 'Prima'

            const cascoOptions = CASCO_KEYS.map((key) => ({
              key,
              nombre: CASCO_NOMBRES[key],
              tasa: dynamicRates[key],
              sugerida: key === cascoSugerido,
            }))

            return (
              <div
                className="rounded-2xl p-4 sm:p-5 relative overflow-hidden text-white flex flex-col h-full gap-3"
                style={{ backgroundColor: '#0F1A5A', borderLeft: '4px solid #ACACAC' }}
              >
                <div className="absolute -top-12 -right-12 w-48 h-48 rounded-full blur-3xl pointer-events-none" style={{ background: 'rgba(255,255,255,0.04)' }} />
                <div className="absolute -bottom-8 -left-8 w-36 h-36 rounded-full blur-2xl pointer-events-none" style={{ background: 'rgba(255,255,255,0.03)' }} />

                <div className="relative flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
                    <Icon name={planSel.icono} className="text-white text-[20px]" filled />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm uppercase tracking-widest opacity-70 mb-0.5">
                      Plan seleccionado
                    </p>
                    <h2 className="text-label-md sm:text-headline-md font-bold leading-tight">
                      {planSel.nombre}
                    </h2>
                    <p className="text-sm text-white/70 mt-0.5 leading-snug">
                      {planSel.subtitulo}
                    </p>
                    {frecuencia && (
                      <p className="text-[10px] text-white/70 uppercase tracking-wider font-semibold">
                        {primaCaption}
                      </p>
                    )}
                  </div>
                </div>

                {/* Sección Cobertura de Casco */}
                <div className="relative pt-3 border-t border-white/20 flex flex-col gap-3">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-white/70 mb-2">
                      Selecciona la cobertura de casco
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {cascoOptions.map((item) => {
                        const sel = cascoSel === item.key
                        return (
                          <button
                            key={item.key}
                            type="button"
                            onClick={() => setCascoSel(item.key)}
                            className={clsx(
                              'rounded-full px-3 py-1.5 border transition-all text-[10px] sm:text-[11px] font-bold flex items-center gap-1.5',
                              sel
                                ? 'border-[#ffdedf] bg-[#ffdedf] text-[#b23f44] shadow-sm font-black'
                                : 'border-white/20 bg-white/10 text-white/80 hover:bg-white/15 hover:border-white/35',
                            )}
                          >
                            {sel && <Icon name="check" className="text-[13px]" filled />}
                            {item.nombre}
                            {item.sugerida && (
                              <span
                                className={clsx(
                                  'text-[8px] font-bold uppercase tracking-wide px-1.5 py-px rounded-full',
                                  sel ? 'bg-[#b23f44] text-white' : 'bg-white/25 text-white',
                                )}
                              >
                                Sugerida
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-white/60">
                        Suma Asegurada ($)
                      </label>
                      <div
                        className={clsx(
                          'flex items-center gap-1 rounded-lg bg-white/15 transition-colors',
                          sumaTouched && sumaInvalid
                            ? 'border border-red-300/80 focus-within:border-red-300'
                            : 'border border-white/20 focus-within:border-white/50',
                        )}
                      >
                        <span className="pl-3 text-sm text-white/60 font-semibold pointer-events-none shrink-0">
                          $
                        </span>
                        <input
                          ref={sumaInputRef}
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          value={sumaDisplay}
                          onChange={(e) => {
                            sumaUserEditedRef.current = true
                            setSumaEdited(true)
                            const input = e.target
                            const raw = input.value
                            const caret = input.selectionStart ?? raw.length
                            const parsed = parseSumaInput(raw, { decimalMode: sumaDecimalMode })

                            // Caret: en display final la decimal es siempre `,`
                            // Si el usuario escribió `.` decimal, mapear a zona decimal
                            const rawComma = raw.indexOf(',')
                            const rawDotDec = (!raw.includes(',') && raw.endsWith('.'))
                              ? raw.lastIndexOf('.')
                              : -1
                            const decSepIdx = rawComma >= 0
                              ? rawComma
                              : (parsed.decimalMode && rawDotDec >= 0
                                ? rawDotDec
                                : (parsed.decimalMode ? raw.lastIndexOf('.') : -1))
                            const inDecimals = parsed.decimalMode && decSepIdx >= 0 && caret > decSepIdx
                            const atComma = parsed.decimalMode && decSepIdx >= 0 && caret === decSepIdx
                            const digitCount = inDecimals
                              ? countDigits(raw.slice(decSepIdx + 1, caret))
                              : countDigits(raw.slice(0, Math.max(0, decSepIdx >= 0 ? decSepIdx : caret)))
                            sumaCaretRef.current = { inDecimals, digitCount, atComma }

                            setSumaDecimalMode(parsed.decimalMode)
                            if (parsed.value == null && !parsed.display) {
                              setSumaAsegurada(0)
                              setSumaDisplay('')
                              return
                            }
                            setSumaAsegurada(parsed.value ?? 0)
                            setSumaDisplay(parsed.display)
                          }}
                          onBlur={() => {
                            setSumaTouched(true)
                            sumaCaretRef.current = null
                            if (isValidSumaAsegurada(sumaAsegurada)) {
                              setSumaDisplay(formatSumaDisplay(sumaAsegurada))
                              setSumaDecimalMode(valueHasDecimals(sumaAsegurada))
                            }
                          }}
                          aria-invalid={sumaTouched && sumaInvalid}
                          className="min-w-0 flex-1 bg-transparent border-0 py-2 pr-1 text-sm text-white tabular-nums focus:outline-none"
                          placeholder="Ej. 7.000,00"
                        />
                        {canResetSuma && (
                          <button
                            type="button"
                            onClick={resetSumaToDefault}
                            className="shrink-0 mr-1 w-8 h-7 rounded-md inline-flex items-center justify-center text-white/85 hover:text-white hover:bg-white/15 transition-colors"
                            aria-label="Restaurar suma original de cotización"
                            title="Restaurar valor original de cotización"
                          >
                            <Icon name="refresh" className="text-[18px]" />
                          </button>
                        )}
                      </div>
                      {sumaTouched && sumaInvalid && (
                        <p className="text-[10px] text-red-300 font-medium leading-snug">
                          La suma asegurada es obligatoria y debe ser mayor a 0
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-white/60">
                        Tasa (%)
                      </label>
                      <div
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/70 select-none font-semibold"
                        aria-readonly="true"
                        title="Tasa definida por la cobertura (no editable)"
                      >
                        {String(Number(dynamicRates[cascoSel] ?? dynamicRates.CA).toFixed(2)).replace('.', ',')} %
                      </div>
                    </div>
                  </div>
                </div>

                <div className="relative bg-white/10 rounded-xl px-4 py-6 text-center backdrop-blur min-w-0">
                  <p className="text-display-lg font-bold leading-none tabular-nums text-white">
                    {montoLabel}
                  </p>
                  {cotizando && (
                    <p className="text-[10px] text-white/70 mt-2 flex items-center justify-center gap-1">
                      <Icon name="progress_activity" className="animate-spin text-[14px]" />
                      Cotizando…
                    </p>
                  )}
                  {!cotizando && cotError && (
                    <p className="text-[10px] text-red-300 mt-2">
                      {cot.error || 'No se pudo cotizar este plan'}
                    </p>
                  )}
                  {!cotizando && !cot && (
                    <p className="text-[10px] text-white/60 mt-2">
                      Selecciona el plan para cotizar
                    </p>
                  )}
                </div>

                {(() => {
                  const freqState = frecuenciasByPlan[planSel.id]
                  const freqsList = (freqState?.list || [])
                  const freqLoading = freqState?.status === 'loading'
                  if (freqLoading) {
                    return (
                      <p className="relative text-[10px] text-white/70 flex items-center gap-1">
                        <Icon name="progress_activity" className="animate-spin text-[14px]" />
                        Cargando frecuencias…
                      </p>
                    )
                  }
                  if (freqState?.status === 'error') {
                    return (
                      <p className="relative text-[10px] text-red-300">
                        {freqState.error || 'No se pudieron cargar las frecuencias'}
                      </p>
                    )
                  }
                  if (!freqsList.length) return null
                  return (
                    <div className="relative mt-auto pt-3 border-t border-white/20">
                      <p className="text-sm font-bold uppercase tracking-wide text-white/70 mb-2">
                        {freqsList.length > 1 ? 'Selecciona la' : '' } frecuencia de pago
                      </p>
                      <div
                        className={clsx(
                          'grid gap-2',
                          freqsList.length === 1 && 'grid-cols-1',
                          freqsList.length === 2 && 'grid-cols-2',
                          freqsList.length === 3 && 'grid-cols-3',
                          freqsList.length >= 4 && 'grid-cols-4',
                        )}
                      >
                        {freqsList.map((f) => {
                          const sel = frecuenciaSel === f.cvalor
                          return (
                            <button
                              key={f.cvalor}
                              type="button"
                              onClick={() => setFrecuenciaSel(f.cvalor)}
                              className={clsx(
                                'rounded-lg px-2 py-2.5 border-2 transition-all text-[11px] sm:text-[12px] font-semibold text-center min-h-[44px]',
                                sel
                                  ? 'border-secondary bg-secondary text-white shadow-sm'
                                  : 'border-white/20 bg-white/10 text-white/80 hover:bg-white/15 hover:border-white/35',
                              )}
                            >
                              {f.xdescripcion}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )
          })()}
        </div>
      ) : !elegible ? (
        <div className="card p-5 sm:p-6 flex flex-col items-center text-center gap-4 border-2 border-error/30">
          <div className="w-20 h-20 rounded-full bg-error-container flex items-center justify-center">
            <Icon name="gpp_bad" className="text-[40px] text-error" filled />
          </div>
          <div>
            <h3 className="text-headline-lg font-bold text-error mb-2">Vehículo No Asegurable</h3>
            <p className="text-body-md text-on-surface-variant max-w-md leading-relaxed">{motivo}</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
            <button onClick={() => navigate('/inspecciones/nueva')} className="btn-primary flex-1">
              <Icon name="refresh" /> Nueva Inspección
            </button>
            <button onClick={() => navigate('/dashboard')} className="btn-soft flex-1">
              <Icon name="home" /> Inicio
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PiezaStat({ label, value, tone, icon }) {
  const s = PLAN_TONES[tone] ?? PLAN_TONES.neutral
  return (
    <div className="rounded-lg px-1.5 py-1.5 text-center min-w-0" style={{ backgroundColor: s.bg }}>
      <Icon name={icon} className="text-[14px] mb-0.5" style={{ color: s.fg }} filled />
      <p className="text-label-md font-bold leading-none tabular-nums" style={{ color: s.fg }}>{value}</p>
      <p className="text-[9px] font-semibold leading-tight mt-0.5 truncate" style={{ color: s.fg }}>{label}</p>
    </div>
  )
}
