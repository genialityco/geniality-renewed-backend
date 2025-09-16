// src/templates/contents/subscription.content.ts

export type SubscriptionContentOptions = {
  /** URL absoluta a la organización (se mostrará y será clickeable) */
  /** Fecha de vigencia (Date o string). Solo se muestra si viene. */
  dateUntil?: Date | string;
  /** Variante del mensaje principal */
  variant?: 'created' | 'updated'; // 'created' = "Gracias por tu suscripción", 'updated' = "¡Suscripción actualizada!"
  /** Texto del botón/píldora de agradecimiento (opcional) */
  thanksText?: string;

  nameUser?: string; // Nombre del usuario (no se usa en el contenido actual)
};

/** Formato de fecha email-safe en español (ej: 12/09/2025) */
function formatDateEs(value?: Date | string): string | null {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function renderSubscriptionContent(
  opts: SubscriptionContentOptions
) {
  const nameUser = opts.nameUser || 'Usuario';
  const dateText = formatDateEs(opts.dateUntil);
  const variant = opts.variant || 'created';
  const thanksText = opts.thanksText || '¡Gracias por confiar en EndoCampus!';

  const headline =
    variant === 'updated'
      ? `${nameUser}, ¡Tu suscripción fue actualizada !`
      : '¡Gracias por tu suscripción a <span style="color:#0b3d91;">EndoCampus</span>!';

  // Caja con borde redondeado que simula el bloque grande del flyer
  const heroBox = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:18px 20px 0 20px;">
      <tr>
        <td align="center" style="padding:12px 18px;border:2px solid #d6e0ea;border-radius:12px;color:#0b3d91;font-weight:800;font-size:18px;">
          ${headline}
        </td>
      </tr>
    </table>
  `;

  // Tarjeta blanca con contenido descriptivo
  const whiteCard = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:16px 20px;">
      <tr>
        <td style="background:#ffffff;border-radius:14px;box-shadow:0 6px 18px rgba(0,0,0,0.08);padding:22px;">
          <div style="color:#111827;font-size:14px;line-height:1.7;text-align:center;margin:0 0 10px 0;">
            Tu suscripción a <b>EndoCampus</b> ha sido ${variant === 'updated' ? 'actualizada' : 'activada'} de manera exitosa.
            ${dateText ? `Ahora tienes acceso hasta el <b>${dateText}</b>.` : ''}
          </div>

          <div style="font-size:14px;line-height:1.7;text-align:center;margin:12px 0 0 0;">
            <div style="font-weight:800;color:#0b3d91;text-transform:uppercase;letter-spacing:.2px;">
              SIMPOSIOS Y CONGRESOS ACTUALIZADOS
            </div>
            <div style="font-weight:800;color:#0b3d91;text-transform:uppercase;letter-spacing:.2px;">
              CURSOS ESPECIALIZADOS
            </div>
            <div style="font-weight:800;color:#0b3d91;text-transform:uppercase;letter-spacing:.2px;">
              MATERIAL ACADÉMICO DE REFERENCIA
            </div>
          </div>

          <div style="color:#111827;font-size:14px;line-height:1.7;text-align:center;margin:14px 0 0 0;">
            Estamos comprometidos en ofrecerte una experiencia de aprendizaje médico de primer nivel,
            diseñada para acompañar tu desarrollo profesional.
          </div>

          <div style="color:#111827;font-size:14px;line-height:1.7;text-align:center;margin:14px 0 0 0;">
            Te invitamos a iniciar sesión y comenzar tu recorrido académico en:
          </div>
        </td>
      </tr>
    </table>
  `;
  // Píldora de agradecimiento
  const thanksPill = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="center" style="padding:6px 24px 10px 24px;">
          <span style="display:inline-block;background:#e0e7ff;color:#3730a3;font-size:13px;font-weight:600;padding:6px 16px;border-radius:9999px;">
            ${thanksText}
          </span
        </td>
      </tr>
    </table>
  `;

  // Firma (el flyer la muestra)
  const signature = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="center" style="padding:8px 20px 0 20px;color:#111827;font-size:13px;">
          Atentamente,<br>
          <b>Equipo EndoCampus – ACE</b>
        </td>
      </tr>
    </table>
  `;

  return `
    ${heroBox}
    ${whiteCard}
    ${thanksPill}
    ${signature}
  `;
}
