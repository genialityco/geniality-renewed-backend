import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import * as mongoose from 'mongoose';

// ============= Content Blocks =============
@Schema({ _id: false })
export class TextBlockSchema {
  @Prop({ type: String, enum: ['text'], required: true })
  type: 'text';

  @Prop({ type: String, required: true })
  id: string;

  @Prop({ type: String, required: true })
  content: string;

  @Prop({
    type: String,
    enum: ['plain', 'h1', 'h2', 'h3', 'quote', 'code'],
    default: 'plain',
  })
  format: string;

  @Prop({
    type: String,
    enum: ['none', 'bullet', 'ordered'],
    default: 'none',
  })
  listType: string;
}

@Schema({ _id: false })
export class ImageBlockSchema {
  @Prop({ type: String, enum: ['image'], required: true })
  type: 'image';

  @Prop({ type: String, required: true })
  id: string;

  @Prop({ type: String, required: true })
  url: string;

  @Prop({ type: String })
  caption?: string;
}

@Schema({ _id: false })
export class VideoBlockSchema {
  @Prop({ type: String, enum: ['video'], required: true })
  type: 'video';

  @Prop({ type: String, required: true })
  id: string;

  @Prop({ type: String, required: true })
  url: string;

  @Prop({ type: String })
  caption?: string;
}

// ============= Single Choice =============
@Schema({ _id: false })
export class SingleChoiceOptionSchema {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({
    type: [{ type: mongoose.Schema.Types.Mixed }],
    required: true,
  })
  blocks: (TextBlockSchema | ImageBlockSchema | VideoBlockSchema)[];
}

@Schema({ _id: false })
export class SingleChoiceQuestionSchema {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({ type: String, enum: ['single-choice'], required: true })
  type: 'single-choice';

  @Prop({
    type: [{ type: mongoose.Schema.Types.Mixed }],
    required: true,
  })
  blocks: (TextBlockSchema | ImageBlockSchema | VideoBlockSchema)[];

  @Prop({ type: [SingleChoiceOptionSchema], required: true })
  opciones: SingleChoiceOptionSchema[];

  @Prop({ type: Number, required: true })
  respuestacorrecta: number;
}

// ============= Multiple Choice =============
@Schema({ _id: false })
export class MultipleChoiceQuestionSchema {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({ type: String, enum: ['multiple-choice'], required: true })
  type: 'multiple-choice';

  @Prop({
    type: [{ type: mongoose.Schema.Types.Mixed }],
    required: true,
  })
  blocks: (TextBlockSchema | ImageBlockSchema | VideoBlockSchema)[];

  @Prop({ type: [SingleChoiceOptionSchema], required: true })
  opciones: SingleChoiceOptionSchema[];

  @Prop({ type: [Number], required: true })
  respuestascorrectas: number[];
}

// ============= Matching =============
@Schema({ _id: false })
export class MatchingPairSchema {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({
    type: [{ type: mongoose.Schema.Types.Mixed }],
    required: true,
  })
  leftBlocks: (TextBlockSchema | ImageBlockSchema | VideoBlockSchema)[];

  @Prop({
    type: [{ type: mongoose.Schema.Types.Mixed }],
    required: true,
  })
  rightBlocks: (TextBlockSchema | ImageBlockSchema | VideoBlockSchema)[];
}

@Schema({ _id: false })
export class MatchingQuestionSchema {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({ type: String, enum: ['matching'], required: true })
  type: 'matching';

  @Prop({
    type: [{ type: mongoose.Schema.Types.Mixed }],
    required: true,
  })
  blocks: (TextBlockSchema | ImageBlockSchema | VideoBlockSchema)[];

  @Prop({ type: [MatchingPairSchema], required: true })
  pairs: MatchingPairSchema[];
}

// ============= Ordering =============
@Schema({ _id: false })
export class OrderingItemSchema {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({
    type: [{ type: mongoose.Schema.Types.Mixed }],
    required: true,
  })
  blocks: (TextBlockSchema | ImageBlockSchema | VideoBlockSchema)[];
}

@Schema({ _id: false })
export class OrderingQuestionSchema {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({ type: String, enum: ['ordering'], required: true })
  type: 'ordering';

  @Prop({
    type: [{ type: mongoose.Schema.Types.Mixed }],
    required: true,
  })
  blocks: (TextBlockSchema | ImageBlockSchema | VideoBlockSchema)[];

  @Prop({ type: [OrderingItemSchema], required: true })
  items: OrderingItemSchema[];

  @Prop({ type: [String], required: true })
  correctOrder: string[];
}

// Union type for questions
export type QuestionSchema =
  | SingleChoiceQuestionSchema
  | MultipleChoiceQuestionSchema
  | MatchingQuestionSchema
  | OrderingQuestionSchema;

export const TextBlockSchemaFactory = SchemaFactory.createForClass(
  TextBlockSchema,
);
export const ImageBlockSchemaFactory = SchemaFactory.createForClass(
  ImageBlockSchema,
);
export const VideoBlockSchemaFactory = SchemaFactory.createForClass(
  VideoBlockSchema,
);
export const SingleChoiceOptionSchemaFactory = SchemaFactory.createForClass(
  SingleChoiceOptionSchema,
);
export const SingleChoiceQuestionSchemaFactory = SchemaFactory.createForClass(
  SingleChoiceQuestionSchema,
);
export const MultipleChoiceQuestionSchemaFactory =
  SchemaFactory.createForClass(MultipleChoiceQuestionSchema);
export const MatchingPairSchemaFactory =
  SchemaFactory.createForClass(MatchingPairSchema);
export const MatchingQuestionSchemaFactory = SchemaFactory.createForClass(
  MatchingQuestionSchema,
);
export const OrderingItemSchemaFactory =
  SchemaFactory.createForClass(OrderingItemSchema);
export const OrderingQuestionSchemaFactory = SchemaFactory.createForClass(
  OrderingQuestionSchema,
);
