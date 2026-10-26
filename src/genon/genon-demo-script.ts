import { GenOnSegment, GenOnTriggerKey } from './schemas/genon-program.schema';

/**
 * Guion de la demostración de Gen.ON: etapas que cada participante vive con
 * su usuario ficticio, en orden. Cada etapa deja los datos del curso en una
 * situación (abandono, inactivo, racha…) y sus pasos son los mensajes que el
 * presentador envía, con lo que explica y lo que se espera del grupo.
 */

export type DemoStageKey =
  | 'abandon'
  | 'inactive'
  | 'active'
  | 'recovery'
  | 'exam'
  | 'graduated';

export interface DemoStep {
  /** "<etapa>:<clave>", p. ej. "abandon:1.1" o "active:streak_risk" */
  id: string;
  /** step: toque de la secuencia · trigger: disparador */
  kind: 'step' | 'trigger';
  key: string;
  title: string;
  /** Qué explica el presentador */
  explain: string;
  /** Qué se espera que hagan los participantes */
  expect: string;
}

export interface DemoStage {
  key: DemoStageKey;
  title: string;
  /** Cómo quedan los datos de cada participante al preparar la etapa */
  situation: string;
  /** Qué detecta Gen.ON en esa situación */
  explain: string;
  /** Segmento en que debe quedar cada participante */
  segment: GenOnSegment;
  steps: DemoStep[];
}

const step = (
  stage: DemoStageKey,
  kind: DemoStep['kind'],
  key: string,
  title: string,
  explain: string,
  expect: string,
): DemoStep => ({ id: `${stage}:${key}`, kind, key, title, explain, expect });

