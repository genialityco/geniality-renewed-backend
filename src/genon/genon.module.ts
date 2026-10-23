import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MongooseModule } from '@nestjs/mongoose';
import { GenOnProgram, GenOnProgramSchema } from './schemas/genon-program.schema';
import { GenOnTemplate, GenOnTemplateSchema } from './schemas/genon-template.schema';
import {
  GenOnEnrollment,
  GenOnEnrollmentSchema,
} from './schemas/genon-enrollment.schema';
import { GenOnFeedback, GenOnFeedbackSchema } from './schemas/genon-feedback.schema';
import { Event, EventSchema } from '../events/schemas/event.schema';
import { Activity, ActivitySchema } from '../activities/schemas/activity.schema';
import { ModuleSchema } from '../modules/schemas/module.schema';
import {
  ActivityAttendee,
  ActivityAttendeeSchema,
} from '../activity-attendee/schemas/activity-attendee.schema';
import {
  ActivityQuestion,
  ActivityQuestionSchema,
} from '../ai-evaluations/schemas/activity-question.schema';
import {
  TranscriptSegment,
  TranscriptSegmentSchema,
} from '../transcript-segments/schemas/transcript-segment.schema';
import {
  ProgressEvent,
  ProgressEventSchema,
} from '../progress-events/schemas/progress-event.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from '../organization-users/schemas/organization-user.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Quiz, QuizSchema } from '../quiz/schemas/quiz.schema';
import {
  UserQuizAttempt,
  UserQuizAttemptSchema,
} from '../user-quiz-attempt/schemas/user-quiz-attempt.schema';
import {
  Certificate,
  CertificateSchema,
} from '../certificates/schemas/certificate.schema';
import { UsersModule } from '../users/users.module';
import { AiEvaluationsModule } from '../ai-evaluations/ai-evaluations.module';
import { CourseSnapshotsModule } from '../course-snapshots/course-snapshots.module';
import { EngagementModule } from '../engagement/engagement.module';
import { ActivityAttendeeModule } from '../activity-attendee/activity-attendee.module';
import { GenOnProgramsService } from './genon-programs.service';
import { GenOnTemplatesService } from './genon-templates.service';
import { GenOnContextService } from './genon-context.service';
import { GenOnEngineService } from './genon-engine.service';
import { GenOnConversationService } from './genon-conversation.service';
import { GenOnTriggersService } from './genon-triggers.service';
import { GenOnHistoryService } from './genon-history.service';
import { GenOnController } from './genon.controller';
import { GenOnCron } from './genon.cron';

/**
 * Gen.ON Adherencia Educación: segmentos, secuencias de mensajes por
 * WhatsApp, retos de conocimiento y su administración. Depende de
 * ai-evaluations (entrada de WhatsApp y motor de simulacros) sin que
 * ai-evaluations dependa de él: registra sus manejadores al iniciar.
 */
@Module({
  imports: [
    HttpModule,
    MongooseModule.forFeature([
      { name: GenOnProgram.name, schema: GenOnProgramSchema },
      { name: GenOnTemplate.name, schema: GenOnTemplateSchema },
      { name: GenOnEnrollment.name, schema: GenOnEnrollmentSchema },
      { name: GenOnFeedback.name, schema: GenOnFeedbackSchema },
      { name: Event.name, schema: EventSchema },
      { name: Activity.name, schema: ActivitySchema },
      { name: 'Module', schema: ModuleSchema },
      { name: ActivityAttendee.name, schema: ActivityAttendeeSchema },
      { name: ActivityQuestion.name, schema: ActivityQuestionSchema },
      { name: TranscriptSegment.name, schema: TranscriptSegmentSchema },
      { name: ProgressEvent.name, schema: ProgressEventSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
      { name: User.name, schema: UserSchema },
      // Fase 2: recordatorio de examen y certificado
      { name: Quiz.name, schema: QuizSchema },
      { name: UserQuizAttempt.name, schema: UserQuizAttemptSchema },
      { name: Certificate.name, schema: CertificateSchema },
    ]),
    UsersModule,
    AiEvaluationsModule,
    CourseSnapshotsModule,
    EngagementModule,
    ActivityAttendeeModule,
  ],
  controllers: [GenOnController],
  providers: [
    GenOnProgramsService,
    GenOnTemplatesService,
    GenOnContextService,
    GenOnEngineService,
    GenOnTriggersService,
    GenOnConversationService,
    GenOnHistoryService,
    GenOnCron,
  ],
  // GenOnContextService: el asistente usa los cursos en orden y sus módulos
  exports: [GenOnProgramsService, GenOnContextService],
})
export class GenOnModule {}
