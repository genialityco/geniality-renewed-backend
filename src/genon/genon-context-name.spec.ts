import { formalName } from './genon-context.service';

describe('formalName', () => {
  it('antepone Dr(a). al primer nombre', () => {
    expect(formalName('Ana María Gómez')).toBe('Dr(a). Ana');
    expect(formalName('  Juan  ')).toBe('Dr(a). Juan');
  });

  it('sin nombre queda solo el título', () => {
    expect(formalName('')).toBe('Dr(a).');
    expect(formalName(null)).toBe('Dr(a).');
    expect(formalName('estudiante')).toBe('Dr(a).');
  });
});
