/**
 * Cliente Valrep / INMA (API externa La Mundial / nest-api).
 * Base: VITE_VALREP_API_URL  (ej. http://192.168.8.120:3002/api/v1 o /valrep-api)
 * Auth (NEST_AUTH_USE_TOKEN=true):
 *   1) POST /auth/token  body { apikey, grant_type: 'api_key' }
 *   2) Authorization: Bearer <access_token>
 *   3) POST /auth/refresh con refresh_token al vencer
 */
import { parseEmissionAutoResponse } from '../utils/emissionResult'

const VALREP_BASE = (import.meta.env.VITE_VALREP_API_URL ?? '').replace(/\/$/, '')
const VALREP_API_KEY = String(import.meta.env.VITE_VALREP_API_KEY ?? '').trim()
/** Margen antes de expires_in para renovar (ms). */
const TOKEN_SKEW_MS = 30_000

/** @type {{ accessToken: string, refreshToken: string, expiresAt: number } | null} */
let tokenSession = null
/** @type {Promise<string> | null} */
let tokenInFlight = null

/** Parámetros fijos iniciales del listado de planes (ajustables cuando se parametrice). */
export const PLANES_V2_REQUEST = {
  cramo: 18,
  cproductor: 80080,
  ctipo: 1,
  cusuario: '7',
  iplaca: 'N',
  citem: '80080',
  centidad: 'P',
}

export const COTIZACION_DEFAULTS = {
  iplaca: 'N',
  ntoneladas: 0,
  cramo: 18,
}

export class ValrepApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
    this.name = 'ValrepApiError'
  }
}

function rememberTokens(payload) {
  const accessToken = String(payload?.access_token ?? '').trim()
  if (!accessToken) {
    throw new ValrepApiError(401, 'Valrep no devolvió access_token')
  }
  const expiresInSec = Number(payload?.expires_in)
  const ttlMs = Number.isFinite(expiresInSec) && expiresInSec > 0
    ? expiresInSec * 1000
    : 900_000
  tokenSession = {
    accessToken,
    refreshToken: String(payload?.refresh_token ?? '').trim(),
    expiresAt: Date.now() + ttlMs,
  }
  return accessToken
}

