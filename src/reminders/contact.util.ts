import { OrganizationUser } from 'src/organization-users/schemas/organization-user.schema';

/**
 * Los datos de contacto viven en la membresía (organizationusers.properties);
 * el documento de users casi nunca tiene phone y queda solo como fallback.
 *
 * El teléfono de la membresía viene sin indicativo (ej. "3132735116" +
 * indicativodepais "+57"); Meta espera solo dígitos con el país adelante.
 * Solo se antepone el indicativo si el número no lo trae ya.
 */
export function resolvePhone(
  orgUser: OrganizationUser | null,
  user: any,
): string | null {
  const rawPhone = String(orgUser?.properties?.phone ?? '').replace(/\D/g, '');
  const prefix = String(orgUser?.properties?.indicativodepais ?? '').replace(
    /\D/g,
    '',
  );

  if (rawPhone) {
    const alreadyPrefixed =
      prefix && rawPhone.startsWith(prefix) && rawPhone.length > 10;
    if (prefix && !alreadyPrefixed) return `${prefix}${rawPhone}`;
    return rawPhone;
  }

  const userPhone = String(user?.phone ?? '').replace(/\D/g, '');
  return userPhone || null;
}

export function resolveName(
  orgUser: OrganizationUser | null,
  user: any,
): string {
  const props = orgUser?.properties ?? {};
  const fullName = [props.nombres, props.apellidos]
    .filter(Boolean)
    .join(' ')
    .trim();
  return fullName || props.names || user?.names || 'estudiante';
}

export function resolveEmail(
  orgUser: OrganizationUser | null,
  user: any,
): string | null {
  return orgUser?.properties?.email || user?.email || null;
}

/**
 * user-activity.organization_id a veces queda guardado como la URL completa
 * de la organización (ej. "https://app.geniality.com.co/organization/<id>")
 * en vez del id solo, por un bug de origen en el frontend. Si no se
 * normaliza antes de usarlo, tanto el lookup de la organización como los
 * links armados con baseUrl + "/organization/" + organization_id quedan con
 * la URL duplicada. Si detecta una URL, se queda con el segmento que sigue
 * a "organization"; si no, lo deja tal cual.
 */
export function sanitizeOrganizationId(raw: string): string {
  const str = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(str)) return str;

  const segments = str.split('/').filter(Boolean);
  const orgIndex = segments.lastIndexOf('organization');
  if (orgIndex >= 0 && segments[orgIndex + 1]) {
    return segments[orgIndex + 1];
  }
  return segments[segments.length - 1] || str;
}
