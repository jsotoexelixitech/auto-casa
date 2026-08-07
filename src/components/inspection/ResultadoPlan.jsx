import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import Icon from '../ui/Icon'
import { PLAN_TONES, BRAND, getAnalisisGradientTone } from '../../theme/tokens'
import { getActiveSequences } from '../../utils/sequencesConfig'
import {
  generateIaDiagnosticoAsync,
  getIaDiagnosticoSourceKey,
} from '../../utils/generateIaDiagnostico'
import { fetchPlanesV2, fetchCotizacion, fetchFrecuencias } from '../../services/valrepApi'
import { mapValrepPlanesToUi, selectTopPlanesFromIa } from '../../utils/mapValrepPlanes'
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
  const [cascoSel, setCascoSel] = useState(null)
  const [sumaAsegurada, setSumaAsegurada] = useState(0)

  useEffect(() => {
    userPickedRef.current = false
    setCotizacionByPlan({})
    setFrecuenciasByPlan({})
    setFrecuenciaSel(null)
    setCascoSel(null)
  }, [sourceKey])

  useEffect(() => {
    if (!planSugerido) return
    if (!userPickedRef.current) setPlanSel(planSugerido)
  }, [planSugerido])

  // Al cambiar de plan, volver a Anual (la prima API es anual) y reiniciar casco
  useEffect(() => {
    setFrecuenciaSel(null)
    setCascoSel(null)
  }, [planSel?.id])

  // Inicializar suma asegurada según plan sugerido/seleccionado
  useEffect(() => {
    if (!planSel) return
    const cot = cotizacionByPlan[planSel.id]
    if (cot?.prima?.referenceSuma) {
      setSumaAsegurada(cot.prima.referenceSuma)
      return
    }
    const match = String(planSel.nombre || '').match(/(\d+[\.\d]*)\s*k?\$/i)
    let defSuma = 5000
    if (match) {
      let val = parseFloat(match[1].replace(/\./g, ''))
      if (val < 100) val = val * 1000
      defSuma = val
    } else {
      if (planSel.id === 'AutoIV') defSuma = 7000
      else if (planSel.id === 'AutoV') defSuma = 10000
      else if (planSel.id === 'Auto') defSuma = 5000
      else if (planSel.id === 'AutoII') defSuma = 2000
    }
    setSumaAsegurada(defSuma)
  }, [planSel?.id, cotizacionByPlan[planSel?.id]?.prima?.referenceSuma])

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
              const prima = primaFromMprimaext(data?.mprimaext, {
                mprima: data?.mprima,
                ptasa: data?.ptasa,
                mprimaext: data?.mprimaext,
                rates: data?.rates,
                referenceSuma: data?.referenceSuma,
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

  useEffect(() => {
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
    const base = {
      ...planSel,
      id: cplanApi || planSel.id,
      cplan: cplanApi,
      source: planSel.source || 'valrep',
      frecuencias,
      frecuencia,
      frecuenciaCodigo: frecuencia?.cvalor ?? frecuenciaSel,
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
        casco: cascoSel ? {
          cobertura: cascoSel,
          nombre: cascoSel === 'CA' ? 'COBERTURA AMPLIA' : (cascoSel === 'PT' ? 'PERDIDA TOTAL' : 'PERDIDA PARCIAL'),
          tasa: dynamicRates[cascoSel],
          sumaAsegurada,
          primaAnual: primaCascoAnual,
        } : null,
        inmaMatched: cot.matched,
        inmaCodes: cot.codes || null,
        cotizacion: cot.raw,
      })
      return
    }
    onPlanChange?.(base)
  }, [planSel, cotizacionByPlan, frecuenciasByPlan, frecuenciaSel, cascoSel, sumaAsegurada, onPlanChange])

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

            const cascoOptions = [
              { key: 'CA', nombre: 'COBERTURA AMPLIA', tasa: dynamicRates.CA },
              { key: 'PT', nombre: 'PERDIDA TOTAL', tasa: dynamicRates.PT },
              { key: 'PP', nombre: 'PERDIDA PARCIAL', tasa: dynamicRates.PP },
            ]

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
                      Incluir Cobertura de Casco:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {cascoOptions.map((item) => {
                        const sel = cascoSel === item.key
                        return (
                          <button
                            key={item.key}
                            type="button"
                            onClick={() => setCascoSel(sel ? null : item.key)}
                            className={clsx(
                              'rounded-full px-3 py-1.5 border transition-all text-[10px] sm:text-[11px] font-bold flex items-center gap-1.5',
                              sel
                                ? 'border-[#ffdedf] bg-[#ffdedf] text-[#b23f44] shadow-sm font-black'
                                : 'border-white/20 bg-white/10 text-white/80 hover:bg-white/15 hover:border-white/35',
                            )}
                          >
                            {sel && <Icon name="check" className="text-[13px]" filled />}
                            {item.nombre}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {cascoSel && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold uppercase tracking-wider text-white/60">
                          Suma Asegurada ($)
                        </label>
                        <input
                          type="number"
                          value={sumaAsegurada || ''}
                          onChange={(e) => {
                            const val = Math.max(0, parseInt(e.target.value) || 0)
                            setSumaAsegurada(val)
                          }}
                          className="w-full bg-white/15 border border-white/20 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/50 transition-colors"
                          placeholder="Suma"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold uppercase tracking-wider text-white/60">
                          Tasa (%)
                        </label>
                        <div className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/70 select-none font-semibold">
                          {String(Number(dynamicRates[cascoSel]).toFixed(2)).replace('.', ',')} %
                        </div>
                      </div>
                    </div>
                  )}
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
