// ==========================================
// ALFYCHAT - ROUTES NOTIFICATIONS
// Stockage persistant des pings/notifications jusqu'à lecture
// ==========================================

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth';
import { getDatabaseClient } from '../database';

export const notificationsRouter = Router();

/**
 * POST /notifications
 * Ajoute ou incrémente une notification pour un utilisateur hors ligne.
 * Appelé par le gateway après l'envoi d'un message.
 * Auth : x-user-id header (service interne)
 */
notificationsRouter.post('/', async (req, res) => {
  try {
    const { userId, conversationId, senderName } = req.body as {
      userId?: string;
      conversationId?: string;
      senderName?: string;
    };

    if (!userId || !conversationId || !senderName) {
      return res.status(400).json({ error: 'userId, conversationId et senderName sont requis' });
    }

    const db = getDatabaseClient();

    // UPSERT : incrémenter message_count si la ligne existe déjà (même conv, même user)
    await db.execute(
      `INSERT INTO notifications (id, user_id, conversation_id, sender_name, message_count, is_read)
       VALUES (?, ?, ?, ?, 1, FALSE)
       ON DUPLICATE KEY UPDATE
         message_count = message_count + 1,
         sender_name   = VALUES(sender_name),
         is_read       = FALSE,
         updated_at    = CURRENT_TIMESTAMP`,
      [uuidv4(), userId, conversationId, senderName],
    );

    res.json({ success: true });
  } catch (error) {
    console.error('POST /notifications error:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

/**
 * GET /notifications
 * Retourne toutes les notifications non-lues de l'utilisateur connecté.
 */
notificationsRouter.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const db = getDatabaseClient();

    const [rows]: any = await db.execute(
      `SELECT conversation_id, sender_name, message_count, created_at, updated_at
       FROM notifications
       WHERE user_id = ? AND is_read = FALSE
       ORDER BY updated_at DESC`,
      [userId],
    );

    // Convertir en map { [conversationId]: { count, senderName } }
    const result: Record<string, { count: number; senderName: string }> = {};
    for (const row of rows) {
      result[row.conversation_id] = {
        count: row.message_count,
        senderName: row.sender_name,
      };
    }

    res.json(result);
  } catch (error) {
    console.error('GET /notifications error:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

/**
 * PATCH /notifications/read
 * Marque les notifications d'une conversation comme lues.
 * Body : { conversationId: string }  — optionnel : sans body = tout marquer lu
 */
notificationsRouter.patch('/read', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { conversationId } = req.body as { conversationId?: string };
    const db = getDatabaseClient();

    if (conversationId) {
      await db.execute(
        `UPDATE notifications SET is_read = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND conversation_id = ?`,
        [userId, conversationId],
      );
    } else {
      await db.execute(
        `UPDATE notifications SET is_read = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [userId],
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('PATCH /notifications/read error:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});
