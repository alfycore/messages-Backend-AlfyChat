// ==========================================
// ALFYCHAT - ROUTES ARCHIVAGE DM
// API REST pour le système hybride MP
// ==========================================

import { Router } from 'express';
import { param, query, body } from 'express-validator';
import { validateRequest } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';
import { DMArchiveService } from '../services/dm-archive.service';
import { logger } from '../utils/logger';

const dmArchiveService = new DMArchiveService();

export const archiveRouter = Router();

// Récupérer le statut d'archive d'une conversation DM
archiveRouter.get('/status/:conversationId',
  authMiddleware,
  param('conversationId').isString().notEmpty(),
  validateRequest,
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

      if (cached) {
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
  body('messages').isArray({ min: 1 }),
  validateRequest,
  async (req, res) => {
    try {
      const { messages } = req.body;
      await dmArchiveService.cacheBulkArchivedMessages(messages);
      res.json({ success: true, cached: messages.length });
    } catch (error) {
      logger.error('Erreur mise en cache:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Déclencher la maintenance manuelle (admin only)
archiveRouter.post('/maintenance',
  authMiddleware,
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
