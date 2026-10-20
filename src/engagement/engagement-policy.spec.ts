import { holdoutBucket, isInHoldout, localWeekKey } from './engagement-policy';

describe('localWeekKey', () => {
  it('devuelve el lunes de la semana en hora de Bogotá', () => {
    // Miércoles 21 de octubre de 2026, 15:00 UTC
    expect(localWeekKey(new Date('2026-10-21T15:00:00Z'))).toBe('2026-10-19');
  });

  it('el lunes es su propia clave', () => {
    expect(localWeekKey(new Date('2026-10-19T12:00:00Z'))).toBe('2026-10-19');
  });

  it('el domingo pertenece a la semana que empezó el lunes anterior', () => {
    expect(localWeekKey(new Date('2026-10-25T20:00:00Z'))).toBe('2026-10-19');
  });

  it('usa la fecha local, no la UTC, en el cambio de día', () => {
    // Lunes 26 a las 02:00 UTC = domingo 25 a las 21:00 en Bogotá
    expect(localWeekKey(new Date('2026-10-26T02:00:00Z'))).toBe('2026-10-19');
  });
});

describe('grupo de control', () => {
  it('asigna siempre el mismo bucket al mismo usuario', () => {
    const id = '507f191e810c19729de860eb';
    expect(holdoutBucket(id)).toBe(holdoutBucket(id));
    expect(holdoutBucket(id)).toBeGreaterThanOrEqual(0);
    expect(holdoutBucket(id)).toBeLessThan(100);
  });

  it('con 0% nadie queda en el grupo de control y con 100% todos', () => {
    expect(isInHoldout('cualquiera', 0)).toBe(false);
    expect(isInHoldout('cualquiera', 100)).toBe(true);
  });

  it('reparte aproximadamente el porcentaje pedido', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `user-${i}`);
    const inHoldout = ids.filter((id) => isInHoldout(id, 10)).length;
    expect(inHoldout).toBeGreaterThan(140);
    expect(inHoldout).toBeLessThan(260);
  });
});
