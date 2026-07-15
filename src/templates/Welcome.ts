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

/**
 * Reemplaza variables tipo {{clave}} por su valor.
 * Insensible a mayúsculas y a espacios internos: {{ Nombres }} == {{nombres}}.
 */
export function fillTemplate(
  text: string,
  vars: Record<string, string | undefined>,
): string {
  return String(text ?? '').replace(
    /\{\{\s*([\w-]+)\s*\}\}/gi,
    (match, key: string) => {
      const found = Object.keys(vars).find(
        (k) => k.toLowerCase() === String(key).toLowerCase(),
      );
      return found ? (vars[found] ?? '') : match;
    },
  );
}

/** Compatibilidad: reemplaza únicamente la variable {{nombres}}. */
export function fillWelcomeTemplate(text: string, displayName: string): string {
  return fillTemplate(text, { nombres: displayName || 'Usuario' });
}

/**
 * Sanitizado ligero para HTML configurado por la organización.
 * Elimina <script>/<style>, manejadores on* y URLs javascript:.
 * Pensado para contenido de administradores (semi-confiable) en correos.
 */
export function sanitizeEmailHtml(html: string): string {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

/**
 * Contenido de correo configurable por organización.
 * `title` y el cuerpo provienen de la configuración de la organización y
 * admiten variables tipo {{clave}} (por ejemplo {{nombres}}, {{fecha}}).
 *
 * El cuerpo puede venir en dos formatos:
 *  - `body_html`: HTML del editor visual, se sanitiza y se inserta tal cual.
 *  - `body` (heredado): texto plano; se escapa y sus saltos de línea se
 *    convierten en <br> (párrafos separados por una línea en blanco).
 *
 * `vars.nombres` se usa además para el saludo "Estimado(a) ...,".
 */
export function renderOrgEmailContent(
  cfg: { title?: string; body?: string; body_html?: string } | undefined,
  vars: Record<string, string | undefined>,
  opts?: { fallbackTitle?: string; greeting?: boolean },
): string {
  const title = fillTemplate(cfg?.title || '', vars).trim();
  const name = (vars.nombres || '').trim();
  const showGreeting = opts?.greeting !== false && !!name;

  let bodyHtml: string;
  if (cfg?.body_html && cfg.body_html.trim()) {
    // Cuerpo HTML del editor visual.
    bodyHtml = sanitizeEmailHtml(fillTemplate(cfg.body_html, vars).trim());
  } else {
    // Cuerpo heredado en texto plano.
    const rawBody = fillTemplate(cfg?.body || '', vars).trim();
    bodyHtml = rawBody
      .split(/\n{2,}/)
      .map((para) => escapeHtml(para).replace(/\n/g, '<br>'))
      .filter((p) => p.length > 0)
      .map((p) => `<p style="margin:0 0 14px 0;">${p}</p>`)
      .join('');
  }

  const titleBox = `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:18px 20px 8px 20px;">
    <tr>
      <td align="center" style="padding:10px 16px;border:2px solid #d6e0ea;border-radius:12px;color:#0b3d91;font-weight:700;font-size:16px;">
        ${escapeHtml(title) || escapeHtml(opts?.fallbackTitle || '¡Hola!')}
      </td>
    </tr>
  </table>`;

  const greetingBox = showGreeting
    ? `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding:22px 24px 6px 24px;">
        <div style="font-weight:800;color:#F05A28;font-size:18px;margin:0 0 12px 0;text-align:center;">
          Estimado(a) ${escapeHtml(name)},
        </div>
      </td>
    </tr>
  </table>`
    : '';

  return `
  ${titleBox}
  ${greetingBox}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td style="padding:0 24px 16px 24px;color:#111827;font-size:14px;line-height:1.7;text-align:justify;">
        ${bodyHtml}
      </td>
    </tr>
  </table>
  `;
}

/**
 * Compatibilidad: contenido de bienvenida configurable por organización.
 * Delega en {@link renderOrgEmailContent}.
 */
export function renderOrgWelcomeContent(
  displayName: string,
  cfg?: { title?: string; body?: string; body_html?: string },
) {
  const safeName = displayName || 'Usuario';
  return renderOrgEmailContent(cfg, { nombres: safeName }, {
    fallbackTitle: `${safeName} ¡Bienvenido(a)!`,
  });
}
