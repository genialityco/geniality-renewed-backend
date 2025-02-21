import { Schema, Document } from 'mongoose';

export const ModuleSchema = new Schema({
  module_name: { type: String, required: true },
  order: { type: Number, required: true },
  event_id: { type: String, required: true },
  // Campo para almacenar progreso del módulo
  progress: { type: Number, default: 0 },
  updated_at: { type: Date, default: Date.now },
  created_at: { type: Date, default: Date.now },
});

export interface Module extends Document {
  module_name: string;
  order: number;
  event_id: string;
  progress: number;
  updated_at: Date;
  created_at: Date;
}
