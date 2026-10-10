// ==========================================
// ALFYCHAT - CONTRÔLEUR CONVERSATIONS (Group DM)
// ==========================================

import { Request, Response } from 'express';
import { ConversationService } from '../services/conversations.service';
import { MessageService } from '../services/messages.service';
import { logger } from '../utils/logger';
import { getDatabaseClient } from '../database';

const conversationService = new ConversationService();
const messageService = new MessageService();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GROUP_SIZE = 100;

/**
 * Identifiants (parmi `candidateIds`) qui ont bloqué `requesterId` ou que
 * `requesterId` a bloqués. Un compte bloqué pouvait contourner le blocage en
 * ajoutant sa victime à un groupe, puis lui écrire librement.
 */
async function blockedAmong(requesterId: string, candidateIds: string[]): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const placeholders = candidateIds.map(() => '?').join(',');
  const [rows] = await getDatabaseClient().query(
    `SELECT user_id, friend_id FROM friends
     WHERE status = 'blocked'
       AND ((user_id IN (${placeholders}) AND friend_id = ?) OR (user_id = ? AND friend_id IN (${placeholders})))`,
    [...candidateIds, requesterId, requesterId, ...candidateIds]
  );
  const out = new Set<string>();
  for (const r of rows as any[]) out.add(r.user_id === requesterId ? r.friend_id : r.user_id);
  return out;
}

export class ConversationController {
  // ============ CRÉATION ============

