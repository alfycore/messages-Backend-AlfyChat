// ==========================================
// ALFYCHAT - ROUTES NOTIFICATIONS
// Stockage persistant des pings/notifications jusqu'à lecture
// ==========================================

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth';
import { internalOnly } from '../middleware/internal';
import { getDatabaseClient } from '../database';

type NotifLevel = 'all' | 'mentions' | 'nothing';

export const notificationsRouter = Router();

/**
 * POST /notifications
 * Ajoute ou incrémente une notification pour un utilisateur hors ligne.
 * Appelé par le gateway après l'envoi d'un message.
 * Auth : x-user-id header (service interne)
 */
notificationsRouter.post('/', internalOnly, async (req, res) => {
  try {
    const { userId, conversationId, senderName, senderId, notificationType, channelName } = req.body as {
      userId?: string;
      conversationId?: string;
      senderName?: string;
      senderId?: string;
      notificationType?: 'message' | 'mention';
      channelName?: string;
    };

    if (!userId || !conversationId || !senderName) {
      return res.status(400).json({ error: 'userId, conversationId et senderName sont requis' });
    }

    const db = getDatabaseClient();
    const type = notificationType ?? 'message';

    // UPSERT : incrémenter message_count si la ligne existe déjà (même conv, même user)
    // Pour les mentions, on garde le type 'mention' même si un message ordinaire arrive après
    await db.execute(
      `INSERT INTO notifications (id, user_id, conversation_id, sender_name, sender_id, notification_type, channel_name, message_count, is_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, FALSE)
       ON DUPLICATE KEY UPDATE
         message_count     = message_count + 1,
         sender_name       = VALUES(sender_name),
         sender_id         = VALUES(sender_id),
         notification_type = IF(VALUES(notification_type) = 'mention', 'mention', notification_type),
         channel_name      = COALESCE(VALUES(channel_name), channel_name),
         is_read           = FALSE,
         updated_at        = CURRENT_TIMESTAMP`,
      [uuidv4(), userId, conversationId, senderName, senderId ?? null, type, channelName ?? null],
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

    const [rows]: any = await db.query(
      `SELECT conversation_id, sender_name, message_count, notification_type, channel_name, created_at, updated_at
       FROM notifications
       WHERE user_id = ? AND is_read = FALSE
       ORDER BY updated_at DESC`,
      [userId],
    );

    // Convertir en map { [conversationId]: { count, senderName, type, channelName } }
    const result: Record<string, { count: number; senderName: string; type: string; channelName?: string }> = {};
    for (const row of rows) {
      result[row.conversation_id] = {
        count: row.message_count,
        senderName: row.sender_name,
        type: row.notification_type ?? 'message',
        ...(row.channel_name ? { channelName: row.channel_name } : {}),
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
      // The frontend may send just a recipientId (plain UUID) for DMs.
      // Notifications are stored as "dm_<sorted_id1>_<sorted_id2>", so we
      // normalise the key before querying to ensure the UPDATE matches.
      let convKey = conversationId;
      const isRawDm =
        !conversationId.startsWith('dm_') &&
        !conversationId.startsWith('group:') &&
        !conversationId.startsWith('channel:');
      if (isRawDm) {
        const sorted = [userId, conversationId].sort();
        convKey = `dm_${sorted[0]}_${sorted[1]}`;
      }
      await db.execute(
        `UPDATE notifications SET is_read = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND conversation_id = ?`,
        [userId, convKey],
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

// ──────────────────────────────────────────────────────────────────────────────
// PARAMÈTRES DE NOTIFICATION PAR CANAL / DM / GROUPE
// ──────────────────────────────────────────────────────────────────────────────

/**
 * GET /notifications/settings
 * Retourne tous les réglages de notification de l'utilisateur.
 * Réponse : { [targetId]: { level, target_type } }
 */
notificationsRouter.get('/settings', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const db = getDatabaseClient();

    const [rows]: any = await db.query(
      `SELECT target_id, target_type, level FROM channel_notification_settings WHERE user_id = ?`,
      [userId],
    );

    const result: Record<string, { level: NotifLevel; targetType: string }> = {};
    for (const row of rows) {
      result[row.target_id] = { level: row.level as NotifLevel, targetType: row.target_type };
    }

    res.json(result);
  } catch (error) {
    console.error('GET /notifications/settings error:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

/**
 * PUT /notifications/settings/:targetId
 * Créer ou mettre à jour le réglage de notification pour un canal/DM/groupe.
 * Body : { level: 'all' | 'mentions' | 'nothing', targetType: 'channel' | 'dm' | 'group' | 'server' }
 */
notificationsRouter.put('/settings/:targetId', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { targetId } = req.params;
    const { level, targetType } = req.body as { level?: NotifLevel; targetType?: string };

    if (!level || !['all', 'mentions', 'nothing'].includes(level)) {
      return res.status(400).json({ error: 'level invalide (all | mentions | nothing)' });
    }
    if (!targetType || !['channel', 'dm', 'group', 'server'].includes(targetType)) {
      return res.status(400).json({ error: 'targetType invalide' });
    }

    const db = getDatabaseClient();

    await db.execute(
      `INSERT INTO channel_notification_settings (user_id, target_id, target_type, level)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE level = VALUES(level), updated_at = CURRENT_TIMESTAMP`,
      [userId, targetId, targetType, level],
    );

    res.json({ success: true, targetId, level });
  } catch (error) {
    console.error('PUT /notifications/settings/:targetId error:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

/**
 * DELETE /notifications/settings/:targetId
 * Réinitialise le réglage de notification (retour au défaut 'all').
 */
notificationsRouter.delete('/settings/:targetId', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { targetId } = req.params;
    const db = getDatabaseClient();

    await db.execute(
      `DELETE FROM channel_notification_settings WHERE user_id = ? AND target_id = ?`,
      [userId, targetId],
    );

    res.json({ success: true });
  } catch (error) {
    console.error('DELETE /notifications/settings/:targetId error:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});
