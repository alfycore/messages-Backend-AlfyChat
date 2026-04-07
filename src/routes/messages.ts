// ==========================================
// ALFYCHAT - ROUTES MESSAGES (Signal Protocol E2EE)
// Le serveur est un relais opaque — pas de déchiffrement côté serveur.
// ==========================================

import { Router } from 'express';
import { body, query, param } from 'express-validator';
import { messageController } from '../controllers/messages.controller';
import { validateRequest } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';
import { getDatabaseClient } from '../database';

export const messagesRouter = Router();

// Récupérer les messages (par channelId ou recipientId)
// Retourne les ciphertexts Signal opaques — le client déchiffre
messagesRouter.get('/',
  authMiddleware,
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('before').optional().isISO8601(),
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { recipientId, channelId, limit = 50, before } = req.query;

      let conversationId: string | null = null;

      if (recipientId) {
        const sortedIds = [userId, recipientId as string].sort();
        conversationId = `dm_${sortedIds[0]}_${sortedIds[1]}`;
      } else if (channelId) {
        conversationId = channelId as string;
      }

      if (!conversationId) {
        return res.json([]);
      }

      const db = getDatabaseClient();

      let msgQuery = `
        SELECT m.id, m.conversation_id as conversationId, m.sender_id as senderId,
               m.content, m.sender_content as senderContent, m.e2ee_type as e2eeType,
               m.reply_to_id as replyToId,
               m.created_at as createdAt, m.is_edited as isEdited, m.updated_at as updatedAt,
               u.username as senderUsername, u.display_name as senderDisplayName, u.avatar_url as senderAvatarUrl
        FROM messages m
        LEFT JOIN users u ON m.sender_id = u.id
        WHERE m.conversation_id = ? AND m.is_deleted = FALSE
      `;
      const params: any[] = [conversationId];

      if (before) {
        msgQuery += ' AND m.created_at < ?';
        params.push(before);
      }

      const limitInt = Math.min(Math.max(parseInt(limit as string) || 50, 1), 100);
      msgQuery += ` ORDER BY m.created_at DESC LIMIT ${limitInt}`;

      const [rowsDesc] = await db.query(msgQuery, params);
      const rows = (rowsDesc as any[]).reverse();

      // Charger les réactions pour tous les messages
      const messageIds = (rows as any[]).map((r: any) => r.id);
      let reactionsMap: Record<string, Array<{ emoji: string; userId: string }>> = {};

      if (messageIds.length > 0) {
        const placeholders = messageIds.map(() => '?').join(',');
        const [reactionRows] = await db.query(
          `SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (${placeholders})`,
          messageIds
        );
        for (const r of reactionRows as any[]) {
          if (!reactionsMap[r.message_id]) reactionsMap[r.message_id] = [];
          reactionsMap[r.message_id].push({ emoji: r.emoji, userId: r.user_id });
        }
      }

      // Retourner les ciphertexts opaques — AUCUN déchiffrement côté serveur
      const messages = (rows as any[]).map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        senderId: row.senderId,
        authorId: row.senderId,
        content: row.content,             // ciphertext Signal pour le destinataire
        senderContent: row.senderContent, // ciphertext Signal pour l'expéditeur
        e2eeType: row.e2eeType,           // 1 = Whisper, 3 = PreKey, null = non chiffré
        replyToId: row.replyToId || null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        isEdited: row.isEdited,
        reactions: reactionsMap[row.id] || [],
        sender: {
          id: row.senderId,
          username: row.senderUsername,
          displayName: row.senderDisplayName,
          avatarUrl: row.senderAvatarUrl,
        },
      }));

      res.json(messages);
    } catch (error) {
      console.error('Erreur récupération messages:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Créer un message Signal E2EE
messagesRouter.post('/',
  body('conversationId').isString().notEmpty(),
  body('senderId').isUUID(),
  body('content').notEmpty().isLength({ max: 65535 }),       // ciphertext Signal
  body('senderContent').optional().isString(),               // ciphertext pour l'expéditeur
  body('e2eeType').optional().isIn([1, 3]),                  // type Signal
  body('replyToId').optional().isUUID(),
  validateRequest,
  messageController.create.bind(messageController)
);

// Récupérer les messages d'une conversation
messagesRouter.get('/conversation/:conversationId',
  param('conversationId').isString().notEmpty(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('before').optional().isISO8601(),
  validateRequest,
  messageController.getByConversation.bind(messageController)
);

// Récupérer un message par ID
messagesRouter.get('/:messageId',
  param('messageId').isUUID(),
  validateRequest,
  messageController.getById.bind(messageController)
);

// Mettre à jour un message (édition — nouveaux ciphertexts Signal)
messagesRouter.patch('/:messageId',
  param('messageId').isUUID(),
  body('content').notEmpty().isLength({ max: 65535 }),
  body('senderContent').optional().isString(),
  body('e2eeType').optional().isIn([1, 3]),
  validateRequest,
  messageController.update.bind(messageController)
);

// Supprimer un message
messagesRouter.delete('/:messageId',
  param('messageId').isUUID(),
  validateRequest,
  messageController.delete.bind(messageController)
);

// Ajouter une réaction
messagesRouter.post('/:messageId/reactions',
  param('messageId').isUUID(),
  body('emoji').isString().isLength({ min: 1, max: 50 }),
  validateRequest,
  messageController.addReaction.bind(messageController)
);

// Supprimer une réaction
messagesRouter.delete('/:messageId/reactions/:emoji',
  param('messageId').isUUID(),
  validateRequest,
  messageController.removeReaction.bind(messageController)
);

// Marquer comme lu
messagesRouter.post('/conversation/:conversationId/read',
  param('conversationId').isUUID(),
  validateRequest,
  messageController.markAsRead.bind(messageController)
);

