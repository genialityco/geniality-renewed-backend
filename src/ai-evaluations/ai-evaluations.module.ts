import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MongooseModule } from '@nestjs/mongoose';
import { AiEvaluationsController } from './ai-evaluations.controller';
import { AiEvaluationsWebhookController } from './ai-evaluations-webhook.controller';
import { AiEvaluationsService } from './ai-evaluations.service';
import { AiEvaluationEngineService } from './ai-evaluation-engine.service';
import { CourseContentService } from './course-content.service';
import { GeminiTextClient } from './gemini-text.client';
import { ActivityQuestionsController } from './activity-questions.controller';
import { ActivityQuestionsService } from './activity-questions.service';
import { PracticeController } from './practice.controller';
import { PracticeEngineService } from './practice-engine.service';
import { PracticeSessionsService } from './practice-sessions.service';
import { WhatsappInboundService } from './whatsapp-inbound.service';
import { OrgAdminGuard } from '../auth/org-admin.guard';
import { WhatsappGatewayClient } from '../reminders/whatsapp-gateway.client';
import {
  AiEvaluationSession,
  AiEvaluationSessionSchema,
} from './schemas/ai-evaluation-session.schema';
import {
  AiEvaluationResult,
  AiEvaluationResultSchema,
} from './schemas/ai-evaluation-result.schema';
import {
  AiEvaluationContext,
  AiEvaluationContextSchema,
} from './schemas/ai-evaluation-context.schema';
import {
  ActivityQuestion,
  ActivityQuestionSchema,
} from './schemas/activity-question.schema';
import {
  PracticeSession,
  PracticeSessionSchema,
} from './schemas/practice-session.schema';
import {
  QuestionAttempt,
  QuestionAttemptSchema,
} from './schemas/question-attempt.schema';
import {
  WhatsappContact,
  WhatsappContactSchema,
} from './schemas/whatsapp-contact.schema';
import { Event, EventSchema } from '../events/schemas/event.schema';
import { ModuleSchema } from '../modules/schemas/module.schema';
import {
  Activity,
  ActivitySchema,
} from '../activities/schemas/activity.schema';
import {
  TranscriptSegment,
  TranscriptSegmentSchema,
} from '../transcript-segments/schemas/transcript-segment.schema';
import {
  Document as CourseDocument,
  DocumentSchema,
} from '../documents/schemas/document.schema';
import {
  CourseAttendee,
  CourseAttendeeSchema,
} from '../course-attendee/schemas/course-attendee.schema';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from '../organization-users/schemas/organization-user.schema';
import {
  ActivityAttendee,
  ActivityAttendeeSchema,
} from '../activity-attendee/schemas/activity-attendee.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    HttpModule,
    MongooseModule.forFeature([
      { name: AiEvaluationSession.name, schema: AiEvaluationSessionSchema },
      { name: AiEvaluationResult.name, schema: AiEvaluationResultSchema },
      { name: AiEvaluationContext.name, schema: AiEvaluationContextSchema },
      { name: ActivityQuestion.name, schema: ActivityQuestionSchema },
      { name: PracticeSession.name, schema: PracticeSessionSchema },
      { name: QuestionAttempt.name, schema: QuestionAttemptSchema },
      { name: WhatsappContact.name, schema: WhatsappContactSchema },
      { name: ActivityAttendee.name, schema: ActivityAttendeeSchema },
      // Organization: OrgAdminGuard y nombre de la organización en invitaciones
      { name: Organization.name, schema: OrganizationSchema },
      { name: User.name, schema: UserSchema },
      { name: Event.name, schema: EventSchema },
      { name: 'Module', schema: ModuleSchema },
      { name: Activity.name, schema: ActivitySchema },
      { name: TranscriptSegment.name, schema: TranscriptSegmentSchema },
      { name: CourseDocument.name, schema: DocumentSchema },
      { name: CourseAttendee.name, schema: CourseAttendeeSchema },
      // Para OrgMembershipGuard, sin importar OrganizationUsersModule que
      // arrastra el ciclo con PaymentPlansModule.
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
    ]),
    // Provee UsersService para SessionTokenGuard y OrgMembershipGuard.
    UsersModule,
  ],
  controllers: [
    AiEvaluationsController,
    AiEvaluationsWebhookController,
    ActivityQuestionsController,
    PracticeController,
  ],
  providers: [
    AiEvaluationsService,
    AiEvaluationEngineService,
    CourseContentService,
    GeminiTextClient,
    WhatsappGatewayClient,
    ActivityQuestionsService,
    WhatsappInboundService,
    PracticeEngineService,
    PracticeSessionsService,
    OrgAdminGuard,
  ],
})
export class AiEvaluationsModule {}
