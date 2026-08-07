/**

 * Verificación de que una foto pertenece al vehículo registrado en la inspección.

 */



/** Si es true, no rechaza fotos solo por discrepancia de placa foto ↔ paso 1. */
export const DISABLE_PLATE_STEP1_MATCH = false

export const VEHICLE_MATCH_STATUS = {

  SAME: 'same',

  OTHER: 'other',

  UNCERTAIN: 'uncertain',

  WRONG_CONTENT: 'wrong_content',

}



const SKIP_VEHICLE_IDENTITY_ZONES = new Set([

  'serial',

  'interior',

  'dashboard',

  'trunk',

  'damages',

  'roof',

])



const COLOR_SYNONYMS = {

  blanco: ['blanco', 'white', 'perla', 'marfil'],

  negro: ['negro', 'black', 'grafito'],

  gris: ['gris', 'gray', 'grey', 'plata', 'silver', 'plateado'],

  rojo: ['rojo', 'red', 'burdeos', 'vino'],

  azul: ['azul', 'blue', 'marino', 'celeste'],

  verde: ['verde', 'green'],

  amarillo: ['amarillo', 'yellow', 'dorado', 'gold'],

  marron: ['marron', 'marrón', 'brown', 'beige', 'arena', 'cafe'],

}



export function normalizePlaca(value = '') {

  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '')

}



export function normalizeSerial(value = '') {

  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '')

}



function isAbsentLabel(value) {

  const n = normalizeToken(value)

  if (!n) return true

  const absent = [

    'no visible',

    'no legible',

    'no se ve',

    'no aplica',

    'desconocido',

    'n a',

    'na',

    'null',

    'sin dato',

    'no disponible',

  ]

  return absent.some((a) => n === a || n.includes(a))

}



function serialsMatch(registered, detected) {

  const r = normalizeSerial(registered)

  const d = normalizeSerial(detected)

  if (!r || !d) return false

  if (r === d) return true

  if (r.length >= 6 && d.length >= 6) {

    if (r.slice(-6) === d.slice(-6)) return true

    if (r.includes(d) || d.includes(r)) return true

  }

  return r.includes(d) || d.includes(r)

}



function normalizeToken(value) {

  if (!value) return ''

  return String(value)

    .normalize('NFD')

    .replace(/[\u0300-\u036f]/g, '')

    .toLowerCase()

    .replace(/[^a-z0-9\s]/g, ' ')

    .replace(/\s+/g, ' ')

    .trim()

}



function tokensOverlap(a, b) {

  const na = normalizeToken(a)

  const nb = normalizeToken(b)

  if (!na || !nb) return true

  if (na === nb) return true

  if (na.includes(nb) || nb.includes(na)) return true

  const wa = na.split(' ').filter((w) => w.length > 2)

  const wb = nb.split(' ').filter((w) => w.length > 2)

  return wa.some((w) => wb.includes(w))

}



function colorFamily(color) {

  const n = normalizeToken(color)

  if (!n) return null

  for (const [family, synonyms] of Object.entries(COLOR_SYNONYMS)) {

    if (synonyms.some((s) => n.includes(s) || s.includes(n))) return family

  }

  return n

}



function colorsCompatible(registered, detected) {

  if (!registered || !detected) return null

  const fr = colorFamily(registered)

  const fd = colorFamily(detected)

  if (!fr || !fd) return null

  return fr === fd

}



export function buildVehicleFingerprint(ver) {

  if (!ver) return null

  const marca = normalizeToken(ver.marcaDetectada)

  const modelo = normalizeToken(ver.modeloDetectado)

  const color = colorFamily(ver.colorDetectado)

  if (!marca && !modelo && !color) return null

  return {

    marca,

    modelo,

    color,

    carroceria: normalizeToken(ver.carroceriaDetectada),

  }

}



export function getReferenceFingerprintFromPhotos(photos = {}) {

  for (const ph of Object.values(photos)) {

    if (ph?.analyzed && ph?.vehicleFingerprint) return ph.vehicleFingerprint

  }

  return null

}



function compareFingerprints(reference, candidate) {

  if (!reference || !candidate) return { match: true }



  if (reference.marca && candidate.marca && !tokensOverlap(reference.marca, candidate.marca)) {

    return {

      match: false,

      message: 'La marca del vehículo en esta foto no coincide con las fotos anteriores de la inspección.',

    }

  }



  if (reference.modelo && candidate.modelo && !tokensOverlap(reference.modelo, candidate.modelo)) {

    return {

      match: false,

      message: 'El modelo del vehículo en esta foto no coincide con las fotos anteriores de la inspección.',

    }

  }



  if (reference.color && candidate.color && reference.color !== candidate.color) {

    return {

      match: false,

      message: 'El color del vehículo no coincide con las fotos ya aceptadas en esta inspección.',

    }

  }



  return { match: true }

}



