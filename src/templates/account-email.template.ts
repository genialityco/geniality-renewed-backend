export function buildAccountEmailHtml(
    accion: 'creada' | 'actualizada',
    displayName: string,
): string {
    return `
  <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; background-color:#f4f6f8; padding: 0; margin: 0;">
    <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" 
           style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.1);">
      
      <!-- Header -->
      <tr>
        <td style="background-color:#003366; padding:20px; text-align:center; color:#ffffff; font-size:20px; font-weight:bold;">
          EndoCampus
        </td>
      </tr>

      <!-- Contenido principal -->
      <tr>
        <td style="padding: 30px;">
          <h2 style="color:#003366; margin-bottom:10px;">¡Hola ${displayName}!</h2>
          <p style="margin:0 0 15px;">
            Tu cuenta en <b>EndoCampus</b> ha sido <b>${accion}</b> correctamente.
          </p>
          <p style="margin:0 0 25px;">
            Ya puedes acceder a todos nuestros servicios y comenzar a disfrutar de la plataforma.
          </p>
          <div style="text-align:center; margin: 30px 0;">
            <a href="https://gencampus-renewed.netlify.app/organization/63f552d916065937427b3b02" 
               style="background:#003366; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:4px; font-weight:bold; display:inline-block;">
              Ingresar a mi cuenta
            </a>
          </div>
          <p style="margin-top:20px; font-size:12px; color:#666;">
            Si no reconoces este cambio, por favor contáctanos inmediatamente.
          </p>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background-color:#f4f6f8; padding:15px; text-align:center; font-size:12px; color:#777;">
          © ${new Date().getFullYear()} EndoCampus · Todos los derechos reservados
        </td>
      </tr>
    </table>
  </div>
`;
}
