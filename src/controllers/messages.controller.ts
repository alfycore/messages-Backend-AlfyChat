// ==========================================
// ALFYCHAT - CONTRÔLEUR MESSAGES
// ==========================================

import { Request, Response } from 'express';
import { MessageService } from '../services/messages.service';
import { logger } from '../utils/logger';
import { AuthRequest } from '../types/express';
import { getRedisClient } from '../redis';

const messageService = new MessageService();

export class MessageController {
  // Rechercher des messages
  async search(req: Request, res: Response) {
    try {
      const { conversationId, q, limit = '30', before } = req.query;
      const userId = (req as any).userId || req.headers['x-user-id'] as string;

      const messages = await messageService.search(
        conversationId as string,
        q as string,
        userId,
        parseInt(limit as string),
        before as string | undefined,
      );

      res.json(messages);
    } catch (error) {
      logger.error('Erreur recherche messages:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // Créer un message
  async create(req: Request, res: Response) {
    try {
      const { conversationId, senderId, content, senderContent, e2eeType, replyToId } = req.body;

      const message = await messageService.create({
        conversationId,
        senderId,
        content,
        senderContent,
        e2eeType,
        replyToId,
      });

      logger.info(`Message créé: ${message.id} (E2EE)`);
      res.status(201).json(message);

      // Invalider le cache Redis pour cette conversation (fire-and-forget)
      try {
        const redis = getRedisClient();
        await redis.del(`msg:${conversationId}:50:`);
      } catch { /* non-bloquant */ }
    } catch (error: any) {
      logger.error('Erreur création message:', error);
      
      if (error.message === 'Conversation non trouvée') {
        return res.status(404).json({ error: error.message });
      }
      
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // Récupérer les messages d'une conversation
  async getByConversation(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const { limit = '50', before } = req.query;
      const userId = req.headers['x-user-id'] as string;

      const messages = await messageService.getByConversation(
        conversationId,
        userId,
        parseInt(limit as string),
        before as string | undefined
      );

      res.json(messages);
    } catch (error) {
      logger.error('Erreur récupération messages:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // Récupérer un message par ID
  async getById(req: Request, res: Response) {
    try {
      const { messageId } = req.params;
      const userId = req.headers['x-user-id'] as string;

      const message = await messageService.getById(messageId, userId);

      if (!message) {
        return res.status(404).json({ error: 'Message non trouvé' });
      }

      res.json(message);
    } catch (error) {
      logger.error('Erreur récupération message:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // Mettre à jour un message
  async update(req: Request, res: Response) {
    try {
      const { messageId } = req.params;
      const { content } = req.body;
      const senderId = req.headers['x-user-id'] as string;

      const message = await messageService.update(messageId, senderId, { content });

      if (!message) {
        return res.status(404).json({ error: 'Message non trouvé ou non autorisé' });
      }

      logger.info(`Message modifié: ${messageId}`);
      res.json(message);
    } catch (error) {
      logger.error('Erreur modification message:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // Supprimer un message
  async delete(req: Request, res: Response) {
    try {
      const { messageId } = req.params;
      const senderId = req.headers['x-user-id'] as string;

      const deleted = await messageService.delete(messageId, senderId);

      if (!deleted) {
        return res.status(404).json({ error: 'Message non trouvé ou non autorisé' });
      }

      logger.info(`Message supprimé: ${messageId}`);
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur suppression message:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // Ajouter une réaction
  async addReaction(req: Request, res: Response) {
    try {
      const { messageId } = req.params;
      const { emoji } = req.body;
      const userId = req.headers['x-user-id'] as string;

      await messageService.addReaction(messageId, userId, emoji);
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur ajout réaction:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // Supprimer une réaction
  async removeReaction(req: Request, res: Response) {
    try {
      const { messageId, emoji } = req.params;
      const userId = req.headers['x-user-id'] as string;

      await messageService.removeReaction(messageId, userId, emoji);
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur suppression réaction:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // Marquer comme lu
  async markAsRead(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const userId = req.headers['x-user-id'] as string;

      await messageService.markAsRead(conversationId, userId);
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur marquage lu:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
}

export const messageController = new MessageController();
