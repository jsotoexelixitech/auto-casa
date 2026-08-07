import { VehiculoContext } from './prompts/vehicle-analysis.prompt';
import { shouldSkipVehicleIdentity } from './sequence-content';

export interface VerificacionVehiculo {
  resultado?: 'mismo' | 'otro' | 'incierto';
  confianza?: number;
  motivo?: string;
  placaDetectada?: string | null;
  coincidePlaca?: boolean | null;
  marcaDetectada?: string | null;
  modeloDetectado?: string | null;
  colorDetectado?: string | null;
  carroceriaDetectada?: string | null;
  serialDetectado?: string | null;
  coincideSerial?: boolean | null;
}

const COLOR_SYNONYMS: Record<string, string[]> = {
  blanco: ['blanco', 'white', 'perla', 'marfil'],
  negro: ['negro', 'black', 'grafito'],
  gris: ['gris', 'gray', 'grey', 'plata', 'silver', 'plateado'],
  rojo: ['rojo', 'red', 'burdeos', 'vino'],
  azul: ['azul', 'blue', 'marino', 'celeste'],
  verde: ['verde', 'green'],
  amarillo: ['amarillo', 'yellow', 'dorado', 'gold'],
  marron: ['marron', 'marrón', 'brown', 'beige', 'arena', 'cafe'],
};

function normalizeToken(value?: string | null): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOverlap(a: string, b: string): boolean {
  const na = normalizeToken(a);
  const nb = normalizeToken(b);
  if (!na || !nb) return true;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  const wa = na.split(' ').filter((w) => w.length > 2);
  const wb = nb.split(' ').filter((w) => w.length > 2);
  return wa.some((w) => wb.includes(w));
}

function colorFamily(color?: string | null): string | null {
  const n = normalizeToken(color);
  if (!n) return null;
  for (const [family, synonyms] of Object.entries(COLOR_SYNONYMS)) {
    if (synonyms.some((s) => n.includes(s) || s.includes(n))) return family;
  }
  return n;
}

function colorsCompatible(
  registered?: string,
  detected?: string | null,
): boolean | null {
  if (!registered || !detected) return null;
  const fr = colorFamily(registered);
  const fd = colorFamily(detected);
  if (!fr || !fd) return null;
  return fr === fd;
}

export function buildVehicleFingerprint(ver?: VerificacionVehiculo) {
  if (!ver) return null;
  const marca = normalizeToken(ver.marcaDetectada);
  const modelo = normalizeToken(ver.modeloDetectado);
  const color = colorFamily(ver.colorDetectado);
  if (!marca && !modelo && !color) return null;
  return { marca, modelo, color, carroceria: normalizeToken(ver.carroceriaDetectada) };
}

export function compareVehicleFingerprints(
  reference: ReturnType<typeof buildVehicleFingerprint>,
  candidate: ReturnType<typeof buildVehicleFingerprint>,
): { match: boolean; reason?: string } {
  if (!reference || !candidate) return { match: true };

  if (reference.marca && candidate.marca && !tokensOverlap(reference.marca, candidate.marca)) {
    return {
      match: false,
      reason: `La marca visible no coincide con las fotos anteriores (${candidate.marca} vs ${reference.marca}).`,
    };
  }

  if (
    reference.modelo &&
    candidate.modelo &&
    !tokensOverlap(reference.modelo, candidate.modelo)
  ) {
    return {
      match: false,
      reason: `El modelo visible no coincide con las fotos anteriores.`,
    };
  }

  if (
    reference.color &&
    candidate.color &&
    reference.color !== candidate.color
  ) {
    return {
      match: false,
      reason: `El color del vehículo no coincide con las fotos ya aceptadas.`,
    };
  }

  return { match: true };
}

function normalizeSerial(value?: string | null): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function isAbsentLabel(value?: string | null): boolean {
  const n = normalizeToken(value);
  if (!n) return true;
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
  ];
  return absent.some((a) => n === a || n.includes(a));
}

export function serialsMatch(registered?: string, detected?: string | null): boolean {
  const r = normalizeSerial(registered);
  const d = normalizeSerial(detected);
  if (!r || !d) return false;
  if (r === d) return true;
  if (r.length >= 6 && d.length >= 6) {
    const rTail = r.slice(-6);
    const dTail = d.slice(-6);
    if (rTail === dTail) return true;
    if (r.includes(d) || d.includes(r)) return true;
  }
  return r.includes(d) || d.includes(r);
}

function enforceSerialVerification(
  ver: VerificacionVehiculo,
  vehiculo?: VehiculoContext,
): VerificacionVehiculo {
  const out: VerificacionVehiculo = { ...ver };
  const regSerial = vehiculo?.serial;
  const detSerial = out.serialDetectado;

  out.marcaDetectada = null;
  out.modeloDetectado = null;
  out.colorDetectado = null;
  out.carroceriaDetectada = null;

  if (!regSerial?.trim()) {
    out.resultado = 'incierto';
    out.confianza = 0.4;
    out.motivo =
      'No hay serial registrado del carnet para comparar. Completa los datos del vehículo en el paso 1.';
    return out;
  }

  const detNorm = normalizeSerial(detSerial);
  if (!detNorm || isAbsentLabel(detSerial)) {
    out.resultado = 'incierto';
    out.confianza = Math.min(out.confianza ?? 0.5, 0.55);
    out.motivo =
      out.motivo ||
      'No se pudo leer el serial en la foto. Acerca la cámara y mejora la iluminación sobre la impronta.';
    return out;
  }

  if (out.coincideSerial === false || !serialsMatch(regSerial, detSerial)) {
    out.resultado = 'otro';
    out.coincideSerial = false;
    out.confianza = Math.max(out.confianza ?? 0.9, 0.9);
    out.motivo = `El serial detectado (${detNorm}) no coincide con el del carnet (${normalizeSerial(regSerial)}).`;
    return out;
  }

  out.resultado = 'mismo';
  out.coincideSerial = true;
  out.confianza = Math.max(out.confianza ?? 0.85, 0.85);
  out.motivo = out.motivo || 'Serial coincide con el carnet de circulación.';
  return out;
}

