/**
 * Helpers de montos de checkout a partir de cotización Valrep + frecuencia.
 */
import { cuotaFromPrimaAnual, periodsPerYear } from './primaFrecuencia'
import { splitDocumentoVe } from './buildEmissionAutoPayload'
import { fetchCotizacion } from '../services/valrepApi'
import { resolveInmaVehicle } from './resolveInmaVehicle'

/**
 * TEMP (pruebas de pago): el iframe SSO cotiza este cplan internamente.
 * UI / emisión siguen con el plan elegido por el usuario.
 */
export const DEMO_CHECKOUT_PLAN_ID = 'RCVPR2'

function round2(n) {
  return Math.round(Number(n) * 100) / 100
}

export function checkoutAmountsFromPlan(plan) {
  const cot = plan?.cotizacion || {}
  const anualUsd = Number(cot.mprimaext ?? plan?.prima?.mprimaext ?? plan?.prima?.anual ?? 0)
  const anualVes = Number(cot.mprima ?? plan?.prima?.mprima ?? 0)
  const exchangeRate = Number(cot.ptasa ?? plan?.prima?.ptasa ?? 0)
  const freq = plan?.frecuencia || plan?.frecuenciaCodigo || 'A'
  const periods = Math.max(1, periodsPerYear(freq))
  const totalUsd = round2(cuotaFromPrimaAnual(anualUsd, freq))
  // Misma proporción que USD
  const totalVes = periods === 1 ? round2(anualVes) : round2(anualVes / periods)

  return {
    totalUsd,
    totalVes,
    exchangeRate: Number.isFinite(exchangeRate) ? exchangeRate : 0,
    periods,
    label: plan?.frecuencia?.xdescripcion || plan?.frecuenciaCodigo || 'Anual',
  }
}

/**
 * Montos para el iframe: cotiza `DEMO_CHECKOUT_PLAN_ID` y aplica la frecuencia
 * del plan seleccionado en UI. Emisión / resumen visual no usan esto.
 */
export async function checkoutAmountsForIframe(selectedPlan, vehiculo) {
  const codes = await resolveInmaVehicle(vehiculo)
  const cot = await fetchCotizacion({
    cmarca: codes.cmarca,
    cmodelo: codes.cmodelo,
    cversion: codes.cversion,
    fano: codes.fano,
    cplan: DEMO_CHECKOUT_PLAN_ID,
    ccategoria_uso: codes.ccategoria_uso,
  })

  const cascoAnual = selectedPlan?.casco?.primaAnual || 0
  const mprimaext = (Number(cot?.mprimaext) || 0) + cascoAnual
  const mprima = (Number(cot?.mprima) || 0) + (cascoAnual * (Number(cot?.ptasa) || 1))

  return {
    ...checkoutAmountsFromPlan({
      ...selectedPlan,
      cotizacion: cot,
      prima: {
        ...(selectedPlan?.prima || {}),
        mprima,
        mprimaext,
        ptasa: cot?.ptasa,
        anual: mprimaext,
      },
    }),
    demoPlanId: DEMO_CHECKOUT_PLAN_ID,
    cotizacionDemo: cot,
  }
}

export function resolvePayerFromDraft({ tomador, titular, tomadorEsTitular }) {
  const persona = tomadorEsTitular && titular ? titular : (tomador || titular || {})
  const { tipo, rif } = splitDocumentoVe(persona.documento)
  const name = [persona.nombres, persona.apellidos].filter(Boolean).join(' ').trim()
    || persona.razonSocial
    || 'TOMADOR'
  return {
    documentType: tipo,
    documentNumber: String(rif || ''),
    name: String(name).toUpperCase(),
    phone: persona.telefono || undefined,
  }
}

export function buildIdOperacion(inspectionNumber) {
  const base = String(inspectionNumber || 'INS').replace(/[^A-Za-z0-9-]/g, '')
  return `OP-${base}-${Date.now().toString().slice(-6)}`
}

/**
 * URL de callback del browser tras el pago.
 * En local, si Pagos es HTTPS, conviene `VITE_PAYMENT_REDIRECT_ORIGIN` con un
 * túnel HTTPS al front (p.ej. ngrok → :5173); si no, el redirect del iframe
 * a http://localhost suele fallar o quedar atrapado dentro del iframe.
 */
export function buildPaymentRedirectUrl(idOperacion) {
  const origin = String(
    import.meta.env.VITE_PAYMENT_REDIRECT_ORIGIN || window.location.origin || '',
  ).replace(/\/$/, '')
  const id = encodeURIComponent(String(idOperacion || ''))
  return `${origin}/pago/resultado?idOperacion=${id}`
}

/** ¿La URL es nuestro callback de pago? (misma app, ruta /pago/resultado) */
export function isPaymentCallbackUrl(href) {
  if (!href || typeof href !== 'string') return false
  try {
    const u = new URL(href, window.location.origin)
    return u.pathname.replace(/\/$/, '') === '/pago/resultado'
  } catch {
    return /\/pago\/resultado(\?|$)/i.test(href)
  }
}
