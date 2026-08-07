/**
 * Arma el payload de POST /external/createEmissionAuto
 * a partir del estado del wizard de inspección Auto Casco.
 */
import { PLANES_V2_REQUEST, COTIZACION_DEFAULTS } from '../services/valrepApi'
import { resolveInmaVehicle } from './resolveInmaVehicle'

function emptyToNull(value) {
  if (value == null) return null
  if (typeof value === 'string' && !value.trim()) return null
  return value
}

function toNumberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Extrae tipo (letra) y rif numérico desde "V-12345678" o "J-12345678-9". */
export function splitDocumentoVe(documento) {
  const raw = String(documento || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!raw) return { tipo: 'V', rif: 0 }

  let letter = 'V'
  let digits = raw
  if (/^[A-Z]/.test(raw)) {
    letter = raw[0]
    digits = raw.slice(1)
  }
  digits = digits.replace(/\D/g, '')
  // RIF: 8 dígitos + verificador → usar los 8 de cuerpo
  if (digits.length >= 9) digits = digits.slice(0, 8)
  return {
    tipo: letter,
    rif: toNumberOr(digits, 0),
  }
}

/** Normaliza fecha a YYYY-MM-DD o null. */
export function toIsoDate(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const dmy = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/)
  if (dmy) {
    const dd = dmy[1].padStart(2, '0')
    const mm = dmy[2].padStart(2, '0')
    return `${dmy[3]}-${mm}-${dd}`
  }

  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10)
  }
  return null
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function vigenciaHasta(desdeIso) {
  const d = new Date(`${desdeIso}T12:00:00`)
  d.setFullYear(d.getFullYear() + 1)
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

function resolvePersonaTomador({ tomador, titular, tomadorEsTitular }) {
  if (tomadorEsTitular && titular) return titular
  return tomador || titular || null
}

function mapPersonaNames(persona, { juridica = false } = {}) {
  if (!persona) {
    return { nombre: null, apellido: null }
  }
  if (juridica || persona.razonSocial?.trim()) {
    return {
      nombre: emptyToNull(persona.razonSocial) || emptyToNull(persona.nombres),
      apellido: emptyToNull(persona.apellidos),
    }
  }
  return {
    nombre: emptyToNull(persona.nombres),
    apellido: emptyToNull(persona.apellidos),
  }
}

/**
 * @param {object} args
 * @param {object} args.plan - selectedPlan con id, frecuencia, prima, cotizacion, inmaCodes, inmaMatched
 * @param {object} args.titular
 * @param {object} args.tomador
 * @param {boolean} args.tomadorEsTitular
 * @param {object} args.docs - docs.naturaleza / tipoTitular
 * @param {object} args.vehiculo
 * @param {object} args.ubicacion
 */
export async function buildEmissionAutoPayload({
  plan,
  titular,
  tomador,
  tomadorEsTitular = false,
  docs = {},
  vehiculo = {},
  ubicacion = {},
}) {
  const personaTomador = resolvePersonaTomador({ tomador, titular, tomadorEsTitular })
  const titularJuridica =
    docs.naturaleza === 'juridica'
    || docs.tipoTitular === 'juridica'
    || !!docs.rif

  const docTomador = splitDocumentoVe(personaTomador?.documento)
  const docTitular = splitDocumentoVe(titular?.documento)
  const namesTomador = mapPersonaNames(personaTomador, { juridica: false })
  const namesTitular = mapPersonaNames(titular, { juridica: titularJuridica })

  const direccion = emptyToNull(ubicacion?.direccion)
  const emision = todayIso()
  const hasta = vigenciaHasta(emision)

  let inma = plan?.inmaCodes || null
  if (!inma?.cmarca || !inma?.cmodelo || !inma?.cversion) {
    try {
      const resolved = await resolveInmaVehicle(vehiculo)
      inma = {
        cmarca: resolved.cmarca,
        cmodelo: resolved.cmodelo,
        cversion: resolved.cversion,
        ccategoria_uso: resolved.ccategoria_uso,
        fano: resolved.fano,
        matched: resolved.matched,
      }
    } catch {
      inma = null
    }
  }

  const matched = plan?.inmaMatched || inma?.matched || null
  const frecuencia =
    plan?.frecuenciaCodigo
    || plan?.frecuencia?.cvalor
    || 'A'

  // `plan` de createEmissionAuto = cplan exacto de planes/v2 (sin transformar).
  const cplan = String(plan?.raw?.cplan ?? plan?.cplan ?? '').trim()

  return {
    poliza: null,
    cramo: COTIZACION_DEFAULTS.cramo ?? 18,
    plan: cplan,
    tipo_cedula_tomador: docTomador.tipo,
    rif_tomador: docTomador.rif,
    nombre_tomador: namesTomador.nombre,
    apellido_tomador: namesTomador.apellido,
    telefono_tomador: emptyToNull(personaTomador?.telefono),
    correo_tomador: emptyToNull(personaTomador?.email),
    sexo_tomador: null,
    estado_civil_tomador: null,
    iestado_civil_tomador: null,
    fnac_tomador: toIsoDate(personaTomador?.fechaNacimiento),
    estado_tomador: 0,
    ciudad_tomador: 0,
    direccion_tomador: direccion,
    tipo_cedula_titular: docTitular.tipo,
    rif_titular: docTitular.rif,
    nombre_titular: namesTitular.nombre,
    apellido_titular: namesTitular.apellido,
    telefono_titular: emptyToNull(titular?.telefono),
    correo_titular: emptyToNull(titular?.email),
    sexo_titular: null,
    estado_civil_titular: null,
    iestado_civil_titular: null,
    fnac_titular: toIsoDate(titular?.fechaNacimiento),
    estado_titular: 0,
    ciudad_titular: 0,
    direccion_titular: direccion,
    conductor: {},
    beneficiario: {},
    marca: inma?.cmarca != null ? String(inma.cmarca) : null,
    modelo: inma?.cmodelo != null ? String(inma.cmodelo) : null,
    version: inma?.cversion != null ? String(inma.cversion) : null,
    xmarca: emptyToNull(matched?.marca),
    xmodelo: emptyToNull(matched?.modelo),
    xversion: emptyToNull(matched?.version),
    fano: toNumberOr(inma?.fano ?? vehiculo?.anio, 0),
    color: emptyToNull(vehiculo?.color),
    placa: emptyToNull(vehiculo?.placa),
    serial_carroceria: emptyToNull(vehiculo?.serial),
    serial_motor: null,
    ccategoria_uso: toNumberOr(inma?.ccategoria_uso, 0),
    npuestos: toNumberOr(vehiculo?.puestos, 0),
    ntoneladas: COTIZACION_DEFAULTS.ntoneladas ?? 0,
    iplaca: COTIZACION_DEFAULTS.iplaca ?? 'N',
    Precargorcv: 0,
    dec_persona_politica: 0,
    dec_term_y_cod: 1,
    productor: PLANES_V2_REQUEST.cproductor,
    frecuencia: String(frecuencia),
    fecha_emision: emision,
    femision: emision,
    fdesde: emision,
    fhasta: hasta,
    cusuario: PLANES_V2_REQUEST.cusuario,
    msumaaseg: toNumberOr(plan?.casco?.sumaAsegurada ?? 0, 0),
    mprima: toNumberOr(plan?.prima?.mprima ?? 0, 0),
    mprimaext: toNumberOr(plan?.prima?.mprimaext ?? plan?.prima?.anual ?? 0, 0),
    ptasa: toNumberOr(plan?.prima?.ptasa ?? 0, 0),
  }
}
