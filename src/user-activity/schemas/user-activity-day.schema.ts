import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Días en que un usuario usó la plataforma en una organización (uno por
 * usuario, organización y fecha local). UserActivity guarda un solo registro
 * que se sobrescribe en cada sesión, así que sin esto no se puede saber si
 * alguien volvió después de un recordatorio sin llegar a completar nada.
 */
@Schema({ collection: 'user_activity_days', timestamps: false })
export class UserActivityDay extends Document {
  @Prop({ required: true }) user_id: string;
  @Prop({ required: true }) organization_id: string;
  // YYYY-MM-DD en America/Bogota
  @Prop({ required: true }) date: string;
  @Prop({ required: true, type: Date }) first_at: Date;
  @Prop({ required: true, type: Date }) last_at: Date;
}

export const UserActivityDaySchema =
  SchemaFactory.createForClass(UserActivityDay);

UserActivityDaySchema.index(
  { user_id: 1, organization_id: 1, date: 1 },
  { unique: true },
);
UserActivityDaySchema.index({ organization_id: 1, last_at: -1 });
