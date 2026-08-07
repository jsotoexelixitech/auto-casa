/**
 * AI Document OCR — cliente del API backend
 * La lógica Gemini vive en backend/src/modules/ai/
 */

import * as api from './api'
import { ApiError } from './api'
import {
  OcrDocumentInvalidError,
  OCR_ILLEGIBLE_MESSAGE,
  validateOcrResult,
} from '../utils/ocrValidation'

function isOcrValidationApiError(err) {
  if (!(err instanceof ApiError)) return false
  if (err.status === 400) return true
  // Compat: versiones previas devolvían 503 al validar el documento
  if (
    err.status === 503 &&
    /documento|legible|corresponde|cédula|carnet|rif/i.test(err.message)
  ) {
    return true
  }
  return false
}

/**
 * Extrae datos de un documento venezolano vía backend (/ai/extract-document).
 * @param {string} imageData - base64 data URL
 * @param {'cedula'|'certificado'|'rif'} docType
 */
export async function extractDocumentOcr(imageData, docType) {
  const kind = docType === 'certificado' ? 'certificado' : docType

  try {
    const data = await api.ai.extractDocument({
      imageData,
      docType: kind,
    })

    const validation = validateOcrResult(kind, data)
    if (!validation.valid) {
      throw new OcrDocumentInvalidError(validation.message ?? OCR_ILLEGIBLE_MESSAGE)
    }

    return data
  } catch (err) {
    if (err instanceof OcrDocumentInvalidError) throw err
    if (err instanceof ApiError) {
      if (isOcrValidationApiError(err)) {
        throw new OcrDocumentInvalidError(err.message || OCR_ILLEGIBLE_MESSAGE)
      }
      if (err.status === 0) {
        throw new Error(
          'Backend no disponible — verifica que el API esté corriendo (npm run start:dev en backend/).',
        )
      }
      if (err.status === 401) {
        throw new Error(
          'Sesión requerida — inicia sesión para usar el OCR.',
        )
      }
      if (
        err.status === 503 &&
        /gemini|high demand|try again|sobrecarga|demand/i.test(err.message)
      ) {
        throw new Error(
          'El servicio de IA está ocupado temporalmente. Espera unos segundos e intenta de nuevo.',
        )
      }
    }
    throw err
  }
}
