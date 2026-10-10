// ==========================================
// ALFYCHAT - ROUTES ARCHIVAGE DM
// API REST pour le système hybride MP
// ==========================================

import { Router } from 'express';
import { param, query, body } from 'express-validator';
import { validateRequest } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';
import { internalOnly } from '../middleware/internal';
import { DMArchiveService } from '../services/dm-archive.service';
import { ExternalDbService, assertPublicDbHost } from '../services/external-db.service';
import { getDatabaseClient } from '../database';
import { getRedisClient } from '../redis';
import { logger } from '../utils/logger';

const dmArchiveService = new DMArchiveService();
const externalDbService = new ExternalDbService();

export const archiveRouter = Router();

// Toutes ces routes acceptaient n'importe quel conversationId / messageId :
// statistiques, quotas et messages archivés d'une conversation tierce étaient
// lisibles par tout compte authentifié.
const DM_ID_RE = /^dm_([0-9a-fA-F-]{36})_([0-9a-fA-F-]{36})$/;

async function canAccessConversation(conversationId: string, userId: string): Promise<boolean> {
  if (!conversationId || !userId) return false;
  const m = DM_ID_RE.exec(conversationId);
  if (m) return m[1] === userId || m[2] === userId;
  const [rows] = await getDatabaseClient().query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
    [conversationId, userId]
  );
  return (rows as any[]).length > 0;
}

