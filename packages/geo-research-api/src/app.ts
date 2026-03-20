import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index.js';
import { errorHandler } from './middleware/errors.js';
import authRouter from './routes/auth.js';
import discoveryRouter from './routes/discovery.js';
import discoveryAutomationRouter from './routes/discoveryAutomation.js';
import reviewRouter from './routes/review.js';
import publishRouter from './routes/publish.js';
import chatRouter from './routes/chat.js';
import papersRouter from './routes/papers.js';
import feedbackRouter from './routes/feedback.js';
import annotationsRouter from './routes/annotations.js';
import topicProfilesRouter from './routes/topicProfiles.js';
import topicsRouter from './routes/topics.js';
import voiceProxyRouter from './routes/voiceProxy.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: config.cors.origin }));
app.use(express.json());

// Health check
app.get('/api/v1/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

// Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/discovery', discoveryAutomationRouter);
app.use('/api/v1/discovery', discoveryRouter);
app.use('/api/v1/review', reviewRouter);
app.use('/api/v1/publish', publishRouter);
app.use('/api/v1/chat', chatRouter);
app.use('/api/v1/papers', papersRouter);
app.use('/api/v1/feedback', feedbackRouter);
app.use('/api/v1/annotations', annotationsRouter);
app.use('/api/v1/topic-profiles', topicProfilesRouter);
app.use('/api/v1/topics', topicsRouter);

// Voice proxy — matches gateway URL structure used by @rickydata/react SDK
app.use('/agents', voiceProxyRouter);

// Also mount publish routes at /api/v1/published for GET reads
app.use('/api/v1/published', publishRouter);

// Error handler
app.use(errorHandler);

export default app;
