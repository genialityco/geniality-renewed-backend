import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class QuizAttempt extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Quiz', required: true })
  quiz_id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user_id: Types.ObjectId;

  // Número de intento (1,2,3...). Podrías usar un autoincremento o
  // sacarlo contando cuántos attempts existen para este quiz_id + user_id
  @Prop({ default: 1 })
  attempt_number: number;

  // Ejemplo: la data con las respuestas
  @Prop({ type: Object })
  answers_data: Record<string, any>;

  // Puntaje obtenido, máximo y si está completado
  @Prop({ default: 0 })
  total_score: number;

  @Prop({ default: 0 })
  max_score: number;

  // Podrías agregar otras propiedades, p.e. tiempo de finalización
}

export const QuizAttemptSchema = SchemaFactory.createForClass(QuizAttempt);
