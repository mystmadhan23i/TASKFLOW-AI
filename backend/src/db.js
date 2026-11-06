import mongoose from 'mongoose';
import { config } from './config.js';

// Expose `id` alongside `_id` and drop `__v` in every JSON response.
mongoose.set('toJSON', { virtuals: true, versionKey: false });
mongoose.set('strictQuery', true);

export async function connectDb() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  console.log('MongoDB connected');
}
