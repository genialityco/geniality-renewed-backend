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
