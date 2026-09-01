import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { EventMetricsService } from './event-metrics.service';
import admin from '../firebase-admin';
import { Event } from '../events/schemas/event.schema';
import { CourseAttendee } from '../course-attendee/schemas/course-attendee.schema';
import { ActivityAttendee } from '../activity-attendee/schemas/activity-attendee.schema';
import { Activity } from '../activities/schemas/activity.schema';
import { UserActivity } from '../user-activity/schemas/user-activity.schema';
import { Quiz } from '../quiz/schemas/quiz.schema';
import { UserQuizAttempt } from '../user-quiz-attempt/schemas/user-quiz-attempt.schema';
import { Certificate } from '../certificates/schemas/certificate.schema';
import { User } from '../users/schemas/user.schema';
import { OrganizationUser } from '../organization-users/schemas/organization-user.schema';

jest.mock('../firebase-admin', () => ({
  __esModule: true,
  default: { auth: jest.fn() },
}));
const mockAuth = admin.auth as unknown as jest.Mock;

const EVENT_ID = '507f1f77bcf86cd799439011';
const ORG_ID = '507f191e810c19729de860ea';
const OTHER_ORG_ID = '507f191e810c19729de860ff';
const USER_ID_1 = '507f191e810c19729de860eb';
const USER_ID_2 = '507f191e810c19729de860fc';
const ACTIVITY_ID_1 = '507f191e810c19729de860ec';
const MODULE_ID_1 = '507f191e810c19729de860ed';
const QUIZ_ID = '507f191e810c19729de860ee';

/** Mock de un Model<T> de Mongoose cubriendo los métodos que usa el servicio. */
function createModelMock() {
  const execMock = jest.fn().mockResolvedValue(null);
  const toArrayMock = jest.fn().mockResolvedValue([]);
  return {
    aggregate: jest.fn().mockResolvedValue([]),
    findById: jest.fn(() => ({ exec: execMock })),
    findOne: jest.fn(() => ({
      select: () => ({ exec: execMock }),
      exec: execMock,
    })),
    collection: { find: jest.fn(() => ({ toArray: toArrayMock })) },
    __exec: execMock,
    __toArray: toArrayMock,
  };
}