export const DEMO_STAGES: DemoStage[] = [
  {
    key: 'abandon',
    title: '1. Recuperación de abandono',
    situation: 'Inscrito hace 10 días sin haber terminado ninguna actividad.',
    explain:
      'Gen.ON clasifica a los inscritos cada día. Quien lleva 7 días o más inscrito sin completar nada entra al segmento de abandono y recibe 4 toques en 14 días (días 0, 3, 7 y 14), en su franja de envío y con un tope de 2 mensajes por semana.',
    segment: 'abandon',
    steps: [
      step(
        'abandon',
        'step',
        '1.1',
        'Pregunta de abandono',
        'Día 0. En vez de un recordatorio genérico, preguntamos qué pasó. Cada botón tiene su respuesta: "No he tenido tiempo" ofrece el reto corto, "Problemas para ingresar" manda un acceso directo y abre un caso de soporte, y "No era lo que esperaba" pide un comentario para el equipo académico y saca a la persona del flujo. El motivo queda registrado.',
        'Que cada uno toque un botón distinto para ver las respuestas.',
      ),
      step(
        'abandon',
        'step',
        '1.2',
        'Mensaje social',
        'Día 3. Norma social: cuántos colegas terminaron el curso o avanzaron esta semana. En producción solo sale si el dato llega al mínimo (20); con un dato bajo se omite para no normalizar el abandono. En la demostración sale con los datos del curso de prueba.',
        'Solo leer. El botón abre el curso.',
      ),
      step(
        'abandon',
        'step',
        '1.3',
        'Reto de conocimiento',
        'Día 7. Proponemos completar la primera actividad respondiendo preguntas por WhatsApp. Si las acierta todas, la actividad queda terminada y la persona pasa a activos. Si falla, cada respuesta incorrecta trae el enlace al minuto exacto del video donde está la respuesta.',
        'Tocar "Acepto el reto" y responder las preguntas.',
      ),
      step(
        'abandon',
        'step',
        '1.4',
        'Cierre',
        'Día 14. Sin respuesta, avisamos que pausamos los mensajes: la inscripción sigue activa y no insistimos indefinidamente.',
        'Solo leer.',
      ),
    ],
  },
  {
    key: 'inactive',
    title: '2. Reactivación de inactivos',
    situation: 'Terminó las primeras actividades hace 20 días o más y no ha vuelto.',
    explain:
      'Quien ya avanzó pero lleva más de 15 días sin actividad entra a reactivación, con su propia secuencia de 4 toques que parte de lo que ya hizo.',
    segment: 'inactive',
    steps: [
      step(
        'inactive',
        'step',
        '2.1',
        'Motivación',
        'Día 0. Reporte de su avance y la actividad pendiente con su duración estimada: volver cuesta menos si sabe exactamente qué sigue.',
        'Solo leer. El botón lo lleva a donde quedó.',
      ),
      step(
        'inactive',
        'step',
        '2.2',
        'Mensaje social',
        'Día 3. Qué porcentaje de quienes llegaron a su mismo punto terminó el curso (o cuántos de su cohorte avanzaron en dos semanas).',
        'Solo leer.',
      ),
      step(
        'inactive',
        'step',
        '2.3',
        'Reto de la actividad pendiente',
        'Día 7. Reto sobre la actividad en la que quedó: aprobarlo la registra como completada y la persona vuelve a activos.',
        'Tocar "Acepto el reto" y responder.',
      ),
      step(
        'inactive',
        'step',
        '2.4',
        'Cierre',
        'Día 14. Pausamos las alertas y confirmamos que su avance quedó guardado.',
        'Solo leer.',
      ),
    ],
  },
  {
    key: 'active',
    title: '3. Acompañamiento de activos',
    situation: 'Estudió los últimos días seguidos (hasta ayer) y terminó el primer módulo.',
    explain:
      'A los activos no se les manda una secuencia: los mensajes se disparan por lo que hacen. Si coinciden varios, sale uno por franja según la prioridad del programa y el tope semanal frena el resto.',
    segment: 'active',
    steps: [
      step(
        'active',
        'trigger',
        'module_completed',
        'Módulo terminado',
        'Al completar todas las actividades de un módulo: confirma el avance total y anticipa el siguiente módulo.',
        'Solo leer.',
      ),
      step(
        'active',
        'trigger',
        'streak_milestone',
        'Reconocimiento de racha',
        'Al cumplir 3, 7, 14 o 30 días seguidos. Solo cuenta la actividad académica: completar una actividad o superar un reto. Abrir la app o leer un mensaje no cuenta.',
        'Solo leer.',
      ),
      step(
        'active',
        'trigger',
        'streak_risk',
        'Racha en riesgo',
        'A las 19:00, si alguien con racha de 3 días o más aún no ha estudiado hoy. Ofrece un reto corto para no perderla; sale máximo una vez por semana y se cancela si estudia antes.',
        'Tocar "Hacer un reto": superarlo cuenta como el estudio del día.',
      ),
      step(
        'active',
        'trigger',
        'video_challenge',
        'Reto del video',
        'Si la siguiente actividad es un video marcado como saltable, puede acreditarlo respondiendo una pregunta en lugar de verlo completo.',
        'Responder la pregunta o elegir ver el video.',
      ),
      step(
        'active',
        'trigger',
        'weekly_social',
        'Comparación semanal',
        'Los lunes. Si va por encima de la mitad de su cohorte, recibe su percentil; si va por debajo, se compara consigo mismo y con su próximo hito. En la demostración el percentil es un dato de ejemplo: la comparación real necesita al menos 20 activos en el curso.',
        'Solo leer.',
      ),
    ],
  },
  {
    key: 'recovery',
    title: '4. Racha cortada',
    situation: 'Estudió 3 días seguidos, pero ayer no entró: la racha se cortó.',
    explain:
      'En vez de reiniciar la racha en cero, Gen.ON ofrece recuperarla con un reto de repaso sobre lo último que estudió. El repaso no cambia el avance del curso.',
    segment: 'active',
    steps: [
      step(
        'recovery',
        'trigger',
        'streak_recovery',
        'Recuperación de racha',
        'Si aprueba el reto de repaso, los días sin estudio quedan "puenteados" y la racha continúa.',
        'Tocar "Recuperar mi racha" y aprobar el reto.',
      ),
    ],
  },
  {
    key: 'exam',
    title: '5. Examen pendiente',
    situation: 'Terminó las actividades del primer módulo hace 3 días y no presentó su examen.',
    explain:
      'Aplica a cualquier segmento salvo egresados: 2 días después de terminar las actividades de un módulo sin presentar su examen, se le recuerda que es requisito para el certificado.',
    segment: 'active',
    steps: [
      step(
        'exam',
        'trigger',
        'exam_reminder',
        'Recordatorio de examen',
        'El botón lleva directo al examen del módulo.',
        'Solo leer.',
      ),
    ],
  },
  {
    key: 'graduated',
    title: '6. Certificado',
    situation: 'Terminó todo el curso y aprobó los exámenes, pero no ha descargado el certificado.',
    explain:
      'Cuando cumple las reglas del certificado del curso (actividades y exámenes aprobados) y aún no lo descarga, se le avisa que está listo.',
    segment: 'graduated',
    steps: [
      step(
        'graduated',
        'trigger',
        'certificate',
        'Certificado listo',
        'Cierra el recorrido: el botón lleva a descargar el certificado.',
        'Solo leer.',
      ),
    ],
  },
];

