import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UsersService } from 'src/users/users.service';
import { Organization } from 'src/organizations/schemas/organization.schema';
import { OrganizationUser } from 'src/organization-users/schemas/organization-user.schema';
import { GenOnProgram } from './schemas/genon-program.schema';
import { GenOnEnrollment } from './schemas/genon-enrollment.schema';
import { defaultProgram, withTriggerDefaults } from './genon-defaults';

const ADMIN_ROLES = [/^admin$/i, /^owner$/i, /^super_admin$/i];
const MANAGED_CACHE_MS = 60 * 1000;

// Campos que el admin puede cambiar (el resto los maneja el motor)
const EDITABLE = [
  'name',
  'mode',
  'organization_ids',
  'event_ids',
  'timezone',
  'send_slots',
  'blocked_weekdays',
  'weekly_cap',
  'social_min',
  'default_activity_minutes',
  'holdout_percent',
  'segments',
  'flows',
  'replies',
  'challenge',
  'courses',
  'triggers',
] as const;

/**
 * Programas Gen.ON y quién puede verlos: un programa solo lo administra quien
 * es admin de todas sus organizaciones (mismo criterio que OrgAdminGuard).
 */
@Injectable()
export class GenOnProgramsService {
  private managedCache: { at: number; ids: Set<string> } | null = null;

  constructor(
    @InjectModel(GenOnProgram.name)
    private readonly programModel: Model<GenOnProgram>,
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<Organization>,
    @InjectModel(OrganizationUser.name)
    private readonly organizationUserModel: Model<OrganizationUser>,
    private readonly usersService: UsersService,
  ) {}

  /** Organizaciones que administra el usuario (autor o rol admin). */
  async adminOrganizationIds(uid: string): Promise<Set<string>> {
    const user = await this.usersService.findByFirebaseUid(uid);
    const userIds: any[] = [String(user._id)];
    if (Types.ObjectId.isValid(String(user._id))) {
      userIds.push(new Types.ObjectId(String(user._id)));
    }
    const [authored, memberships] = await Promise.all([
      this.organizationModel
        .find({ author: { $in: userIds } })
        .select('_id')
        .lean()
        .exec(),
      this.organizationUserModel
        .find({ user_id: { $in: userIds }, rol_id: { $in: ADMIN_ROLES } })
        .select('organization_id')
        .lean()
        .exec(),
    ]);
    return new Set([
      ...authored.map((o) => String(o._id)),
      ...memberships.map((m) => String(m.organization_id)),
    ]);
  }

  async list(uid: string) {
    const admin = await this.adminOrganizationIds(uid);
    const programs = await this.programModel
      .find()
      .sort({ created_at: -1 })
      .lean()
      .exec();
    return programs
      .filter((p) => this.canManage(p, admin))
      .map((p) => ({ ...p, triggers: withTriggerDefaults(p.triggers) }));
  }

  async get(uid: string, id: string): Promise<GenOnProgram> {
    const program = await this.findById(id);
    const admin = await this.adminOrganizationIds(uid);
    if (!this.canManage(program, admin)) {
      throw new ForbiddenException(
        'Necesitas ser administrador de todas las organizaciones del programa',
      );
    }
    // Programas anteriores a la fase 2: disparadores con valores por defecto
    program.triggers = withTriggerDefaults(program.triggers);
    return program;
  }

