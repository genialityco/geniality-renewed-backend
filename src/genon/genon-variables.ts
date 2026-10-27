import { GenOnTemplateButton } from './schemas/genon-template.schema';

/**
 * Variables disponibles en los textos de Gen.ON. `example` es el valor que se
 * manda a Meta como ejemplo al crear la plantilla (Meta lo exige).
 */
export const GENON_VARIABLES: {
  key: string;
  label: string;
  example: string;
}[] = [
  { key: 'nombre', label: 'Primer nombre del inscrito', example: 'María' },
  { key: 'correo', label: 'Correo del inscrito', example: 'maria@correo.com' },
  { key: 'curso', label: 'Nombre del curso', example: 'Endocrinología básica' },
  { key: 'avance', label: 'Avance del curso (%)', example: '35' },
  { key: 'actividad_1', label: 'Primera actividad del curso', example: 'Introducción a la diabetes' },
  { key: 'actividad_2', label: 'Segunda actividad del curso', example: 'Fisiopatología' },
  { key: 'actividad_pendiente', label: 'Siguiente actividad sin completar', example: 'Tratamiento con insulina' },
  { key: 'modulo_actual', label: 'Módulo de la actividad pendiente', example: 'Módulo 2' },
  { key: 'actividades_restantes', label: 'Actividades que le faltan', example: '6' },
  { key: 'min_actividad', label: 'Minutos de la actividad pendiente', example: '15' },
  { key: 'actividad_reto', label: 'Actividad del reto', example: 'Introducción a la diabetes' },
  { key: 'tema_actividad', label: 'Tema de la actividad del reto', example: 'diagnóstico de diabetes' },
  { key: 'num_preguntas', label: 'Preguntas del reto', example: '3' },
  { key: 'n_egresados', label: 'Egresados del curso', example: '170' },
  { key: 'n_activos_semana', label: 'Colegas que avanzaron en 7 días', example: '42' },
  { key: 'n_avanzaron', label: 'Colegas que avanzaron en 14 días', example: '58' },
  { key: 'pct_terminaron_desde_aqui', label: '% que terminó desde su módulo', example: '50' },
  { key: 'link', label: 'Enlace a la actividad pendiente', example: 'https://app.geniality.com.co/organization/1/activitydetail/2' },
  // Segmento 3, examen y certificado
  { key: 'modulo', label: 'Módulo terminado (o del examen)', example: 'Módulo 1' },
  { key: 'siguiente_modulo', label: 'Módulo siguiente', example: 'Módulo 2' },
  { key: 'percentil', label: '% de su cohorte que avanzó menos esta semana', example: '70' },
  { key: 'actividades_semana', label: 'Actividades completadas en 7 días', example: '2' },
  { key: 'hito', label: 'Próximo hito de avance', example: 'el 50 % del curso' },
  { key: 'faltan_hito', label: 'Actividades para el próximo hito', example: '1' },
  { key: 'video', label: 'Video del reto (saltable)', example: 'Clase 3: insulinas' },
  { key: 'min_video', label: 'Minutos del video del reto', example: '12' },
  { key: 'racha', label: 'Días de racha académica', example: '7' },
  { key: 'medalla', label: 'Medalla de la racha (bronce, plata, oro, diamante)', example: 'plata' },
  { key: 'ultima_actividad', label: 'Última actividad que estudió', example: 'Fisiopatología' },
  // Solo en la conversación (cierre del reto)
  { key: 'aciertos', label: 'Respuestas correctas del reto', example: '3' },
  { key: 'total', label: 'Preguntas respondidas del reto', example: '3' },
  { key: 'link_reto', label: 'Enlace a la actividad del reto', example: 'https://app.geniality.com.co/organization/1/activitydetail/2' },
  { key: 'actividad_siguiente', label: 'Actividad después del reto', example: 'Fisiopatología' },
  { key: 'link_siguiente', label: 'Enlace a la actividad después del reto', example: 'https://app.geniality.com.co/organization/1/activitydetail/3' },
];

const VAR_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

