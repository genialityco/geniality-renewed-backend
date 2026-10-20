/**
 * Consentimiento efectivo para recibir WhatsApp iniciados por la plataforma
 * (recordatorios, notificaciones). Lo tiene quien:
 *   - no se ha dado de baja (`whatsapp_opt_out_at`), y
 *   - activó el opt-in de WhatsApp en su perfil, o
 *   - marcó en el formulario de registro el campo que la organización
 *     definió como consentimiento (`organization.whatsapp_consent_property`,
 *     p. ej. "consentimientoProfSalud" en ACE).
 *
 * La baja siempre gana: aunque el campo del formulario siga en true, quien
 * responde BAJA o desactiva WhatsApp en su perfil no vuelve a recibir mensajes.
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
  if (!consentProperty) return false;
  return isAccepted(orgUser.properties?.[consentProperty]);
}

/** Valores con los que un campo booleano del formulario cuenta como aceptado. */
function isAccepted(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['true', 'si', 'sí', '1', 'yes'].includes(value.trim().toLowerCase());
}