  async findById(id: string): Promise<GenOnProgram> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Programa no encontrado');
    }
    const program = await this.programModel.findById(id).exec();
    if (!program) throw new NotFoundException('Programa no encontrado');
    return program;
  }

  async create(uid: string, body: Record<string, any>) {
    const admin = await this.adminOrganizationIds(uid);
    const data: Record<string, any> = {
      ...defaultProgram(),
      organization_ids: [],
      ...this.pick(body),
      mode: 'off',
    };
    if (!String(data.name || '').trim()) {
      throw new BadRequestException('El programa necesita un nombre');
    }
    this.assertOrganizations(data.organization_ids, admin);
    const user = await this.usersService.findByFirebaseUid(uid);
    return this.programModel.create({ ...data, created_by: String(user._id) });
  }

  async update(uid: string, id: string, body: Record<string, any>) {
    const program = await this.get(uid, id);
    const admin = await this.adminOrganizationIds(uid);
    const changes = this.pick(body);
    if (changes.organization_ids) {
      this.assertOrganizations(changes.organization_ids, admin);
    }
    const next = { ...program.toObject(), ...changes };
    if (next.mode !== 'off') {
      await this.assertNoOverlap(id, next.organization_ids, next.event_ids);
    }
    // Reglas o secuencias nuevas: se recalcula todo en la próxima ejecución
    const resegment = ['segments', 'flows', 'event_ids', 'organization_ids'].some(
      (k) => k in changes,
    );
    const goingLive = changes.mode === 'live' && program.mode !== 'live';
    Object.assign(program, changes);
    if (resegment || goingLive) program.last_segmented_on = null;
    await program.save();
    if (goingLive) {
      // Lo que avanzó la simulación no se envió de verdad: las secuencias
      // empiezan de cero al activar el programa
      await this.enrollmentModel
        .deleteMany({ program_id: String(program._id), test: false })
        .exec();
    }
    this.managedCache = null;
    return program;
  }

  async remove(uid: string, id: string) {
    const program = await this.get(uid, id);
    await program.deleteOne();
    this.managedCache = null;
    return { deleted: true };
  }

  /**
   * Organizaciones de programas activos: ahí los recordatorios anteriores
   * (inactividad, reporte semanal, ranking) dejan de enviarse.
   */
  async managedOrganizationIds(): Promise<Set<string>> {
    const now = Date.now();
    if (this.managedCache && now - this.managedCache.at < MANAGED_CACHE_MS) {
      return this.managedCache.ids;
    }
    const programs = await this.programModel
      .find({ mode: 'live' })
      .select('organization_ids')
      .lean()
      .exec();
    const ids = new Set(programs.flatMap((p) => p.organization_ids.map(String)));
    this.managedCache = { at: now, ids };
    return ids;
  }

  private canManage(
    program: { organization_ids: string[] },
    admin: Set<string>,
  ): boolean {
    if (!program.organization_ids?.length) return true;
    return program.organization_ids.every((id) => admin.has(String(id)));
  }

  private assertOrganizations(ids: unknown, admin: Set<string>) {
    if (!Array.isArray(ids)) {
      throw new BadRequestException('"organization_ids" debe ser un arreglo');
    }
    const foreign = ids.filter((id) => !admin.has(String(id)));
    if (foreign.length) {
      throw new ForbiddenException(
        'Solo puedes incluir organizaciones que administras',
      );
    }
  }

  /** Un mismo curso no puede estar en dos programas encendidos. */
  private async assertNoOverlap(
    id: string,
    organizationIds: string[],
    eventIds: string[],
  ) {
    const others = await this.programModel
      .find({
        _id: { $ne: new Types.ObjectId(id) },
        mode: { $ne: 'off' },
        organization_ids: { $in: organizationIds },
      })
      .select('name organization_ids event_ids')
      .lean()
      .exec();
    for (const other of others) {
      const bothAll = !eventIds.length || !other.event_ids.length;
      const shared = eventIds.some((e) => other.event_ids.includes(e));
      if (bothAll || shared) {
        throw new BadRequestException(
          `Hay cursos que ya están en el programa encendido "${other.name}". Apágalo o separa los cursos.`,
        );
      }
    }
  }

  private pick(body: Record<string, any>) {
    const out: Record<string, any> = {};
    for (const key of EDITABLE) {
      if (body?.[key] !== undefined) out[key] = body[key];
    }
    if (out.mode && !['off', 'dry_run', 'live'].includes(out.mode)) {
      throw new BadRequestException('"mode" debe ser off, dry_run o live');
    }
    if (out.organization_ids) {
      out.organization_ids = out.organization_ids.map(String);
    }
    if (out.event_ids) out.event_ids = out.event_ids.map(String);
    return out;
  }
}