function compareWithRegistration(ver, vehiculo) {

  const regMarca = vehiculo?.marca

  const regModelo = vehiculo?.modelo

  const regColor = vehiculo?.color

  const detMarca = isAbsentLabel(ver?.marcaDetectada) ? null : ver?.marcaDetectada

  const detModelo = isAbsentLabel(ver?.modeloDetectado) ? null : ver?.modeloDetectado

  const detColor = isAbsentLabel(ver?.colorDetectado) ? null : ver?.colorDetectado



  if (regMarca && detMarca && !tokensOverlap(regMarca, detMarca)) {

    return {

      status: VEHICLE_MATCH_STATUS.OTHER,

      message: `Marca detectada (${detMarca}) no coincide con la registrada (${regMarca}). Esta foto parece ser de otro vehículo.`,

      allowUpload: false,

    }

  }



  if (regModelo && detModelo && !tokensOverlap(regModelo, detModelo)) {

    return {

      status: VEHICLE_MATCH_STATUS.OTHER,

      message: `Modelo detectado (${detModelo}) no coincide con el registrado (${regModelo}).`,

      allowUpload: false,

    }

  }



  const colorOk = colorsCompatible(regColor, detColor)

  if (colorOk === false) {

    return {

      status: VEHICLE_MATCH_STATUS.OTHER,

      message: `Color detectado (${detColor}) no coincide con el registrado (${regColor}).`,

      allowUpload: false,

    }

  }



  return null

}



function evaluateSerialPhotoMatch(analysis, vehiculo) {

  const ver = analysis?.verificacionVehiculo

  const regSerial = normalizeSerial(vehiculo?.serial)

  const detSerial = normalizeSerial(ver?.serialDetectado)



  if (!regSerial) {

    return {

      status: VEHICLE_MATCH_STATUS.UNCERTAIN,

      message:

        'No hay serial registrado del carnet para comparar. Completa los datos del vehículo en el paso 1.',

      allowUpload: false,

    }

  }



  if (!detSerial || isAbsentLabel(ver?.serialDetectado)) {

    return {

      status: VEHICLE_MATCH_STATUS.UNCERTAIN,

      message:

        ver?.motivo ||

        'No se pudo leer el serial en la foto. Acerca la cámara y mejora la iluminación sobre la impronta.',

      allowUpload: false,

    }

  }



  if (

    ver?.coincideSerial === false ||

    ver?.resultado === 'otro' ||

    analysis?.coincideModelo === false ||

    !serialsMatch(regSerial, detSerial)

  ) {

    return {

      status: VEHICLE_MATCH_STATUS.OTHER,

      message:

        ver?.motivo ||

        `El serial detectado (${detSerial}) no coincide con el del carnet (${regSerial}).`,

      allowUpload: false,

    }

  }



  if (ver?.resultado === 'incierto' || (typeof ver?.confianza === 'number' && ver.confianza < 0.75)) {

    return {

      status: VEHICLE_MATCH_STATUS.UNCERTAIN,

      message:

        ver?.motivo ||

        'No se pudo leer el serial con claridad. Toma una foto más nítida de la impronta.',

      allowUpload: false,

    }

  }



  return {

    status: VEHICLE_MATCH_STATUS.SAME,

    message: null,

    allowUpload: true,

  }

}



function evaluateContentMatch(analysis) {

  const c = analysis?.validacionContenido

  if (!c) return { allowUpload: true }



  if (c.esCorrecta === false) {

    return {

      status: VEHICLE_MATCH_STATUS.WRONG_CONTENT,

      message:

        c.motivo ||

        'La foto no corresponde a lo solicitado en esta secuencia.',

      allowUpload: false,

    }

  }



  if (c.esCorrecta !== true || (typeof c.confianza === 'number' && c.confianza < 0.7)) {

    return {

      status: VEHICLE_MATCH_STATUS.UNCERTAIN,

      message:

        c.motivo ||

        'No se pudo confirmar que la foto muestre lo solicitado. Toma otra con mejor encuadre e iluminación.',

      allowUpload: false,

    }

  }



  return { allowUpload: true }

}



/**

 * @param {object} analysis — respuesta de analyzeVehiclePhoto

 * @param {object} [vehiculo]

 * @param {object} [options]

 * @param {object} [options.referenceFingerprint] — huella de fotos ya aceptadas

 * @param {string} [options.diagramZone] — zona de la secuencia (ej. serial)

 * @returns {{ status: string, message: string | null, allowUpload: boolean, fingerprint?: object }}

 */


/** True si el rechazo de la IA es solo por placa (marca/modelo/color OK). */
function isPlateOnlyRejectionMotivo(motivo, ver) {
  const m = String(motivo || '').toLowerCase()
  if (m.includes('placa')) {
    // "marca, modelo y color coinciden... pero la placa..."
    if (m.includes('coinciden')) return true
    if (m.includes('placa detectada') || m.includes('placa visible') || m.includes('placa registrada')) return true
    // rechazo genérico de placa sin contradicción de marca/modelo/color
    if (
      !m.includes('marca detectada')
      && !m.includes('modelo detectado')
      && !m.includes('color detectado')
    ) {
      return true
    }
  }
  if (ver?.coincidePlaca === false && (!m || m.includes('placa'))) return true
  return false
}

