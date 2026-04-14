// ==========================================
// ALFYCHAT - ROUTES CONVERSATIONS (Group DM)
// ==========================================

import { Router } from 'express';
import { body, param } from 'express-validator';
import { conversationController } from '../controllers/conversations.controller';
import { validateRequest } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';

import { getDatabaseClient } from '../database';
import { ConversationService } from '../services/conversations.service';
export const conversationsRouter = Router();

const conversationService = new ConversationService();

// ============ GET / — Toutes les conversations de l'utilisateur connecté ============
conversationsRouter.get('/',
  async (req, res, next) => {
    // Accepter soit un JWT (frontend), soit un x-user-id header (appel gateway interne)
    const internalUserId = req.headers['x-user-id'] as string | undefined;
    if (internalUserId && !req.headers.authorization) {
      (req as any).userId = internalUserId;
      return next();
    }
    return authMiddleware(req, res, next);
  },
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      
      if (!userId) {
        return res.status(401).json({ error: 'Non authentifié' });
      }
      
      // Récupérer les conversations via le service
      const conversations = await conversationService.getByUser(userId);

      // Formater la réponse
      const result = conversations.map(conv => {
        const recipientId = conv.type === 'dm'
          ? conv.participantIds.find((id: string) => id !== userId)
          : undefined;
        
        return {
          id: conv.id,
          type: conv.type,
          name: conv.name,
          avatarUrl: conv.avatarUrl,
          ownerId: conv.ownerId,
          recipientId,
          participantIds: conv.participantIds,
          participants: conv.participants,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        };
      });
      
      res.json(result);
    } catch (error) {
      console.error('Erreur récupération conversations:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// ============ POST / — Créer une conversation ============
conversationsRouter.post('/',
  body('type').isIn(['dm', 'group']),
  body('participantIds').isArray({ min: 2 }),
  body('participantIds.*').isString(),
  body('name').optional().isString().isLength({ max: 100 }),
  body('avatarUrl').optional().isString(),
  validateRequest,
  conversationController.create.bind(conversationController)
);

// ============ POST /dm — Trouver ou créer un DM ============
conversationsRouter.post('/dm',
  authMiddleware,
  body('recipientId').isString(),
  validateRequest,
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { recipientId } = req.body;
      
      if (!userId) {
        return res.status(401).json({ error: 'Non authentifié' });
      }
      
      // Utiliser le service pour trouver ou créer le DM
      const conversation = await conversationService.findOrCreateDM(userId, recipientId);
      
      res.json({
        id: conversation.id,
        type: 'dm',
        participantIds: conversation.participantIds,
        participants: conversation.participants,
        createdAt: conversation.createdAt,
      });
    } catch (error) {
      console.error('Erreur création DM:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// ============ GET /user/:userId — Conversations d'un utilisateur ============
conversationsRouter.get('/user/:userId',
  authMiddleware,
  param('userId').isString(),
  validateRequest,
  conversationController.getByUser.bind(conversationController)
);

// ============ GET /:conversationId — Récupérer une conversation ============
conversationsRouter.get('/:conversationId',
  authMiddleware,
  param('conversationId').isString(),
  validateRequest,
  conversationController.getById.bind(conversationController)
);

// ============ PATCH /:conversationId — Mettre à jour (nom, avatar) ============
conversationsRouter.patch('/:conversationId',
  authMiddleware,
  param('conversationId').isString(),
  body('name').optional().isString().isLength({ max: 100 }),
  body('avatarUrl').optional().isString(),
  validateRequest,
  conversationController.update.bind(conversationController)
);

// ============ GET /:conversationId/participants/:userId/check — Vérifier appartenance (interne) ============
conversationsRouter.get('/:conversationId/participants/:userId/check',
  param('conversationId').isString(),
  param('userId').isString(),
  validateRequest,
  async (req, res) => {
    try {
      const { conversationId, userId } = req.params;
      const isParticipant = await conversationService.isParticipant(conversationId, userId);
      res.json({ isParticipant });
    } catch {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// ============ POST /:conversationId/participants — Ajouter un participant ============
conversationsRouter.post('/:conversationId/participants',
  authMiddleware,
  param('conversationId').isString(),
  body('userId').isString(),
  validateRequest,
  conversationController.addParticipant.bind(conversationController)
);

// ============ DELETE /:conversationId/participants/:userId — Retirer un participant ============
conversationsRouter.delete('/:conversationId/participants/:userId',
  authMiddleware,
  param('conversationId').isString(),
  param('userId').isString(),
  validateRequest,
  conversationController.removeParticipant.bind(conversationController)
);

// ============ POST /:conversationId/leave — Quitter un groupe ============
conversationsRouter.post('/:conversationId/leave',
  authMiddleware,
  param('conversationId').isString(),
  validateRequest,
  conversationController.leave.bind(conversationController)
);

// ============ DELETE /:conversationId — Supprimer une conversation ============
conversationsRouter.delete('/:conversationId',
  authMiddleware,
  param('conversationId').isString(),
  validateRequest,
  conversationController.delete.bind(conversationController)
);

// ============ ÉPINGLAGE DE DMs ============

// Épingler une conversation (stocké dans le service users, mais exposé ici pour commodité)
// Le frontend appellera directement l'API users pour les DMs épinglés
// Cette route est un alias qui redirige vers la logique users via header interne

conversationsRouter.post('/:conversationId/pin',
  authMiddleware,
  param('conversationId').isString(),
  validateRequest,
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { conversationId } = req.params;
      const db = getDatabaseClient();

      // Calculer le prochain pin_order
      const [posRows] = await db.query(
        'SELECT COALESCE(MAX(pin_order),-1) as maxOrd FROM pinned_conversations WHERE user_id = ?',
        [userId]
      );
      const pinOrder = ((posRows as any[])[0]?.maxOrd ?? -1) + 1;

      await db.execute(
        `INSERT IGNORE INTO pinned_conversations (user_id, conversation_id, pin_order) VALUES (?, ?, ?)`,
        [userId, conversationId, pinOrder]
      );

      res.json({ success: true, pinOrder });
    } catch {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

conversationsRouter.delete('/:conversationId/pin',
  authMiddleware,
  param('conversationId').isString(),
  validateRequest,
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { conversationId } = req.params;
      const db = getDatabaseClient();

      await db.execute(
        'DELETE FROM pinned_conversations WHERE user_id = ? AND conversation_id = ?',
        [userId, conversationId]
      );

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Récupérer les conversations épinglées de l'utilisateur connecté
conversationsRouter.get('/pinned',
  authMiddleware,
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const db = getDatabaseClient();

      const [rows] = await db.query(
        'SELECT conversation_id, pin_order FROM pinned_conversations WHERE user_id = ? ORDER BY pin_order ASC',
        [userId]
      );

      res.json((rows as any[]).map(r => ({ conversationId: r.conversation_id, pinOrder: r.pin_order })));
    } catch {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);