/**
 * Aplica reglas determinísticas sobre la verificación de la IA.
 * Puede elevar "mismo" a "otro" o "incierto" si hay contradicciones con el registro.
 */
export function enforceVehicleVerification(
  ver: VerificacionVehiculo | undefined,
  vehiculo?: VehiculoContext,
  diagramZone?: string,
): VerificacionVehiculo {
  const out: VerificacionVehiculo = { ...(ver ?? {}) };

  if (diagramZone === 'serial') {
    return enforceSerialVerification(out, vehiculo);
  }

  if (shouldSkipVehicleIdentity(diagramZone)) {
    out.resultado = 'mismo';
    out.confianza = Math.max(out.confianza ?? 0.85, 0.85);
    out.motivo = out.motivo || 'Secuencia validada por contenido';
    out.marcaDetectada = null;
    out.modeloDetectado = null;
    out.colorDetectado = null;
    out.carroceriaDetectada = null;
    return out;
  }

  if (!out.resultado) {
    out.resultado = vehiculo?.marca || vehiculo?.modelo ? 'incierto' : 'mismo';
    out.confianza = out.confianza ?? 0.4;
    out.motivo =
      out.motivo ||
      'No se pudo verificar la identidad del vehículo en la imagen.';
  }

  const regMarca = vehiculo?.marca;
  const regModelo = vehiculo?.modelo;
  const regColor = vehiculo?.color;
  const detMarca = isAbsentLabel(out.marcaDetectada) ? null : out.marcaDetectada;
  const detModelo = isAbsentLabel(out.modeloDetectado) ? null : out.modeloDetectado;
  const detColor = isAbsentLabel(out.colorDetectado) ? null : out.colorDetectado;

  if (regMarca && detMarca && !tokensOverlap(regMarca, detMarca)) {
    out.resultado = 'otro';
    out.confianza = Math.max(out.confianza ?? 0.9, 0.9);
    out.motivo = `Marca detectada (${detMarca}) no coincide con la registrada (${regMarca}).`;
    return out;
  }

  if (regModelo && detModelo && !tokensOverlap(regModelo, detModelo)) {
    if (regMarca && detMarca && tokensOverlap(regMarca, detMarca)) {
      out.resultado = 'otro';
      out.confianza = Math.max(out.confianza ?? 0.88, 0.88);
      out.motivo = `Modelo detectado (${detModelo}) no coincide con el registrado (${regModelo}).`;
      return out;
    }
    if (!regMarca || !detMarca) {
      out.resultado = 'otro';
      out.confianza = Math.max(out.confianza ?? 0.85, 0.85);
      out.motivo = `Modelo detectado (${detModelo}) no coincide con el registrado (${regModelo}).`;
      return out;
    }
  }

  const colorOk = colorsCompatible(regColor, detColor);
  if (colorOk === false) {
    out.resultado = 'otro';
    out.confianza = Math.max(out.confianza ?? 0.85, 0.85);
    out.motivo = `Color detectado (${detColor}) no coincide con el registrado (${regColor}).`;
    return out;
  }

  if (out.resultado === 'mismo' && (out.confianza ?? 0) < 0.75) {
    out.resultado = 'incierto';
    out.motivo =
      out.motivo ||
      'Confianza insuficiente para confirmar que sea el mismo vehículo.';
  }

  if (
    out.resultado === 'mismo' &&
    (regMarca || regModelo) &&
    !detMarca &&
    !detModelo
  ) {
    out.resultado = 'incierto';
    out.confianza = Math.min(out.confianza ?? 0.5, 0.55);
    out.motivo =
      'No se identificó claramente la marca o modelo del vehículo en la foto.';
  }

  return out;
}

/** Si es true, no marca "otro" solo por discrepancia de placa vs paso 1. */
export const DISABLE_PLATE_STEP1_MATCH = false;

function isPlateOnlyRejectionMotivo(
  motivo?: string | null,
  ver?: VerificacionVehiculo,
): boolean {
  const m = String(motivo || '').toLowerCase();
  if (m.includes('placa')) {
    if (m.includes('coinciden')) return true;
    if (
      m.includes('placa detectada') ||
      m.includes('placa visible') ||
      m.includes('placa registrada')
    ) {
      return true;
    }
    if (
      !m.includes('marca detectada') &&
      !m.includes('modelo detectado') &&
      !m.includes('color detectado')
    ) {
      return true;
    }
  }
  if (ver?.coincidePlaca === false && (!m || m.includes('placa'))) return true;
  return false;
}

/**
 * Si la IA marcó "otro" solo por placa, lo degrada a "mismo" mientras el flag esté activo.
 */
export function softIgnorePlateStep1Mismatch(
  ver: VerificacionVehiculo,
): VerificacionVehiculo {
  if (!DISABLE_PLATE_STEP1_MATCH) return ver;
  if (!isPlateOnlyRejectionMotivo(ver.motivo, ver)) return ver;
  return {
    ...ver,
    coincidePlaca: true,
    resultado: ver.resultado === 'otro' ? 'mismo' : ver.resultado,
    confianza: Math.max(ver.confianza ?? 0.85, 0.85),
    motivo: 'Validación de placa omitida temporalmente.',
  };
}