export function evaluateVehiclePhotoMatch(analysis, vehiculo, options = {}) {

  const contentResult = evaluateContentMatch(analysis)

  if (!contentResult.allowUpload) return contentResult



  if (options.diagramZone === 'serial') {

    return evaluateSerialPhotoMatch(analysis, vehiculo)

  }



  if (SKIP_VEHICLE_IDENTITY_ZONES.has(options.diagramZone)) {

    return {

      status: VEHICLE_MATCH_STATUS.SAME,

      message: null,

      allowUpload: true,

    }

  }

  let ver = analysis?.verificacionVehiculo
  if (DISABLE_PLATE_STEP1_MATCH && ver) {
    const motivo = ver.motivo || analysis?.motivoNoCoincide || ''
    if (isPlateOnlyRejectionMotivo(motivo, ver)) {
      ver = {
        ...ver,
        coincidePlaca: true,
        resultado: ver.resultado === 'otro' ? 'mismo' : ver.resultado,
        confianza: Math.max(typeof ver.confianza === 'number' ? ver.confianza : 0.85, 0.85),
        motivo: 'Validación de placa omitida temporalmente.',
      }
      if (analysis) {
        analysis.motivoNoCoincide = null
        analysis.coincideModelo = true
      }
    }
  }


  const placaReg = normalizePlaca(vehiculo?.placa)

  const placaDet = normalizePlaca(

    ver?.placaDetectada ?? analysis?.placaDetectada ?? '',

  )



  if (!DISABLE_PLATE_STEP1_MATCH) {
if (placaReg && placaDet && placaReg !== placaDet) {

    return {

      status: VEHICLE_MATCH_STATUS.OTHER,

      message: `La placa detectada (${formatPlacaDisplay(placaDet)}) no coincide con la del vehículo registrado (${formatPlacaDisplay(placaReg)}).`,

      allowUpload: false,

    }

  }



  if (ver?.coincidePlaca === false && placaDet) {

    return {

      status: VEHICLE_MATCH_STATUS.OTHER,

      message:

        ver.motivo ||

        `La placa visible (${formatPlacaDisplay(placaDet)}) no corresponde al vehículo de esta inspección.`,

      allowUpload: false,

    }

  }
  }



  const registrationMismatch = compareWithRegistration(ver, vehiculo)

  if (registrationMismatch) return registrationMismatch



  const candidateFingerprint =

    analysis?.vehicleFingerprint ?? buildVehicleFingerprint(ver)

  const crossPhoto = compareFingerprints(

    options.referenceFingerprint,

    candidateFingerprint,

  )

  if (!crossPhoto.match) {

    return {

      status: VEHICLE_MATCH_STATUS.OTHER,

      message: crossPhoto.message,

      allowUpload: false,

    }

  }



  const resultado = ver?.resultado

  const confianza =

    typeof ver?.confianza === 'number'

      ? ver.confianza

      : analysis?.coincideModelo === false

        ? 0.85

        : null



  if (!ver?.resultado && (vehiculo?.marca || vehiculo?.modelo)) {

    return {

      status: VEHICLE_MATCH_STATUS.UNCERTAIN,

      message:

        'No se pudo verificar el vehículo en la imagen. Toma una foto más clara donde se vea la marca y el modelo.',

      allowUpload: false,

    }

  }



  if (resultado === 'otro' || analysis?.coincideModelo === false) {

    return {

      status: VEHICLE_MATCH_STATUS.OTHER,

      message:

        ver?.motivo ||

        analysis?.motivoNoCoincide ||

        'La foto parece corresponder a otro vehículo distinto al registrado en esta inspección.',

      allowUpload: false,

    }

  }



  if (resultado === 'incierto' || confianza == null || confianza < 0.75) {

    return {

      status: VEHICLE_MATCH_STATUS.UNCERTAIN,

      message:

        ver?.motivo ||

        'No podemos confirmar que sea el mismo vehículo. Toma una foto más clara, con mejor iluminación y el vehículo completo visible.',

      allowUpload: false,

    }

  }



  if (

    resultado === 'mismo' &&

    (vehiculo?.marca || vehiculo?.modelo) &&

    !ver?.marcaDetectada &&

    !ver?.modeloDetectado

  ) {

    return {

      status: VEHICLE_MATCH_STATUS.UNCERTAIN,

      message:

        'No se identificó claramente la marca o modelo del vehículo. Acércate y toma una foto donde se vean mejor.',

      allowUpload: false,

    }

  }



  return {

    status: VEHICLE_MATCH_STATUS.SAME,

    message: null,

    allowUpload: true,

    fingerprint: candidateFingerprint ?? undefined,

  }

}



function formatPlacaDisplay(normalized) {

  return normalized || ''

}


