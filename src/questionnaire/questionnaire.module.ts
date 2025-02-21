import { Module } from '@nestjs/common';
import { QuestionnaireService } from './questionnaire.service';
import { QuestionnaireController } from './questionnaire.controller';

@Module({
  providers: [QuestionnaireService],
  controllers: [QuestionnaireController],
})
export class QuestionnaireModule {}
