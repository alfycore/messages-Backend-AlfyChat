// ==========================================
// ALFYCHAT - SERVICE MESSAGES
// Chiffrement multi-niveaux pour messages privés
// ==========================================

import dotenv from 'dotenv';
dotenv.config();
import { registerGlobalErrorHandlers } from './utils/error-reporter';
registerGlobalErrorHandlers();
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { messagesRouter } from './routes/messages';
import { conversationsRouter } from './routes/conversations';
import { archiveRouter } from './routes/archive';
import { notificationsRouter } from './routes/notifications';
import { getDatabaseClient, runMigrations } from './database';
import { getRedisClient } from './redis';
import { dmArchiveService } from './services/dm-archive.service';
import { startServiceRegistration, serviceMetricsMiddleware, collectServiceMetrics } from './utils/service-client';
import { logger } from './utils/logger';

dotenv.config();

const app = express();

app.use(cors({
  origin: process.env.GATEWAY_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(helmet());
app.use(express.json());
app.use(serviceMetricsMiddleware);

// Routes
app.use('/messages', messagesRouter);
app.use('/conversations', conversationsRouter);
app.use('/archive', archiveRouter);
app.use('/notifications', notificationsRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'messages' });
});

app.get('/metrics', (req, res) => {
  res.json({
    service: 'messages',
    serviceId: process.env.SERVICE_ID || 'messages-default',
    location: (process.env.SERVICE_LOCATION || 'EU').toUpperCase(),
    ...collectServiceMetrics(),
    uptime: process.uptime(),
  });
});

async function start() {
  try {
    const db = getDatabaseClient({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'alfychat',
      password: process.env.DB_PASSWORD || 'alfychat',
      database: process.env.DB_NAME || 'alfychat',
    });

    await runMigrations(db);

    getRedisClient({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
    });

    const PORT = process.env.PORT || 3002;
    app.listen(PORT, () => {
      logger.info(`🚀 Service Messages démarré sur le port ${PORT}`);
      startServiceRegistration('messages');

      // Lancer la maintenance quotidienne DM (toutes les 24h)
      const MAINTENANCE_INTERVAL = 24 * 60 * 60 * 1000; // 24h
      setInterval(async () => {
        try {
          logger.info('⏰ Démarrage maintenance DM programmée...');
          await dmArchiveService.runDailyMaintenance();
        } catch (error) {
          logger.error('Erreur maintenance DM programmée:', error);
        }
      }, MAINTENANCE_INTERVAL);

      logger.info('📦 Système hybride DM activé (quota 20k/30j + P2P)');
    });
  } catch (error) {
    logger.error('Erreur au démarrage:', error);
    process.exit(1);
  }
}

start();

export default app;
