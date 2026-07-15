// src/templates/contents/welcome.content.ts
/**
 * Contenido variable para el correo de bienvenida.
 * Se inserta dentro del layout (no incluye header/footer).
 */
export function renderWelcomeContent(displayName: string) {
  const safeName = displayName || 'Usuario';
  return `
  <!-- Caja 'Asunto' -->
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:18px 20px 8px 20px;">
    <tr>
      <td align="center" style="padding:10px 16px;border:2px solid #d6e0ea;border-radius:12px;color:#0b3d91;font-weight:700;font-size:16px;">
        ${safeName} ¡Bienvenido(a) a EndoCampus!
      </td>
    </tr>
    <tr>
      <td align="center" style="padding-top:6px;color:#6b7280;font-size:13px;">
        Tu aprendizaje médico comienza aquí
      </td>
    </tr>
  </table>
  <!-- Bloque gris con saludo -->
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:0 20px;">
    <tr>
      <td>
        <!-- Saludo + texto (centrado el bloque, título centrado, párrafo justificado) -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:0 20px;">
          <tr>
            <td align="center" style="padding:22px 22px 6px 22px;">
              <!-- Título centrado -->
              <div style="font-weight:800;color:#F05A28;font-size:18px;margin:0 0 10px 0;text-align:center;">
                Estimado(a) ${safeName},
              </div>

              <!-- Párrafo justificado (con fallback para Outlook/Word) -->
              <!--[if mso]>
              <div style="text-align:justify;text-justify:inter-ideograph;">
              <![endif]-->
              <div style="color:#111827;font-size:14px;line-height:1.6;margin:0;text-align:justify;text-justify:inter-ideograph;">
                Es un gusto darte la bienvenida a <b>EndoCampus</b>, la plataforma de educación médica virtual de la 
                <b>Asociación Colombiana de Endocrinología, Diabetes y Metabolismo – ACE</b>.
              </div>
              <!--[if mso]></div><![endif]-->
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- Texto principal centrado -->
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding:16px 24px;color:#111827;font-size:14px;line-height:1.7;text-align:center;">
        Aquí encontrarás simposios, congresos, cursos y material educativo de alta calidad, desarrollados por líderes de opinión en distintas áreas de la Endocrinología.
        <br><br>
        Recuerda que para acceder al contenido educativo es necesario contar con una suscripción anual 
        (<b>valor $50.000 COP o 15 USD</b>).
        <br><br>
        ¡Explora, aprende y fortalece tus conocimientos con nosotros!
      </td>
    </tr>
  </table>

  <!-- Botón -->

  `;
}

/** Escapa HTML para evitar inyección desde texto configurado por la organización */
function escapeHtml(input: string): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Reemplaza la variable {{nombres}} por el nombre del usuario */
export function fillWelcomeTemplate(text: string, displayName: string): string {
  const safeName = displayName || 'Usuario';
  return String(text ?? '').replace(/\{\{\s*nombres\s*\}\}/gi, safeName);
}

/**
 * Contenido de bienvenida configurable por organización.
 * `title` y `body` provienen de la configuración de la organización y
 * admiten la variable {{nombres}}. El `body` se escapa y sus saltos de
 * línea se convierten en <br> (párrafos con doble salto).
 */
export function renderOrgWelcomeContent(
  displayName: string,
  cfg?: { title?: string; body?: string },
) {
  const safeName = displayName || 'Usuario';
  const title = fillWelcomeTemplate(cfg?.title || '', safeName).trim();
  const rawBody = fillWelcomeTemplate(cfg?.body || '', safeName).trim();

  const bodyHtml = rawBody
    .split(/\n{2,}/)
    .map((para) => escapeHtml(para).replace(/\n/g, '<br>'))
    .filter((p) => p.length > 0)
    .map(
      (p) =>
        `<p style="margin:0 0 14px 0;">${p}</p>`,
    )
    .join('');

  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:18px 20px 8px 20px;">
    <tr>
      <td align="center" style="padding:10px 16px;border:2px solid #d6e0ea;border-radius:12px;color:#0b3d91;font-weight:700;font-size:16px;">
        ${escapeHtml(title) || `${escapeHtml(safeName)} ¡Bienvenido(a)!`}
      </td>
    </tr>
  </table>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding:22px 24px 6px 24px;">
        <div style="font-weight:800;color:#F05A28;font-size:18px;margin:0 0 12px 0;text-align:center;">
          Estimado(a) ${escapeHtml(safeName)},
        </div>
      </td>
    </tr>
  </table>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td style="padding:0 24px 16px 24px;color:#111827;font-size:14px;line-height:1.7;text-align:justify;">
        ${bodyHtml}
      </td>
    </tr>
  </table>
  `;
}