describe('EventMetricsService', () => {
  let service: EventMetricsService;
  let models: Record<string, ReturnType<typeof createModelMock>>;

  beforeEach(async () => {
    models = {
      event: createModelMock(),
      courseAttendee: createModelMock(),
      activityAttendee: createModelMock(),
      activity: createModelMock(),
      module: createModelMock(),
      userActivity: createModelMock(),
      quiz: createModelMock(),
      attempt: createModelMock(),
      certificate: createModelMock(),
      user: createModelMock(),
      organizationUser: createModelMock(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventMetricsService,
        { provide: getModelToken(Event.name), useValue: models.event },
        {
          provide: getModelToken(CourseAttendee.name),
          useValue: models.courseAttendee,
        },
        {
          provide: getModelToken(ActivityAttendee.name),
          useValue: models.activityAttendee,
        },
        { provide: getModelToken(Activity.name), useValue: models.activity },
        { provide: getModelToken('Module'), useValue: models.module },
        {
          provide: getModelToken(UserActivity.name),
          useValue: models.userActivity,
        },
        { provide: getModelToken(Quiz.name), useValue: models.quiz },
        {
          provide: getModelToken(UserQuizAttempt.name),
          useValue: models.attempt,
        },
        {
          provide: getModelToken(Certificate.name),
          useValue: models.certificate,
        },
        { provide: getModelToken(User.name), useValue: models.user },
        {
          provide: getModelToken(OrganizationUser.name),
          useValue: models.organizationUser,
        },
      ],
    }).compile();

    service = module.get<EventMetricsService>(EventMetricsService);
    jest.clearAllMocks();
    // Se limpian de nuevo después de compile() porque instanciar el módulo
    // no invoca ninguno de estos mocks, pero jest.clearAllMocks() ya alcanza.
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── getCached ──────────────────────────────────────────────────────────

  describe('getCached', () => {
    it('memoiza el resultado mientras no expire el TTL', async () => {
      const factory = jest.fn().mockResolvedValue('valor');
      const svc: any = service;

      expect(await svc.getCached('k1', factory)).toBe('valor');
      expect(await svc.getCached('k1', factory)).toBe('valor');
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('vuelve a invocar la factory una vez expirado el TTL', async () => {
      const factory = jest.fn().mockResolvedValue('valor');
      const svc: any = service;

      await svc.getCached('k2', factory);
      svc.cache.set('k2', { data: 'stale', expiresAt: Date.now() - 1 });
      await svc.getCached('k2', factory);

      expect(factory).toHaveBeenCalledTimes(2);
    });
  });

  // ── getEventMetrics (validación de organización + caché) ───────────────

  describe('getEventMetrics', () => {
    it('lanza NotFoundException si el evento no existe', async () => {
      models.event.__exec.mockResolvedValueOnce(null);
      await expect(service.getEventMetrics(EVENT_ID, ORG_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lanza NotFoundException si el evento pertenece a otra organización', async () => {
      models.event.__exec.mockResolvedValue({
        _id: EVENT_ID,
        name: 'Curso X',
        organizer_id: OTHER_ORG_ID,
        datetime_from: new Date(),
        datetime_to: new Date(),
      });
      await expect(service.getEventMetrics(EVENT_ID, ORG_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('no repite las agregaciones dentro del TTL de caché', async () => {
      models.event.__exec.mockResolvedValue({
        _id: EVENT_ID,
        name: 'Curso X',
        organizer_id: ORG_ID,
        datetime_from: new Date(),
        datetime_to: new Date(),
      });

      await service.getEventMetrics(EVENT_ID, ORG_ID);
      const callsAfterFirst = models.courseAttendee.aggregate.mock.calls.length;
      await service.getEventMetrics(EVENT_ID, ORG_ID);

      // La segunda llamada sí vuelve a validar el evento (findById), pero no
      // debe volver a golpear las agregaciones cacheadas.
      expect(models.event.findById).toHaveBeenCalledTimes(2);
      expect(models.courseAttendee.aggregate.mock.calls.length).toBe(
        callsAfterFirst,
      );
    });
  });

  // ── getEnrollmentMetrics ─────────────────────────────────────────────

  describe('getEnrollmentMetrics', () => {
    it('calcula inProgress y avgProgress a partir de las agregaciones', async () => {
      models.courseAttendee.aggregate
        .mockResolvedValueOnce([
          { total: 10, completed: 3, notStarted: 2, avgProgress: 45.06 },
        ])
        .mockResolvedValueOnce([{ _id: '2026-01', count: 5 }]);

      const svc: any = service;
      const result = await svc.getEnrollmentMetrics([EVENT_ID]);

      expect(result).toEqual({
        total: 10,
        completed: 3,
        notStarted: 2,
        inProgress: 5,
        avgProgress: 45.1,
        byMonth: [{ month: '2026-01', count: 5 }],
      });
    });

    it('devuelve ceros cuando no hay inscripciones', async () => {
      models.courseAttendee.aggregate
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const svc: any = service;
      const result = await svc.getEnrollmentMetrics([EVENT_ID]);

      expect(result.total).toBe(0);
      expect(result.inProgress).toBe(0);
      expect(result.byMonth).toEqual([]);
    });
  });

  // ── getActivityMetrics ───────────────────────────────────────────────

  describe('getActivityMetrics', () => {
    it('combina asistencia y tiempo por actividad, ordenado por módulo', async () => {
      models.activity.__toArray.mockResolvedValueOnce([
        { _id: ACTIVITY_ID_1, name: 'Actividad 1', module_id: MODULE_ID_1 },
      ]);
      models.module.__toArray.mockResolvedValueOnce([
        { _id: MODULE_ID_1, module_name: 'Módulo 1', order: 1 },
      ]);
      models.activityAttendee.aggregate.mockResolvedValueOnce([
        { _id: ACTIVITY_ID_1, attendees: 8, completed: 4, avgProgress: 62.3 },
      ]);
      models.userActivity.aggregate.mockResolvedValueOnce([
        { _id: ACTIVITY_ID_1, totalMs: 120000, usersWithTime: 6 },
      ]);

      const svc: any = service;
      const result = await svc.getActivityMetrics([EVENT_ID]);

      expect(result).toEqual([
        {
          activityId: ACTIVITY_ID_1,
          name: 'Actividad 1',
          moduleId: MODULE_ID_1,
          moduleName: 'Módulo 1',
          moduleOrder: 1,
          attendees: 8,
          completed: 4,
          avgProgress: 62.3,
          totalTimeMs: 120000,
          usersWithTime: 6,
        },
      ]);
    });

    it('devuelve una actividad sin stats como vacía en vez de fallar', async () => {
      models.activity.__toArray.mockResolvedValueOnce([
        { _id: ACTIVITY_ID_1, name: 'Sin inscritos', module_id: null },
      ]);
      models.module.__toArray.mockResolvedValueOnce([]);
      models.activityAttendee.aggregate.mockResolvedValueOnce([]);
      models.userActivity.aggregate.mockResolvedValueOnce([]);

      const svc: any = service;
      const [result] = await svc.getActivityMetrics([EVENT_ID]);

      expect(result.attendees).toBe(0);
      expect(result.completed).toBe(0);
      expect(result.totalTimeMs).toBe(0);
    });
  });

  // ── getQuizMetrics ───────────────────────────────────────────────────

  describe('getQuizMetrics', () => {
    it('devuelve exists:false cuando el evento no tiene examen', async () => {
      models.quiz.__exec.mockResolvedValueOnce(null);

      const svc: any = service;
      const result = await svc.getQuizMetrics(new Types.ObjectId(EVENT_ID));

      expect(result.exists).toBe(false);
      expect(result.passingScore).toBeNull();
      expect(result.totalAttempts).toBe(0);
    });

    it('calcula passedUsers solo cuando hay nota mínima configurada', async () => {
      models.quiz.__exec.mockResolvedValueOnce({
        _id: QUIZ_ID,
        config: { nota: 70 },
      });
      models.attempt.aggregate.mockResolvedValueOnce([
        {
          totalAttempts: 12,
          uniqueUsers: 5,
          graded: 10,
          pending: 1,
          review: 1,
          gradedUsers: 5,
          avgBestScore: 81.25,
          passedUsers: 4,
        },
      ]);

      const svc: any = service;
      const result = await svc.getQuizMetrics(new Types.ObjectId(EVENT_ID));

      expect(result.exists).toBe(true);
      expect(result.passingScore).toBe(70);
      expect(result.passedUsers).toBe(4);
      expect(result.avgBestScore).toBe(81.3);
    });

    it('deja passedUsers en null si no hay nota mínima configurada', async () => {
      models.quiz.__exec.mockResolvedValueOnce({
        _id: QUIZ_ID,
        config: { nota: null },
      });
      models.attempt.aggregate.mockResolvedValueOnce([
        {
          totalAttempts: 3,
          uniqueUsers: 2,
          graded: 2,
          pending: 1,
          review: 0,
          gradedUsers: 2,
          avgBestScore: 50,
          passedUsers: 0,
        },
      ]);

      const svc: any = service;
      const result = await svc.getQuizMetrics(new Types.ObjectId(EVENT_ID));

      expect(result.passedUsers).toBeNull();
    });
  });

  // ── getCertificateMetrics ────────────────────────────────────────────

  describe('getCertificateMetrics', () => {
    it('cuenta certificados por estado', async () => {
      models.certificate.aggregate.mockResolvedValueOnce([
        { _id: 'COMPLETED', count: 7 },
        { _id: 'PENDING', count: 2 },
        { _id: 'FAILED', count: 1 },
      ]);

      const svc: any = service;
      const result = await svc.getCertificateMetrics([EVENT_ID]);

      expect(result).toEqual({
        total: 10,
        completed: 7,
        pending: 2,
        failed: 1,
      });
    });
  });

  // ── paginateMembers ──────────────────────────────────────────────────

  describe('paginateMembers', () => {
    const activityMeta = [
      {
        activityId: ACTIVITY_ID_1,
        name: 'A1',
        moduleName: null,
        moduleOrder: null,
      },
    ];
    const members = [
      {
        userId: USER_ID_1,
        name: 'Beta Usuario',
        email: 'beta@test.com',
        courseProgress: 40,
        status: 'in_progress' as const,
        enrolledAt: new Date('2026-01-02'),
        activities: [],
      },
      {
        userId: USER_ID_2,
        name: 'Alfa Usuario',
        email: 'alfa@test.com',
        courseProgress: 90,
        status: 'in_progress' as const,
        enrolledAt: new Date('2026-01-01'),
        activities: [],
      },
    ];

    it('filtra por nombre/email (case-insensitive)', () => {
      const svc: any = service;
      const result = svc.paginateMembers(activityMeta, members, {
        search: 'ALFA',
      });
      expect(result.members).toHaveLength(1);
      expect(result.members[0].userId).toBe(USER_ID_2);
      expect(result.total).toBe(1);
    });

    it('ordena por courseProgress descendente', () => {
      const svc: any = service;
      const result = svc.paginateMembers(activityMeta, members, {
        sortKey: 'courseProgress',
        sortDir: 'desc',
      });
      expect(result.members.map((m: any) => m.userId)).toEqual([
        USER_ID_2,
        USER_ID_1,
      ]);
    });

    it('pagina con page/pageSize y devuelve el total sin paginar', () => {
      const svc: any = service;
      const result = svc.paginateMembers(activityMeta, members, {
        page: 2,
        pageSize: 1,
        sortKey: 'name',
        sortDir: 'asc',
      });
      expect(result.members).toHaveLength(1);
      expect(result.total).toBe(2);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(1);
    });
  });

  // ── getEventMembers / resolveEventMembers ───────────────────────────

  describe('getEventMembers', () => {
    beforeEach(() => {
      models.event.__exec.mockResolvedValue({
        _id: EVENT_ID,
        organizer_id: ORG_ID,
      });
    });

    it('lanza NotFoundException si el evento pertenece a otra organización', async () => {
      models.event.__exec.mockResolvedValueOnce({
        _id: EVENT_ID,
        organizer_id: OTHER_ORG_ID,
      });
      await expect(service.getEventMembers(EVENT_ID, ORG_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('resuelve nombre desde organization-user y no llama a Firebase si ya hay nombre', async () => {
      models.courseAttendee.aggregate.mockResolvedValueOnce([
        { _id: USER_ID_1, progress: 55, enrolledAt: new Date('2026-01-01') },
      ]);
      models.activity.__toArray.mockResolvedValueOnce([
        { _id: ACTIVITY_ID_1, name: 'A1', module_id: null },
      ]);
      models.module.__toArray.mockResolvedValueOnce([]);
      models.activityAttendee.aggregate.mockResolvedValueOnce([
        { _id: { activity: ACTIVITY_ID_1, user: USER_ID_1 }, progress: 55 },
      ]);
      models.userActivity.aggregate.mockResolvedValueOnce([
        { _id: { activity: ACTIVITY_ID_1, user: USER_ID_1 }, timeMs: 3000 },
      ]);
      models.user.__toArray.mockResolvedValueOnce([]);
      models.organizationUser.__toArray.mockResolvedValueOnce([
        {
          user_id: USER_ID_1,
          organization_id: ORG_ID,
          properties: {
            nombres: 'Ana',
            apellidos: 'Pérez',
            email: 'ana@test.com',
          },
        },
      ]);

      const result = await service.getEventMembers(EVENT_ID, ORG_ID);

      expect(result.members).toHaveLength(1);
      expect(result.members[0]).toMatchObject({
        userId: USER_ID_1,
        name: 'Ana Pérez',
        email: 'ana@test.com',
        courseProgress: 55,
        status: 'in_progress',
      });
      expect(mockAuth).not.toHaveBeenCalled();
    });

    it('cae a Firebase Auth (batch) cuando no hay User ni organization-user', async () => {
      const getUsersMock = jest.fn().mockResolvedValue({
        users: [
          { uid: 'fb-uid-1', displayName: 'Recuperado', email: 'r@test.com' },
        ],
        notFound: [],
      });
      mockAuth.mockReturnValue({ getUsers: getUsersMock });

      models.courseAttendee.aggregate.mockResolvedValueOnce([
        { _id: USER_ID_1, progress: 0, enrolledAt: null },
      ]);
      models.activity.__toArray.mockResolvedValueOnce([]);
      models.module.__toArray.mockResolvedValueOnce([]);
      models.activityAttendee.aggregate.mockResolvedValueOnce([]);
      models.userActivity.aggregate.mockResolvedValueOnce([]);
      models.user.__toArray.mockResolvedValueOnce([]);
      models.organizationUser.__toArray.mockResolvedValueOnce([]);
      // Lookup de firebase_uid por user_id no resuelto.
      models.userActivity.__toArray.mockResolvedValueOnce([
        { user_id: USER_ID_1, firebase_uid: 'fb-uid-1' },
      ]);

      const result = await service.getEventMembers(EVENT_ID, ORG_ID);

      expect(getUsersMock).toHaveBeenCalledWith([{ uid: 'fb-uid-1' }]);
      expect(result.members[0].name).toBe('Recuperado');
      expect(result.members[0].email).toBe('r@test.com');
    });

    it('etiqueta "Cuenta eliminada" cuando ni User, ni org-user, ni Firebase resuelven', async () => {
      mockAuth.mockReturnValue({
        getUsers: jest.fn().mockResolvedValue({ users: [], notFound: [] }),
      });

      models.courseAttendee.aggregate.mockResolvedValueOnce([
        { _id: USER_ID_1, progress: 0, enrolledAt: null },
      ]);
      models.activity.__toArray.mockResolvedValueOnce([]);
      models.module.__toArray.mockResolvedValueOnce([]);
      models.activityAttendee.aggregate.mockResolvedValueOnce([]);
      models.userActivity.aggregate.mockResolvedValueOnce([]);
      models.user.__toArray.mockResolvedValueOnce([]);
      models.organizationUser.__toArray.mockResolvedValueOnce([]);
      models.userActivity.__toArray.mockResolvedValueOnce([]); // sin firebase_uid

      const result = await service.getEventMembers(EVENT_ID, ORG_ID);

      expect(result.members[0].name).toBe('Cuenta eliminada');
    });

    it('reutiliza la resolución cacheada al paginar/buscar/ordenar', async () => {
      models.courseAttendee.aggregate.mockResolvedValueOnce([
        { _id: USER_ID_1, progress: 10, enrolledAt: new Date('2026-01-01') },
        { _id: USER_ID_2, progress: 90, enrolledAt: new Date('2026-01-02') },
      ]);
      models.activity.__toArray.mockResolvedValueOnce([]);
      models.module.__toArray.mockResolvedValueOnce([]);
      models.activityAttendee.aggregate.mockResolvedValueOnce([]);
      models.userActivity.aggregate.mockResolvedValueOnce([]);
      models.user.__toArray.mockResolvedValueOnce([
        { _id: USER_ID_1, names: 'Uno', email: 'uno@test.com' },
        { _id: USER_ID_2, names: 'Dos', email: 'dos@test.com' },
      ]);
      models.organizationUser.__toArray.mockResolvedValueOnce([]);

      const first = await service.getEventMembers(EVENT_ID, ORG_ID, {
        page: 1,
        pageSize: 1,
      });
      expect(first.total).toBe(2);
      expect(first.members).toHaveLength(1);

      const callsAfterFirst = models.courseAttendee.aggregate.mock.calls.length;

      const second = await service.getEventMembers(EVENT_ID, ORG_ID, {
        page: 2,
        pageSize: 1,
        sortKey: 'courseProgress',
        sortDir: 'desc',
      });

      expect(models.courseAttendee.aggregate.mock.calls.length).toBe(
        callsAfterFirst,
      );
      expect(second.members).toHaveLength(1);
      expect(second.members[0].userId).toBe(USER_ID_1);
    });
  });
});