  /** POST / — Créer une conversation (DM ou groupe) */
  async create(req: Request, res: Response) {
    try {
      const { type, participantIds, name, avatarUrl, isOpen } = req.body;
      const userId = (req as any).userId || (req.headers['x-user-id'] as string);
      if (!userId) {
        return res.status(401).json({ error: 'Non authentifié' });
      }

      // Le créateur doit faire partie de la conversation : sans ce contrôle, un
      // compte pouvait fabriquer des groupes entre inconnus (spam / harcèlement).
      let uniqueParticipants = Array.from(
        new Set<string>([userId, ...(Array.isArray(participantIds) ? participantIds : [])].filter(
          (id): id is string => typeof id === 'string' && UUID_RE.test(id),
        )),
      );
      // Les comptes qui ont bloqué le créateur (ou qu'il a bloqués) sont écartés.
      const blocked = await blockedAmong(userId, uniqueParticipants.filter((id) => id !== userId));
      uniqueParticipants = uniqueParticipants.filter((id) => !blocked.has(id));
      if (uniqueParticipants.length < 2) {
        return res.status(400).json({ error: 'Au moins deux participants sont requis' });
      }
      if (uniqueParticipants.length > MAX_GROUP_SIZE) {
        return res.status(400).json({ error: `Un groupe compte au plus ${MAX_GROUP_SIZE} participants` });
      }
      if (type === 'dm' && uniqueParticipants.length !== 2) {
        return res.status(400).json({ error: 'Un MP compte exactement deux participants' });
      }

      const ownerId = type === 'group' ? userId : undefined;

      const conversation = await conversationService.create({
        type,
        participantIds: uniqueParticipants,
        name,
        avatarUrl,
        ownerId,
        isOpen,
      });

      logger.info(`Conversation créée: ${conversation.id} (type: ${type})`);
      res.status(201).json(conversation);
    } catch (error) {
      logger.error('Erreur création conversation:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // ============ LECTURE ============

  /** GET /:conversationId — Récupérer une conversation par ID */
  async getById(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const userId = (req as any).userId || req.headers['x-user-id'] as string;

      if (!userId) {
        return res.status(401).json({ error: 'Non authentifié' });
      }

      const conversation = await conversationService.getById(conversationId);

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation non trouvée' });
      }

      // Vérifier que l'utilisateur est participant
      const isParticipant = await conversationService.isParticipant(conversationId, userId);
      if (!isParticipant) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }

      res.json(conversation);
    } catch (error) {
      logger.error('Erreur récupération conversation:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  /** GET /user/:userId — Conversations de l'utilisateur authentifié */
  async getByUser(req: Request, res: Response) {
    try {
      const authenticatedId = (req as any).userId as string;

      // Seul l'utilisateur authentifié peut accéder à ses propres conversations
      if (req.params.userId !== authenticatedId) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }

      const userId = authenticatedId;

      const conversations = await conversationService.getByUser(userId);

      // Ajouter le nombre de messages non lus
      const conversationsWithUnread = await Promise.all(
        conversations.map(async (conv) => ({
          ...conv,
          unreadCount: await messageService.getUnreadCount(conv.id, userId),
        }))
      );

      res.json(conversationsWithUnread);
    } catch (error) {
      logger.error('Erreur récupération conversations:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  /** POST /dm — Trouver ou créer un DM */
  async findOrCreateDM(req: Request, res: Response) {
    try {
      const { userId1, userId2 } = req.body;

      const conversation = await conversationService.findOrCreateDM(userId1, userId2);
      res.json(conversation);
    } catch (error) {
      logger.error('Erreur DM:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // ============ MISE À JOUR ============

  /** PATCH /:conversationId — Mettre à jour (nom, avatar) */
  async update(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const { name, avatarUrl, isOpen } = req.body;
      const userId = req.headers['x-user-id'] as string;

      // Vérifier que l'utilisateur est participant
      const isParticipant = await conversationService.isParticipant(conversationId, userId);
      if (!isParticipant) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }

      // Ouvrir / fermer le groupe est réservé au propriétaire : un simple
      // membre rouvrait un groupe fermé pour y ajouter qui il voulait.
      if (isOpen !== undefined) {
        const role = await conversationService.getParticipantRole(conversationId, userId);
        if (role !== 'owner') {
          return res.status(403).json({ error: 'Seul le propriétaire peut ouvrir ou fermer le groupe' });
        }
      }

      await conversationService.update(conversationId, { name, avatarUrl, isOpen });
      const updated = await conversationService.getById(conversationId);
      res.json(updated);
    } catch (error) {
      logger.error('Erreur mise à jour conversation:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // ============ PARTICIPANTS ============

  /** POST /:conversationId/participants — Ajouter un participant */
  async addParticipant(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const { userId } = req.body;
      const requesterId = req.headers['x-user-id'] as string;

      // Vérifier que le requester est participant
      const isParticipant = await conversationService.isParticipant(conversationId, requesterId);
      if (!isParticipant) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }

      // En mode Fermé, seul le propriétaire peut ajouter des membres
      const conversation = await conversationService.getById(conversationId);
      if (conversation?.type !== 'group') {
        return res.status(400).json({ error: 'Seuls les groupes acceptent de nouveaux membres' });
      }
      if (conversation.isOpen === false && conversation.ownerId !== requesterId) {
        return res.status(403).json({ error: 'Ce groupe est fermé. Seul le propriétaire peut ajouter des membres.' });
      }
      if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
        return res.status(400).json({ error: 'userId invalide' });
      }
      if ((await blockedAmong(requesterId, [userId])).size > 0) {
        return res.status(403).json({ error: 'Impossible d\'ajouter cet utilisateur' });
      }
      if ((await conversationService.countParticipants(conversationId)) >= MAX_GROUP_SIZE) {
        return res.status(400).json({ error: `Un groupe compte au plus ${MAX_GROUP_SIZE} participants` });
      }

      await conversationService.addParticipant(conversationId, userId);
      logger.info(`Participant ajouté: ${userId} -> ${conversationId}`);
      
      const updated = await conversationService.getById(conversationId);
      res.json(updated);
    } catch (error) {
      logger.error('Erreur ajout participant:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  /** DELETE /:conversationId/participants/:userId — Retirer un participant */
  async removeParticipant(req: Request, res: Response) {
    try {
      const { conversationId, userId } = req.params;
      const requesterId = req.headers['x-user-id'] as string;

      // Seul le owner/admin ou l'utilisateur lui-même peut retirer
      const requesterRole = await conversationService.getParticipantRole(conversationId, requesterId);
      if (!requesterRole) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }
      if (requesterId !== userId && requesterRole !== 'owner' && requesterRole !== 'admin') {
        return res.status(403).json({ error: 'Permissions insuffisantes' });
      }

      await conversationService.removeParticipant(conversationId, userId);
      logger.info(`Participant retiré: ${userId} <- ${conversationId}`);
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur retrait participant:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // ============ QUITTER / SUPPRIMER ============

  /** POST /:conversationId/leave — Quitter un groupe */
  async leave(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const userId = req.headers['x-user-id'] as string;

      const result = await conversationService.leaveGroup(conversationId, userId);
      logger.info(`Utilisateur ${userId} a quitté le groupe ${conversationId}`);
      res.json(result);
    } catch (error) {
      logger.error('Erreur quitter groupe:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  /** DELETE /:conversationId — Supprimer une conversation (owner only) */
  async delete(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const userId = req.headers['x-user-id'] as string;

      // Vérifier que c'est le owner
      const role = await conversationService.getParticipantRole(conversationId, userId);
      if (role !== 'owner') {
        return res.status(403).json({ error: 'Seul le propriétaire peut supprimer le groupe' });
      }

      await conversationService.delete(conversationId);
      logger.info(`Conversation supprimée: ${conversationId}`);
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur suppression conversation:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
}

export const conversationController = new ConversationController();