/** Middleware : l'appelant doit participer à :conversationId. */
async function requireConversationAccess(req: any, res: any, next: any) {
  try {
    if (!(await canAccessConversation(req.params.conversationId, req.userId))) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    next();
  } catch {
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

/** Plafond par utilisateur des tests de connexion sortante (sonde réseau). */
async function allowExternalDbAttempt(userId: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const key = `extdb:attempts:${userId}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 3600);
    return count <= 10;
  } catch {
    return false;
  }
}

// Récupérer le statut d'archive d'une conversation DM
archiveRouter.get('/status/:conversationId',
  authMiddleware,
  param('conversationId').isString().notEmpty(),
  validateRequest,
  requireConversationAccess,
  async (req, res) => {
    try {
      const { conversationId } = req.params;
      const status = await dmArchiveService.getArchiveStatus(conversationId);
      res.json(status);
    } catch (error) {
      logger.error('Erreur récupération statut archive:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Récupérer les stats d'une conversation DM
archiveRouter.get('/stats/:conversationId',
  authMiddleware,
  param('conversationId').isString().notEmpty(),
  validateRequest,
  requireConversationAccess,
  async (req, res) => {
    try {
      const { conversationId } = req.params;
      const stats = await dmArchiveService.getConversationStats(conversationId);
      res.json(stats);
    } catch (error) {
      logger.error('Erreur récupération stats:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Vérifier le quota d'une conversation DM
archiveRouter.get('/quota/:conversationId',
  authMiddleware,
  param('conversationId').isString().notEmpty(),
  validateRequest,
  requireConversationAccess,
  async (req, res) => {
    try {
      const { conversationId } = req.params;
      const quota = await dmArchiveService.checkQuota(conversationId);
      res.json(quota);
    } catch (error) {
      logger.error('Erreur vérification quota:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Confirmer la réception d'un archivage par un peer
archiveRouter.post('/confirm',
  authMiddleware,
  body('conversationId').isString().notEmpty(),
  body('archiveLogId').isString().notEmpty(),
  validateRequest,
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { conversationId, archiveLogId } = req.body;

      if (!(await canAccessConversation(conversationId, userId))) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }

      const allConfirmed = await dmArchiveService.confirmArchive(
        conversationId,
        archiveLogId,
        userId
      );

      res.json({ 
        success: true, 
        allConfirmed,
        message: allConfirmed 
          ? 'Tous les peers ont confirmé, messages supprimés du serveur'
          : 'Confirmation enregistrée, en attente des autres peers'
      });
    } catch (error) {
      logger.error('Erreur confirmation archive:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Récupérer un message archivé (cherche dans cache Redis d'abord)
archiveRouter.get('/message/:messageId',
  authMiddleware,
  param('messageId').isString().notEmpty(),
  validateRequest,
  async (req, res) => {
    try {
      const { messageId } = req.params;
      const cached = await dmArchiveService.getCachedArchivedMessage(messageId);

      // Le message mis en cache porte sa conversation : on ne le sert qu'à ses
      // participants (n'importe quel messageId était lisible).
      if (cached && await canAccessConversation(String((cached as any).conversationId ?? ''), (req as any).userId)) {
        res.json({ source: 'cache', message: cached });
      } else {
        // Le message n'est pas en cache → il faut demander aux peers via WebSocket
        res.json({ source: 'peer_needed', message: null });
      }
    } catch (error) {
      logger.error('Erreur récupération message archivé:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Mettre en cache un message récupéré d'un peer (appelé par le gateway)
archiveRouter.post('/cache',
  internalOnly,
  body('messages').isArray({ min: 1 }),
  validateRequest,
  async (req, res) => {
    try {
      // Normalisation : le gateway envoie `id`, le service indexait sur
      // `messageId` (clé « undefined »). Seuls les messages avec une
      // conversation et un identifiant valides sont mis en cache.
      const messages = (req.body.messages as any[])
        .slice(0, 200)
        .map((m) => ({ ...m, messageId: m?.messageId ?? m?.id }))
        .filter((m) => typeof m.messageId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(m.messageId)
          && typeof m.conversationId === 'string' && m.conversationId.length <= 128);
      await dmArchiveService.cacheBulkArchivedMessages(messages);
      res.json({ success: true, cached: messages.length });
    } catch (error) {
      logger.error('Erreur mise en cache:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Déclencher la maintenance manuelle — interne uniquement (tout compte
// authentifié pouvait lancer cette opération coûteuse et destructrice).
archiveRouter.post('/maintenance',
  internalOnly,
  async (req, res) => {
    try {
      const result = await dmArchiveService.runDailyMaintenance();
      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      logger.error('Erreur maintenance:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// ============================================================
// DB EXTERNE UTILISATEUR
// Permet à chaque user de configurer sa propre base MySQL
// pour recevoir automatiquement ses anciens messages archivés.
// ============================================================

// Récupérer la config (sans mot de passe)
archiveRouter.get('/external-db',
  authMiddleware,
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const config = await externalDbService.getConfig(userId);
      if (!config) return res.json({ configured: false });
      res.json({ configured: true, ...config });
    } catch (error) {
      logger.error('Erreur récupération config DB externe:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Enregistrer / mettre à jour la config
archiveRouter.post('/external-db',
  authMiddleware,
  body('host').isString().isLength({ min: 1, max: 255 }).trim(),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('user').isString().isLength({ min: 1, max: 128 }).trim(),
  body('password').isString().isLength({ min: 1 }),
  body('database').isString().isLength({ min: 1, max: 128 }).trim(),
  validateRequest,
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { host, port = 3306, user, password, database } = req.body;

      // L'hôte est fourni par l'utilisateur : le service s'y connecte depuis le
      // réseau interne. Sans garde, c'était une sonde (SSRF) vers les bases et
      // services internes, avec les messages d'erreur bruts en retour.
      if (!(await allowExternalDbAttempt(userId))) {
        return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard' });
      }
      if (!(await assertPublicDbHost(host))) {
        return res.status(400).json({ error: 'Hôte refusé — une adresse publique est requise' });
      }

      // Tester la connexion avant de sauvegarder
      const test = await externalDbService.testConnection(host, port, user, password, database);
      if (!test.ok) {
        return res.status(400).json({ error: 'Connexion impossible avec ces paramètres' });
      }

      await externalDbService.saveConfig(userId, host, port, user, password, database);
      res.json({ success: true, message: 'Base de données externe configurée avec succès' });
    } catch (error) {
      logger.error('Erreur sauvegarde config DB externe:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Tester la connexion sans sauvegarder
archiveRouter.post('/external-db/test',
  authMiddleware,
  body('host').isString().isLength({ min: 1, max: 255 }).trim(),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('user').isString().isLength({ min: 1, max: 128 }).trim(),
  body('password').isString().isLength({ min: 1 }),
  body('database').isString().isLength({ min: 1, max: 128 }).trim(),
  validateRequest,
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { host, port = 3306, user, password, database } = req.body;
      if (!(await allowExternalDbAttempt(userId))) {
        return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard' });
      }
      if (!(await assertPublicDbHost(host))) {
        return res.status(400).json({ ok: false, error: 'Hôte refusé — une adresse publique est requise' });
      }
      const result = await externalDbService.testConnection(host, port, user, password, database);
      // Pas de message d'erreur brut (il révélait l'état du réseau interne).
      res.json(result.ok ? { ok: true } : { ok: false, error: 'Connexion impossible avec ces paramètres' });
    } catch (error) {
      logger.error('Erreur test DB externe:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Récupérer des messages depuis la DB externe (pour répondre aux peers)
archiveRouter.get('/external-db/messages',
  authMiddleware,
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { conversationId, before, limit, messageId } = req.query as Record<string, string>;

      if (!conversationId) {
        return res.status(400).json({ error: 'conversationId requis' });
      }
      if (!(await canAccessConversation(conversationId, userId))) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }

      const messages = await externalDbService.fetchFromExternalDb(userId, conversationId, {
        before,
        limit: limit ? Math.min(parseInt(limit), 200) : 50,
        messageId,
      });

      res.json({ messages });
    } catch (error) {
      logger.error('Erreur lecture DB externe:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Supprimer la config
archiveRouter.delete('/external-db',
  authMiddleware,
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      await externalDbService.deleteConfig(userId);
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur suppression config DB externe:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);