async function exchangeApiKeyForTokens() {
  if (!VALREP_API_KEY) {
    throw new ValrepApiError(0, 'VITE_VALREP_API_KEY no está configurada')
  }
  let res
  try {
    res = await fetch(`${VALREP_BASE}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'api_key', apikey: VALREP_API_KEY }),
    })
  } catch {
    throw new ValrepApiError(0, 'No se pudo conectar con Valrep (auth/token)')
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`
    throw new ValrepApiError(res.status, typeof msg === 'string' ? msg : 'Error auth Valrep')
  }
  return rememberTokens(json?.data ?? json)
}

async function refreshAccessToken() {
  const refreshToken = tokenSession?.refreshToken
  if (!refreshToken) {
    return exchangeApiKeyForTokens()
  }
  let res
  try {
    res = await fetch(`${VALREP_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
  } catch {
    return exchangeApiKeyForTokens()
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    tokenSession = null
    return exchangeApiKeyForTokens()
  }
  return rememberTokens(json?.data ?? json)
}

async function ensureAccessToken({ force = false } = {}) {
  if (!VALREP_BASE) {
    throw new ValrepApiError(0, 'VITE_VALREP_API_URL no está configurada')
  }
  if (!force && tokenSession?.accessToken && Date.now() < tokenSession.expiresAt - TOKEN_SKEW_MS) {
    return tokenSession.accessToken
  }
  if (tokenInFlight) return tokenInFlight

  tokenInFlight = (async () => {
    try {
      if (force || !tokenSession?.accessToken) {
        return await exchangeApiKeyForTokens()
      }
      if (Date.now() >= tokenSession.expiresAt - TOKEN_SKEW_MS) {
        return await refreshAccessToken()
      }
      return tokenSession.accessToken
    } finally {
      tokenInFlight = null
    }
  })()

  return tokenInFlight
}

async function valrepHeaders({ forceToken = false } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (VALREP_API_KEY) {
    const accessToken = await ensureAccessToken({ force: forceToken })
    headers.Authorization = `Bearer ${accessToken}`
  }
  return headers
}

function isAuthFailure(status, json) {
  if (status !== 401) return false
  const msg = String(json?.message || json?.error || '').toLowerCase()
  return (
    msg.includes('access_token')
    || msg.includes('token')
    || msg.includes('autentic')
    || msg.includes('unauthorized')
    || !msg
  )
}

async function valrepFetch(url, { method, body, connectError }) {
  let headers = await valrepHeaders()
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ValrepApiError(0, connectError)
  }

  let json = await res.json().catch(() => ({}))

  if (VALREP_API_KEY && isAuthFailure(res.status, json)) {
    headers = await valrepHeaders({ forceToken: true })
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch {
      throw new ValrepApiError(0, connectError)
    }
    json = await res.json().catch(() => ({}))
  }

  return { res, json }
}

async function valrepRequest(method, path, body) {
  if (!VALREP_BASE) {
    throw new ValrepApiError(0, 'VITE_VALREP_API_URL no está configurada')
  }

  const url = `${VALREP_BASE}${path.startsWith('/') ? path : `/${path}`}`
  const { res, json } = await valrepFetch(url, {
    method,
    body,
    connectError: 'No se pudo conectar con Valrep',
  })

  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`
    throw new ValrepApiError(res.status, typeof msg === 'string' ? msg : 'Error Valrep')
  }

  if (json?.status === false) {
    throw new ValrepApiError(res.status, json?.message || 'Valrep respondió status=false')
  }

  return json?.data !== undefined ? json.data : json
}

function listFromData(data, ...keys) {
  for (const k of keys) {
    if (Array.isArray(data?.[k])) return data[k]
  }
  if (Array.isArray(data?.info)) return data.info
  return []
}

/** Catálogo de planes disponibles (Valrep planes/v2). */
export async function fetchPlanesV2(params = PLANES_V2_REQUEST) {
  const data = await valrepRequest('POST', '/valrep/planes/v2', params)
  const list = data?.plan
  return Array.isArray(list) ? list : []
}

export async function fetchInmaMarcas(fano) {
  const data = await valrepRequest('POST', '/inma/marcas', { fano: Number(fano) })
  return listFromData(data, 'marcas')
}

export async function fetchInmaModelos(fano, cmarca) {
  const data = await valrepRequest('POST', '/inma/modelo', {
    fano: Number(fano),
    cmarca: String(cmarca),
  })
  return listFromData(data, 'modelos', 'modelo')
}

export async function fetchInmaVersiones(fano, cmarca, cmodelo) {
  const data = await valrepRequest('POST', '/inma/version', {
    fano: Number(fano),
    cmarca: String(cmarca),
    cmodelo: String(cmodelo),
  })
  return listFromData(data, 'versiones', 'version')
}

export async function fetchInmaCategoriasUso(fano, cmarca, cmodelo, cversion) {
  const data = await valrepRequest('POST', '/inma/categorias-uso', {
    fano: Number(fano),
    cmarca: String(cmarca),
    cmodelo: String(cmodelo),
    cversion: String(cversion),
  })
  return listFromData(data, 'categorias_uso', 'categorias')
}

/**
 * Cotización Valrep. Usa `mprimaext` como prima en $.
 * @param {object} params
 */
export async function fetchCotizacion(params) {
  const body = {
    ...COTIZACION_DEFAULTS,
    ...params,
    fano: Number(params.fano),
    ccategoria_uso: Number(params.ccategoria_uso),
    ntoneladas: Number(params.ntoneladas ?? 0),
    cramo: Number(params.cramo ?? COTIZACION_DEFAULTS.cramo),
    cmarca: String(params.cmarca),
    cmodelo: String(params.cmodelo),
    cversion: String(params.cversion),
    cplan: String(params.cplan),
  }
  return valrepRequest('POST', '/valrep/cotizacion', body)
}

/**
 * Frecuencias de pago disponibles para un plan.
 * @param {string} cplan
 * @returns {Promise<Array<{ cvalor: string, xdescripcion: string }>>}
 */
export async function fetchFrecuencias(cplan) {
  const data = await valrepRequest('POST', '/valrep/frecuencia', { cplan: String(cplan) })
  return listFromData(data, 'frecuencias')
}

/**
 * Valida placa + serial contra emisión (La Mundial external).
 * @returns {Promise<{ valid: boolean, message: string, reason: string }>}
 */
export async function validateEmissionAuto(placa, serial_carroceria) {
  if (!VALREP_BASE) {
    throw new ValrepApiError(0, 'VITE_VALREP_API_URL no está configurada')
  }

  const url = `${VALREP_BASE}/external/validateEmissionAuto`
  const { res, json } = await valrepFetch(url, {
    method: 'POST',
    body: {
      placa: String(placa ?? '').trim(),
      serial_carroceria: String(serial_carroceria ?? '').trim(),
    },
    connectError: 'No se pudo conectar con el servicio de validación',
  })

  if (!res.ok) {
    const msg = pickEmissionMessage(json?.result, json, json?.data) || `HTTP ${res.status}`
    throw new ValrepApiError(res.status, msg)
  }

  const result = json?.result ?? json?.data?.result ?? json?.data ?? json
  const valid = result?.status === true
  const apiMessage = pickEmissionMessage(result, json?.data, json)

  if (valid) {
    return {
      valid: true,
      message: 'Vehículo válido para emisión.',
      reason: '',
    }
  }

  return {
    valid: false,
    message: 'Vehículo no válido para emisión.',
    reason: apiMessage || 'Vehículo no válido para emisión.',
  }
}

/**
 * Emite póliza Auto Casco (La Mundial external).
 * @param {object} payload
 * @returns {Promise<import('../utils/emissionResult').parseEmissionAutoResponse extends Function ? object : object>}
 */
export async function createEmissionAuto(payload) {
  if (!VALREP_BASE) {
    throw new ValrepApiError(0, 'VITE_VALREP_API_URL no está configurada')
  }

  const url = `${VALREP_BASE}/external/createEmissionAuto`
  const { res, json } = await valrepFetch(url, {
    method: 'POST',
    body: payload,
    connectError: 'No se pudo conectar con el servicio de emisión',
  })

  if (!res.ok) {
    const msg = pickEmissionMessage(json?.result, json, json?.data) || `HTTP ${res.status}`
    throw new ValrepApiError(res.status, msg)
  }

  const parsed = parseEmissionAutoResponse(json)
  if (!parsed.ok) {
    throw new ValrepApiError(400, parsed.message || 'No se pudo emitir la póliza')
  }
  return parsed
}

function pickEmissionMessage(...sources) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue
    for (const key of ['message', 'mensaje', 'motivo', 'descripcion', 'description', 'error']) {
      const value = src[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) {
        return value[0].trim()
      }
    }
  }
  return ''
}
