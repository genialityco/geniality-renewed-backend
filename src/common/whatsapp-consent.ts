/**
 * Consentimiento efectivo para recibir WhatsApp iniciados por la plataforma
 * (recordatorios, simulacros, notificaciones). Lo tiene quien no se ha dado
 * de baja (`whatsapp_opt_out_at`) y además:
 *   - todos, mientras el consentimiento por defecto esté activo
 *     (WHATSAPP_CONSENT_DEFAULT, activo salvo que valga "false"); o, si no,
 *   - quien activó el opt-in de WhatsApp en su perfil, o
 *   - quien marcó en el formulario de registro el campo que la organización
 *     definió como consentimiento (`organization.whatsapp_consent_property`,
 *     p. ej. "consentimientoProfSalud" en ACE).
 *
 * La baja siempre gana: quien responde BAJA o desactiva WhatsApp en su
 * perfil no vuelve a recibir mensajes, sea cual sea el valor por defecto.
 */
export function hasWhatsappConsent(
  orgUser:
    | {
        whatsapp_opt_in?: boolean | null;
        whatsapp_opt_out_at?: Date | null;
        properties?: Record<string, any> | null;
      }
    | null
    | undefined,
  consentProperty?: string | null,
): boolean {
  if (!orgUser || orgUser.whatsapp_opt_out_at) return false;
  if (orgUser.whatsapp_opt_in === true) return true;
  if (isConsentByDefault()) return true;
  if (!consentProperty) return false;
  return isAccepted(orgUser.properties?.[consentProperty]);
}

/**
 * Todos los miembros cuentan con consentimiento salvo baja. Se lee en cada
 * llamada para poder apagarlo con WHATSAPP_CONSENT_DEFAULT=false (y reiniciar)
 * sin cambiar código.
 */
export function isConsentByDefault(): boolean {
  return process.env.WHATSAPP_CONSENT_DEFAULT !== 'false';
}

/** Valores con los que un campo booleano del formulario cuenta como aceptado. */
function isAccepted(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['true', 'si', 'sí', '1', 'yes'].includes(value.trim().toLowerCase());
}
