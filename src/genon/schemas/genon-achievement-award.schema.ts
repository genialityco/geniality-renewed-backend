import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import type { GenOnAchievementType } from '../genon-achievements';

/**
 * Logro conseguido por una persona en un programa (uno por persona y logro).
 * Si cae en el grupo de control (`holdout`) se registra igual, pero no se le
 * muestra: así se puede comparar su avance contra quienes sí lo ven.
 */
@Schema({
  collection: 'genon_achievement_awards',
  timestamps: { createdAt: 'created_at', updatedAt: false },
})
export class GenOnAchievementAward extends Document {
  @Prop({ required: true, index: true }) program_id: string;
  @Prop({ required: true }) achievement_id: string;
  @Prop({ type: String, required: true }) type: GenOnAchievementType;
  @Prop({ required: true }) threshold: number;
  @Prop({ required: true }) user_id: string;
  /** Valor alcanzado al conseguirlo (actividades, videos, días…) */
  @Prop({ default: 0 }) value: number;
  @Prop({ default: false }) holdout: boolean;
  /** Cuándo la plataforma le mostró el aviso (null: aún no) */
  @Prop({ type: Date, default: null }) seen_at: Date | null;
  created_at?: Date;
}

export const GenOnAchievementAwardSchema = SchemaFactory.createForClass(GenOnAchievementAward);
// Un logro por persona
GenOnAchievementAwardSchema.index(
  { program_id: 1, achievement_id: 1, user_id: 1 },
  { unique: true },
);
GenOnAchievementAwardSchema.index({ user_id: 1, program_id: 1 });
