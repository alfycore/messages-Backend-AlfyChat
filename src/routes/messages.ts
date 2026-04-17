// ==========================================
// ALFYCHAT - ROUTES MESSAGES (Signal Protocol E2EE)
// Le serveur est un relais opaque — pas de déchiffrement côté serveur.
// ==========================================

import { Router } from 'express';
import { body, query, param } from 'express-validator';
import { messageController } from '../controllers/messages.controller';
import { validateRequest } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';
import { internalOnly } from '../middleware/internal';
import { getDatabaseClient } from '../database';
import { getRedisClient } from '../redis';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const VOICE_UPLOAD_DIR = path.join(process.env.UPLOADS_DIR || '/uploads', 'voice');
if (!fs.existsSync(VOICE_UPLOAD_DIR)) {
  fs.mkdirSync(VOICE_UPLOAD_DIR, { recursive: true });
}

const voiceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, VOICE_UPLOAD_DIR),
  filename: (_req, _file, cb) => cb(null, `${uuidv4()}.ogg`),
});

const voiceUpload = multer({
  storage: voiceStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/ogg', 'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format audio non supporté'));
    }
  },
});

// TTL du cache messages (secondes). Court pour rester cohérent avec le temps réel.
const MSG_CACHE_TTL = 4;

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
        // DM déterministe — le room ID inclut forcément userId
        const sortedIds = [userId, recipientId as string].sort();
        conversationId = `dm_${sortedIds[0]}_${sortedIds[1]}`;
      } else if (channelId) {
        const cid = channelId as string;

        // Vérifier l'appartenance avant de servir les messages
        if (cid.startsWith('dm_')) {
          // Format dm_UUID1_UUID2 — vérifier que userId est l'un des deux
          if (!cid.includes(userId)) {
            return res.status(403).json({ error: 'Accès non autorisé' });
          }
        } else {
          // Conversation UUID (groupe) — vérifier en base
          const db = getDatabaseClient();
          const [rows] = await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
            [cid, userId]
          );
          if ((rows as any[]).length === 0) {
            return res.status(403).json({ error: 'Accès non autorisé' });
          }
        }

        conversationId = cid;
      }

      if (!conversationId) {
        return res.json([]);
      }

      // ── Cache Redis ──────────────────────────────────────
      const redis = getRedisClient();
      const cacheKey = `msg:${conversationId}:${limit}:${before || ''}`;
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          res.setHeader('X-Cache', 'HIT');
          return res.json(JSON.parse(cached));
        }
      } catch { /* cache miss, continue */ }

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

      // Écrire le résultat en cache Redis (fire-and-forget)
      try {
        await redis.set(cacheKey, JSON.stringify(messages), MSG_CACHE_TTL);
      } catch { /* non-bloquant */ }

      res.setHeader('X-Cache', 'MISS');
      res.json(messages);
    } catch (error) {
      console.error('Erreur récupération messages:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Créer un message Signal E2EE (appel interne gateway → messages)
messagesRouter.post('/',
  internalOnly,
  body('id').optional().isUUID(),
  body('conversationId').isString().notEmpty(),
  body('senderId').isUUID(),
  body('content').notEmpty().isLength({ max: 131072 }),      // ciphertext Signal (ECDH peut être grand)
  body('senderContent').optional().isString().isLength({ max: 131072 }),
  body('e2eeType').optional().toInt().isIn([1, 3]),                  // type Signal
  body('replyToId').optional().isUUID(),
  validateRequest,
  messageController.create.bind(messageController)
);

// Rechercher des messages dans une conversation (uniquement non-E2EE)
messagesRouter.get('/search',
  authMiddleware,
  query('conversationId').isString().notEmpty(),
  query('q').isString().isLength({ min: 1, max: 200 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  query('before').optional().isISO8601(),
  validateRequest,
  async (req, res, next) => {
    try {
      const userId = (req as any).userId;
      const conversationId = req.query.conversationId as string;
      // Vérifier l'accès
      if (conversationId.startsWith('dm_')) {
        if (!conversationId.includes(userId)) {
          return res.status(403).json({ error: 'Accès non autorisé' });
        }
      } else {
        const db = getDatabaseClient();
        const [rows] = await db.query(
          'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
          [conversationId, userId]
        );
        if ((rows as any[]).length === 0) {
          return res.status(403).json({ error: 'Accès non autorisé' });
        }
      }
      next();
    } catch {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  },
  messageController.search.bind(messageController)
);

// Récupérer les messages d'une conversation
messagesRouter.get('/conversation/:conversationId',
  authMiddleware,
  param('conversationId').isString().notEmpty(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('before').optional().isISO8601(),
  validateRequest,
  async (req, res, next) => {
    try {
      const userId = (req as any).userId;
      const { conversationId } = req.params;
      if (conversationId.startsWith('dm_')) {
        if (!conversationId.includes(userId)) {
          return res.status(403).json({ error: 'Accès non autorisé' });
        }
      } else {
        const db = getDatabaseClient();
        const [rows] = await db.query(
          'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
          [conversationId, userId]
        );
        if ((rows as any[]).length === 0) {
          return res.status(403).json({ error: 'Accès non autorisé' });
        }
      }
      next();
    } catch {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  },
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

// ============ MESSAGES VOCAUX ============

// Envoyer un message vocal (clip audio)
messagesRouter.post('/voice',
  authMiddleware,
  voiceUpload.single('audio'),
  async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { conversationId, duration } = req.body;

      if (!req.file) {
        return res.status(400).json({ error: 'Fichier audio requis' });
      }

      if (!conversationId) {
        return res.status(400).json({ error: 'conversationId requis' });
      }

      const db = getDatabaseClient();

      // Vérifier l'accès à la conversation
      if (!conversationId.startsWith('dm_')) {
        const [rows] = await db.query(
          'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
          [conversationId, userId]
        );
        if ((rows as any[]).length === 0) {
          fs.unlinkSync(req.file.path);
          return res.status(403).json({ error: 'Accès non autorisé' });
        }
      } else if (!conversationId.includes(userId)) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'Accès non autorisé' });
      }

      const messageId = uuidv4();
      const voiceUrl = `/uploads/voice/${req.file.filename}`;
      const voiceDuration = parseInt(duration as string) || null;

      await db.execute(
        `INSERT INTO messages (id, conversation_id, sender_id, content, message_type, voice_url, voice_duration)
         VALUES (?, ?, ?, '', 'voice', ?, ?)`,
        [messageId, conversationId, userId, voiceUrl, voiceDuration]
      );

      // Invalider le cache Redis de la conversation
      const redis = getRedisClient();
      const cachePattern = `msg:${conversationId}:*`;
      try {
        const keys = await redis.keys(cachePattern);
        if (keys.length) await redis.del(...keys);
      } catch { /* non-bloquant */ }

      res.status(201).json({
        id: messageId,
        conversationId,
        senderId: userId,
        messageType: 'voice',
        voiceUrl,
        voiceDuration,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      console.error('Erreur message vocal:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// ============ SUPPRESSION RGPD — Messages d'un utilisateur ============

// Supprimer tous les messages d'un utilisateur (appelé par le service users/RGPD)
messagesRouter.delete('/user/:userId/all',
  authMiddleware,
  async (req, res) => {
    try {
      const requesterId = (req as any).userId;
      const { userId } = req.params;

      // Seul l'utilisateur lui-même ou un admin peut faire cette demande
      if (requesterId !== userId) {
        return res.status(403).json({ error: 'Non autorisé' });
      }

      const db = getDatabaseClient();
      await db.execute(
        `UPDATE messages SET content = '[Message supprimé]', sender_content = NULL, is_deleted = TRUE
         WHERE sender_id = ?`,
        [userId]
      );

      res.json({ success: true, message: 'Tous vos messages ont été supprimés.' });
    } catch (error) {
      console.error('Erreur suppression messages RGPD:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);