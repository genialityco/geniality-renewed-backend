import {
  buildMetaTemplate,
  buildSendComponents,
  extractVariables,
  renderText,
  toPositional,
  validateTemplate,
} from './genon-variables';
import { DEFAULT_TEMPLATES, defaultReplies } from './genon-defaults';

describe('variables de las plantillas', () => {
  it('extrae las variables en orden y sin repetir', () => {
    expect(extractVariables('Hola {{nombre}}, {{curso}} y {{nombre}}.')).toEqual([
      'nombre',
      'curso',
    ]);
  });

  it('convierte a posicionales para Meta', () => {
    expect(toPositional('Hola {{nombre}}, vas en {{curso}}. Ánimo {{nombre}}.')).toEqual({
      text: 'Hola {{1}}, vas en {{2}}. Ánimo {{1}}.',
      variables: ['nombre', 'curso'],
    });
  });

  it('renderiza y marca las que faltan', () => {
    expect(renderText('Hola {{nombre}} de {{curso}}', { nombre: 'Ana' })).toBe(
      'Hola Ana de …',
    );
  });
});

describe('validateTemplate (reglas de Meta)', () => {
  it('todas las plantillas del documento cumplen las reglas', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect({ key: t.key, errors: validateTemplate(t) }).toEqual({
        key: t.key,
        errors: [],
      });
    }
  });

  it('rechaza variables al inicio o al final', () => {
    expect(validateTemplate({ body: '{{nombre}}, hola.' }).join(' ')).toMatch(/empezar/);
    expect(validateTemplate({ body: 'Tu enlace es {{link}}' }).join(' ')).toMatch(/terminar/);
    expect(validateTemplate({ body: 'Tu enlace es {{link}}.' }).join(' ')).toMatch(/terminar/);
  });

  it('rechaza variables desconocidas y botones largos', () => {
    const errors = validateTemplate({
      body: 'Hola {{apodo}}, sigue.',
      buttons: [{ type: 'QUICK_REPLY', text: 'Un texto de botón demasiado largo', action: 'challenge' }],
    });
    expect(errors.join(' ')).toMatch(/desconocida/);
    expect(errors.join(' ')).toMatch(/25 caracteres/);
  });

  it('exige agrupar respuestas rápidas y enlaces', () => {
    const errors = validateTemplate({
      body: 'Hola {{nombre}}, sigue.',
      buttons: [
        { type: 'QUICK_REPLY', text: 'A', action: 'challenge' },
        { type: 'URL', text: 'B' },
        { type: 'QUICK_REPLY', text: 'C', action: 'challenge' },
      ],
    });
    expect(errors.join(' ')).toMatch(/agrupados/);
  });

  it('los textos de respuesta usan solo variables conocidas', () => {
    for (const r of defaultReplies()) {
      const unknown = validateTemplate({ body: `x ${r.text} x` }).filter((e) =>
        e.includes('desconocida'),
      );
      expect({ key: r.key, unknown }).toEqual({ key: r.key, unknown: [] });
    }
  });
});

describe('buildMetaTemplate', () => {
  it('arma cuerpo con ejemplos, botones y URL dinámica', () => {
    const t = DEFAULT_TEMPLATES.find((x) => x.key === 'motivation')!;
    const { payload, variables } = buildMetaTemplate(
      { ...t, language: 'es', category: 'UTILITY' },
      'genon_motivation_v1',
      'https://app.geniality.com.co/',
    );
    expect(payload.name).toBe('genon_motivation_v1');
    expect(variables).toEqual(['nombre', 'avance', 'curso', 'actividad_pendiente', 'min_actividad']);
    const body = payload.components.find((c) => c.type === 'BODY');
    expect(body.text).toContain('{{1}}');
    expect(body.example.body_text[0]).toHaveLength(5);
    const buttons = payload.components.find((c) => c.type === 'BUTTONS').buttons;
    expect(buttons[1]).toMatchObject({
      type: 'URL',
      url: 'https://app.geniality.com.co/organization/{{1}}',
    });
  });
});

describe('buildSendComponents', () => {
  const buttons = [
    { type: 'QUICK_REPLY' as const, text: 'Acepto', action: 'challenge' as const },
    { type: 'URL' as const, text: 'Ir' },
  ];

  it('ordena los valores, limpia saltos de línea y arma los botones', () => {
    const components = buildSendComponents({
      variables: ['nombre', 'curso'],
      values: { nombre: 'Ana', curso: 'Curso\ncon salto' },
      buttons,
      urlSuffix: 'org/activitydetail/act?ref=1',
      payloadFor: (b) => `gn:e1:${b.action}`,
    });
    expect(components[0].parameters.map((p) => p.text)).toEqual([
      'Ana',
      'Curso con salto',
    ]);
    expect(components[1]).toEqual({
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [{ type: 'payload', payload: 'gn:e1:challenge' }],
    });
    expect(components[2]).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '1',
      parameters: [{ type: 'text', text: 'org/activitydetail/act?ref=1' }],
    });
  });

  it('no envía si falta el valor de una variable', () => {
    expect(() =>
      buildSendComponents({
        variables: ['nombre', 'curso'],
        values: { nombre: 'Ana' },
        buttons: [],
        urlSuffix: '',
        payloadFor: () => '',
      }),
    ).toThrow(/curso/);
  });
});
