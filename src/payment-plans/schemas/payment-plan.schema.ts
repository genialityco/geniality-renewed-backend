import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class PaymentPlan extends Document {
  @Prop({ required: true })
  days: number;

  @Prop({ required: true })
  date_until: Date;

  @Prop({ required: true })
  price: number;

  // Referencia a OrganizationUser
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OrganizationUser',
    required: true,
  })
  organization_user_id: string;
}

export const PaymentPlanSchema = SchemaFactory.createForClass(PaymentPlan);