export function findDemoStage(key: string): DemoStage | null {
  return DEMO_STAGES.find((s) => s.key === key) || null;
}

export function findDemoStep(id: string): { stage: DemoStage; step: DemoStep } | null {
  for (const stage of DEMO_STAGES) {
    const found = stage.steps.find((s) => s.id === id);
    if (found) return { stage, step: found };
  }
  return null;
}

export function triggerKeyOf(step: DemoStep): GenOnTriggerKey | null {
  return step.kind === 'trigger' ? (step.key as GenOnTriggerKey) : null;
}

/** Datos del curso que necesita un escenario. */
export interface DemoCourseShape {
  activityCount: number;
  /** Actividades del primer módulo */
  firstModuleSize: number;
}

/** Situación de los datos de un participante en una etapa. */
export interface DemoScenario {
  enrolledDaysAgo: number;
  /** Actividades terminadas (posición en el orden del curso) y hace cuántos días */
  completed: { index: number; daysAgo: number }[];
  /** Aprobó todos los exámenes del curso */
  passExams: boolean;
}

/** Las primeras `count` actividades, la última hace `lastDaysAgo` días y cada anterior un día antes. */
function consecutive(count: number, lastDaysAgo: number) {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    daysAgo: lastDaysAgo + (count - 1 - i),
  }));
}

/**
 * Escenario de una etapa. Nunca completa todas las actividades salvo al
 * egresar: con el 100 % la persona pasa a egresados y, p. ej., el
 * recordatorio de examen ya no le aplica.
 */
export function scenarioFor(stage: DemoStageKey, course: DemoCourseShape): DemoScenario {
  const total = Math.max(course.activityCount, 1);
  const short = (n: number) => Math.max(1, Math.min(n, total - 1));
  const firstModule = short(course.firstModuleSize || 1);
  switch (stage) {
    case 'abandon':
      return { enrolledDaysAgo: 10, completed: [], passExams: false };
    case 'inactive':
      // Más del 5 % de avance y más de 15 días sin actividad
      return {
        enrolledDaysAgo: 60,
        completed: Array.from({ length: short(2) }, (_, i) => ({ index: i, daysAgo: 24 - 4 * i })),
        passExams: false,
      };
    case 'active': {
      // Racha de al menos 3 días que termina ayer y el primer módulo completo
      const n = short(Math.max(3, firstModule));
      return { enrolledDaysAgo: 15, completed: consecutive(n, 1), passExams: false };
    }
    case 'recovery':
      // 3 días seguidos hasta antes de ayer: ayer sin estudio, racha cortada
      return { enrolledDaysAgo: 20, completed: consecutive(short(3), 2), passExams: false };
    case 'exam':
      return { enrolledDaysAgo: 30, completed: consecutive(firstModule, 3), passExams: false };
    case 'graduated':
      return {
        enrolledDaysAgo: 50,
        completed: Array.from({ length: total }, (_, i) => ({
          index: i,
          daysAgo: 12 + 3 * (total - 1 - i),
        })),
        passExams: true,
      };
  }
}
