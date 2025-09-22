import { Domain } from "domain";

export type LayoutOptions = {
  URL: string;
  preheader?: string;
  heroCid?: string;   // default: 'hero@endo'
  logosCid?: string;  // default: 'logos-footer@endo'
  blueBar?: boolean;
  domain?: string;  // default: true
};

/**
 * Layout base para correos EndoCampus: header (hero CID), content variable, footer con logos (CID).
 * Solo cambia el contentHtml; el header/footer permanecen iguales.
 */
export function renderEmailLayout(
  args: { contentHtml: string } & LayoutOptions,
): string {
  const {
    URL = 'https://app.geniality.com.co/organization',
    contentHtml,
    heroCid = 'hero@endo',
    logosCid = 'logos-footer@endo',
    blueBar = true,
    domain = 'https://app.geniality.com.co',
  } = args;

  // Guardia: evita que el content traiga rutas locales de Windows
  if (/([A-Za-z]:\\\\|\\\\\\\\)/.test(contentHtml)) {
    throw new Error('contentHtml contiene rutas locales de Windows; use CIDs o URLs públicas.');
  }
  return `
  <div style="margin:0;padding:0;background-color:#f4f6f8;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:#f4f6f8;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 6px 18px rgba(0,0,0,0.08);">
            <!-- HEADER (imagen fija por CID) -->
            <tr>
              <td style="padding:0;">
                <img src="${heroCid}" alt="EndoCampus" width="600" style="display:block;width:100%;height:auto;border:0;">
              </td>
            </tr>

            <!-- CONTENT (VARIABLE) -->
            <tr>
              <td style="padding:0;">
                ${contentHtml}
              </td>
            </tr>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td align="center" style="padding:10px 24px 6px 24px;">
                  <a href="${domain}"
                    style="display:inline-block;text-decoration:none;border:2px solid #F05A28;border-radius:999px;padding:12px 22px;
                            font-weight:800;font-size:14px;color:#0b3d91 !important;">
                    <span style="color:#0b3d91 !important;">Accede a tu cuenta</span>
                  </a>
                </td>
              </tr>
            </table>


            
            <!-- LOGOS FOOTER (imagen fija por CID) -->
            <tr>
              <td style="padding:18px 24px 6px 24px;" align="center">
                <img src="${logosCid}" alt="EndoCampus + ACE" width="220"
                     style="display:block;border:0;max-width:100%;height:auto;margin:0 auto;-ms-interpolation-mode:bicubic;">
              </td>
            </tr>
            ${blueBar
      ? `<tr>
                   <td style="background-color:#0b3d91;height:28px;line-height:28px;font-size:0;">&nbsp;</td>
                 </tr>`
      : ''}
          </table>
        </td>
      </tr>
    </table>
  </div>`;
}

