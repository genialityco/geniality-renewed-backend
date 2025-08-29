// user.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class User extends Document {
  @Prop({ required: true, unique: true })
  uid: string;

  @Prop()
  names: string;

  @Prop()
  email: string;

  @Prop()
  phone: string;

  // DEPRECADO: sessionToken: string;

  @Prop({
    type: [
      {
        token: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  sessionTokens: { token: string; createdAt: Date }[];
}

export const UserSchema = SchemaFactory.createForClass(User);

// (Opcional) Si quieres migrar automáticamente el viejo sessionToken a la nueva lista:
UserSchema.pre('save', function (next) {
  const anyThis = this as any;
  if (
    anyThis.sessionToken &&
    (!anyThis.sessionTokens || anyThis.sessionTokens.length === 0)
  ) {
    anyThis.sessionTokens = [
      { token: anyThis.sessionToken, createdAt: new Date() },
    ];
    anyThis.sessionToken = undefined;
  }
  next();
});
