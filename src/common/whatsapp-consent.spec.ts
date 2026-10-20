import { hasWhatsappConsent } from './whatsapp-consent';

describe('hasWhatsappConsent', () => {
  const original = process.env.WHATSAPP_CONSENT_DEFAULT;
  afterEach(() => {
    if (original === undefined) delete process.env.WHATSAPP_CONSENT_DEFAULT;
    else process.env.WHATSAPP_CONSENT_DEFAULT = original;
  });

  describe('con consentimiento por defecto (sin configurar)', () => {
    beforeEach(() => delete process.env.WHATSAPP_CONSENT_DEFAULT);

    it('cuenta como aceptado a quien nunca lo tocó', () => {
      expect(hasWhatsappConsent({ whatsapp_opt_in: false })).toBe(true);
      expect(hasWhatsappConsent({})).toBe(true);
    });

    it('la baja siempre gana', () => {
      expect(
        hasWhatsappConsent({
          whatsapp_opt_in: true,
          whatsapp_opt_out_at: new Date(),
        }),
      ).toBe(false);
    });

    it('sin membresía no hay consentimiento', () => {
      expect(hasWhatsappConsent(null)).toBe(false);
    });
  });

  describe('con WHATSAPP_CONSENT_DEFAULT=false', () => {
    beforeEach(() => (process.env.WHATSAPP_CONSENT_DEFAULT = 'false'));

    it('exige el opt-in del perfil o la casilla de la organización', () => {
      expect(hasWhatsappConsent({ whatsapp_opt_in: false })).toBe(false);
      expect(hasWhatsappConsent({ whatsapp_opt_in: true })).toBe(true);
      expect(
        hasWhatsappConsent(
          { properties: { consentimiento: 'Sí' } },
          'consentimiento',
        ),
      ).toBe(true);
    });
  });
});