/** Variables del texto en orden de aparición, sin repetir. */
export function extractVariables(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || '').matchAll(VAR_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Reemplaza las variables; las que no tienen valor quedan como «…». */
export function renderText(
  text: string,
  values: Record<string, string | number | null | undefined>,
): string {
  return String(text || '').replace(VAR_RE, (_, key) => {
    const v = values[key];
    return v === null || v === undefined || v === '' ? '…' : String(v);
  });
}

/**
 * Meta rechaza parámetros con saltos de línea, tabulaciones o más de cuatro
 * espacios seguidos: se dejan en una sola línea.
 */
export function sanitizeParam(value: unknown, max = 300): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** Cuerpo con {{1}}…{{n}} y el orden de las variables. */
export function toPositional(body: string): {
  text: string;
  variables: string[];
} {
  const variables = extractVariables(body);
  const text = String(body || '').replace(
    VAR_RE,
    (_, key) => `{{${variables.indexOf(key) + 1}}}`,
  );
  return { text, variables };
}

/**
 * Problemas que harían que Meta rechace la plantilla o que el envío falle.
 * Vacío = se puede enviar a revisión.
 */
export function validateTemplate(t: {
  body: string;
  footer?: string;
  buttons?: GenOnTemplateButton[];
}): string[] {
  const errors: string[] = [];
  const body = String(t.body || '').trim();
  const known = new Set(GENON_VARIABLES.map((v) => v.key));

  if (!body) errors.push('El texto no puede estar vacío.');
  if (body.length > 1024) errors.push('El texto supera 1024 caracteres.');
  if (/^\{\{/.test(body)) {
    errors.push('El texto no puede empezar con una variable (regla de Meta).');
  }
  if (/\}\}[\s.!?¿¡,;:]*$/.test(body)) {
    errors.push('El texto no puede terminar con una variable (regla de Meta).');
  }
  if (/\}\}\s*\{\{/.test(body)) {
    errors.push('Dos variables no pueden ir seguidas.');
  }
  for (const v of extractVariables(body)) {
    if (!known.has(v)) errors.push(`Variable desconocida: {{${v}}}.`);
  }
  if ((t.footer || '').length > 60) {
    errors.push('El pie no puede pasar de 60 caracteres.');
  }
  if (/\{\{/.test(t.footer || '')) {
    errors.push('El pie no puede tener variables.');
  }

  const buttons = t.buttons || [];
  if (buttons.length > 10) errors.push('Máximo 10 botones.');
  if (buttons.filter((b) => b.type === 'URL').length > 2) {
    errors.push('Máximo 2 botones de enlace.');
  }
  for (const b of buttons) {
    if (!b.text?.trim()) errors.push('Hay un botón sin texto.');
    else if (b.text.length > 25) {
      errors.push(`El botón "${b.text}" supera 25 caracteres.`);
    }
    if (b.type === 'QUICK_REPLY' && !b.action) {
      errors.push(`El botón "${b.text}" no tiene acción.`);
    }
  }
  // Meta exige agrupar las respuestas rápidas y los enlaces: el tipo solo
  // puede cambiar una vez a lo largo de la lista
  const changes = buttons.filter(
    (b, i) => i > 0 && b.type !== buttons[i - 1].type,
  ).length;
  if (changes > 1) {
    errors.push(
      'Los botones de respuesta y los de enlace deben ir agrupados (primero unos, luego los otros).',
    );
  }
  return errors;
}

const exampleOf = (key: string) =>
  GENON_VARIABLES.find((v) => v.key === key)?.example || 'ejemplo';

/**
 * Plantilla en el formato de la API de Meta. Los botones de enlace apuntan a
 * `${baseUrl}/organization/{{1}}`: el envío completa el resto
 * (org/activitydetail/id o org/course/id).
 */
export function buildMetaTemplate(
  t: {
    body: string;
    footer?: string;
    buttons?: GenOnTemplateButton[];
    language: string;
    category: string;
  },
  metaName: string,
  baseUrl: string,
): {
  payload: {
    name: string;
    language: string;
    category: string;
    components: any[];
  };
  variables: string[];
} {
  const { text, variables } = toPositional(t.body);
  const components: any[] = [
    {
      type: 'BODY',
      text,
      ...(variables.length
        ? { example: { body_text: [variables.map(exampleOf)] } }
        : {}),
    },
  ];
  if (t.footer?.trim()) {
    components.push({ type: 'FOOTER', text: t.footer.trim() });
  }
  const buttons = (t.buttons || []).map((b) =>
    b.type === 'URL'
      ? {
          type: 'URL',
          text: b.text,
          url: `${baseUrl.replace(/\/+$/, '')}/organization/{{1}}`,
          example: [
            `${baseUrl.replace(/\/+$/, '')}/organization/64f0c0ffee/course/64f0c0ffee`,
          ],
        }
      : { type: 'QUICK_REPLY', text: b.text },
  );
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });

  return {
    payload: {
      name: metaName,
      language: t.language || 'es',
      category: t.category || 'UTILITY',
      components,
    },
    variables,
  };
}

/**
 * Componentes de un envío: valores del cuerpo en el orden de la plantilla,
 * sufijo de los botones de enlace y payload de las respuestas rápidas.
 * Lanza si falta el valor de alguna variable.
 */
export function buildSendComponents(params: {
  variables: string[];
  values: Record<string, string | number | null | undefined>;
  buttons: GenOnTemplateButton[];
  urlSuffix: string;
  payloadFor: (button: GenOnTemplateButton, index: number) => string;
}): any[] {
  const missing = params.variables.filter((v) => {
    const value = params.values[v];
    return value === null || value === undefined || value === '';
  });
  if (missing.length) {
    throw new Error(`Faltan datos para: ${missing.join(', ')}`);
  }
  const components: any[] = [];
  if (params.variables.length) {
    components.push({
      type: 'body',
      parameters: params.variables.map((v) => ({
        type: 'text',
        text: sanitizeParam(params.values[v]),
      })),
    });
  }
  params.buttons.forEach((b, i) => {
    if (b.type === 'URL') {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(i),
        parameters: [{ type: 'text', text: params.urlSuffix }],
      });
    } else {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(i),
        parameters: [{ type: 'payload', payload: params.payloadFor(b, i) }],
      });
    }
  });
  return components;
}
