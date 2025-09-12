// src/templates/contents/welcome.content.ts
/**
 * Contenido variable para el correo de bienvenida.
 * Se inserta dentro del layout (no incluye header/footer).
 */
export function renderWelcomeContent(displayName: string, ctaUrl: string) {
  const safeName = displayName || 'Usuario';
  const URL = ctaUrl;
  return `
  <!-- Caja 'Asunto' -->
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:18px 20px 8px 20px;">
    <tr>
      <td align="center" style="padding:10px 16px;border:2px solid #d6e0ea;border-radius:12px;color:#0b3d91;font-weight:700;font-size:16px;">
        Asunto: ${safeName} ¡Bienvenido(a) a EndoCampus!
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
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding:10px 24px 6px 24px;">
        <a href="${URL}"
           style="display:inline-block;text-decoration:none;border:2px solid #F05A28;border-radius:999px;padding:12px 22px;
                  font-weight:800;font-size:14px;color:#0b3d91 !important;">
          <span style="color:#0b3d91 !important;">¡Gracias por confiar en EndoCampus!</span>
        </a>
      </td>
    </tr>
  </table>
  `;
}
