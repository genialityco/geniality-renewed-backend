import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Enlace de acceso directo: quien lo abre entra como `user_id` en
 * `organization_id` sin escribir su contraseña. Solo se guarda el hash del
 * token; Mongo borra el registro al vencer (índice TTL).
 */
@Schema({
  collection: 'auth_links',
  timestamps: { createdAt: 'created_at', updatedAt: false },
})
export class AuthLink extends Document {
  @Prop({ required: true, unique: true }) token_hash: string;
  @Prop({ required: true }) user_id: string;
  @Prop({ required: true }) organization_id: string;
  // Quién lo generó: genon, practice, admin
  @Prop({ required: true }) source: string;
  @Prop({ required: true, type: Date }) expires_at: Date;
  @Prop({ default: 0 }) uses: number;
  @Prop({ type: Date, default: null }) last_used_at: Date | null;
}

export const AuthLinkSchema = SchemaFactory.createForClass(AuthLink);

AuthLinkSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
