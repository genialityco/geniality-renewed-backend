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
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    HttpModule,
    MongooseModule.forFeature([
      { name: AiEvaluationSession.name, schema: AiEvaluationSessionSchema },
      { name: AiEvaluationResult.name, schema: AiEvaluationResultSchema },
      { name: AiEvaluationContext.name, schema: AiEvaluationContextSchema },
      { name: ActivityQuestion.name, schema: ActivityQuestionSchema },
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
  ],
  providers: [
    AiEvaluationsService,
    AiEvaluationEngineService,
    CourseContentService,
    GeminiTextClient,
    WhatsappGatewayClient,
    ActivityQuestionsService,
  ],
})
export class AiEvaluationsModule {}
