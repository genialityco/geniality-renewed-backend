import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AssistantConversation,
  AssistantConversationSchema,
} from './schemas/assistant-conversation.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from '../organization-users/schemas/organization-user.schema';
import { Event, EventSchema } from '../events/schemas/event.schema';
import { Activity, ActivitySchema } from '../activities/schemas/activity.schema';
import {
  CourseAttendee,
  CourseAttendeeSchema,
} from '../course-attendee/schemas/course-attendee.schema';
import {
  ActivityAttendee,
  ActivityAttendeeSchema,
} from '../activity-attendee/schemas/activity-attendee.schema';
import { Quiz, QuizSchema } from '../quiz/schemas/quiz.schema';
import {
  UserQuizAttempt,
  UserQuizAttemptSchema,
} from '../user-quiz-attempt/schemas/user-quiz-attempt.schema';
import { UsersModule } from '../users/users.module';
import { AiEvaluationsModule } from '../ai-evaluations/ai-evaluations.module';
import { EngagementModule } from '../engagement/engagement.module';
import { TranscriptSegmentsModule } from '../transcript-segments/transcript-segments.module';
import { GenOnModule } from '../genon/genon.module';
import { GeminiChatClient } from './gemini-chat.client';
import { AssistantToolsService } from './assistant-tools.service';
import { AssistantService } from './assistant.service';
import { AssistantController } from './assistant.controller';

/**
 * Asistente por WhatsApp para los miembros de las organizaciones que lo
 * habilitan: responde lo que ningún otro motor atendió, con herramientas de
 * solo lectura sobre sus cursos, avance y el contenido de los videos.
 */
import { AuthLinksModule } from 'src/auth-links/auth-links.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AssistantConversation.name, schema: AssistantConversationSchema },
      // Organization + OrganizationUser: configuración y OrgAdminGuard
      { name: Organization.name, schema: OrganizationSchema },
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
      { name: Event.name, schema: EventSchema },
      { name: Activity.name, schema: ActivitySchema },
      { name: CourseAttendee.name, schema: CourseAttendeeSchema },
      { name: ActivityAttendee.name, schema: ActivityAttendeeSchema },
      { name: Quiz.name, schema: QuizSchema },
      { name: UserQuizAttempt.name, schema: UserQuizAttemptSchema },
    ]),
    UsersModule,
    AiEvaluationsModule,
    EngagementModule,
    TranscriptSegmentsModule,
    GenOnModule,
    // Acceso directo en los enlaces de las respuestas
    AuthLinksModule,
  ],
  controllers: [AssistantController],
  providers: [GeminiChatClient, AssistantToolsService, AssistantService],
})
export class AssistantModule {}
