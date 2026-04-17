"use strict";
// ==========================================
// ALFYCHAT - CONTRÔLEUR CONVERSATIONS (Group DM)
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.conversationController = exports.ConversationController = void 0;
const conversations_service_1 = require("../services/conversations.service");
const messages_service_1 = require("../services/messages.service");
const logger_1 = require("../utils/logger");
const conversationService = new conversations_service_1.ConversationService();
const messageService = new messages_service_1.MessageService();
class ConversationController {
    // ============ CRÉATION ============
    /** POST / — Créer une conversation (DM ou groupe) */
    async create(req, res) {
        try {
            const { type, participantIds, name, avatarUrl } = req.body;
            const userId = req.headers['x-user-id'];
            const ownerId = type === 'group' ? userId : undefined;
            const conversation = await conversationService.create({
                type,
                participantIds,
                name,
                avatarUrl,
                ownerId,
            });
            logger_1.logger.info(`Conversation créée: ${conversation.id} (type: ${type})`);
            res.status(201).json(conversation);
        }
        catch (error) {
            logger_1.logger.error('Erreur création conversation:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // ============ LECTURE ============
    /** GET /:conversationId — Récupérer une conversation par ID */
    async getById(req, res) {
        try {
            const { conversationId } = req.params;
            const userId = req.userId || req.headers['x-user-id'];
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
        }
        catch (error) {
            logger_1.logger.error('Erreur récupération conversation:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    /** GET /user/:userId — Conversations de l'utilisateur authentifié */
    async getByUser(req, res) {
        try {
            const authenticatedId = req.userId;
            // Seul l'utilisateur authentifié peut accéder à ses propres conversations
            if (req.params.userId !== authenticatedId) {
                return res.status(403).json({ error: 'Accès non autorisé' });
            }
            const userId = authenticatedId;
            const conversations = await conversationService.getByUser(userId);
            // Ajouter le nombre de messages non lus
            const conversationsWithUnread = await Promise.all(conversations.map(async (conv) => ({
                ...conv,
                unreadCount: await messageService.getUnreadCount(conv.id, userId),
            })));
            res.json(conversationsWithUnread);
        }
        catch (error) {
            logger_1.logger.error('Erreur récupération conversations:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    /** POST /dm — Trouver ou créer un DM */
    async findOrCreateDM(req, res) {
        try {
            const { userId1, userId2 } = req.body;
            const conversation = await conversationService.findOrCreateDM(userId1, userId2);
            res.json(conversation);
        }
        catch (error) {
            logger_1.logger.error('Erreur DM:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // ============ MISE À JOUR ============
    /** PATCH /:conversationId — Mettre à jour (nom, avatar) */
    async update(req, res) {
        try {
            const { conversationId } = req.params;
            const { name, avatarUrl } = req.body;
            const userId = req.headers['x-user-id'];
            // Vérifier que l'utilisateur est participant
            const isParticipant = await conversationService.isParticipant(conversationId, userId);
            if (!isParticipant) {
                return res.status(403).json({ error: 'Accès non autorisé' });
            }
            await conversationService.update(conversationId, { name, avatarUrl });
            const updated = await conversationService.getById(conversationId);
            res.json(updated);
        }
        catch (error) {
            logger_1.logger.error('Erreur mise à jour conversation:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // ============ PARTICIPANTS ============
    /** POST /:conversationId/participants — Ajouter un participant */
    async addParticipant(req, res) {
        try {
            const { conversationId } = req.params;
            const { userId } = req.body;
            const requesterId = req.headers['x-user-id'];
            // Vérifier que le requester est participant
            const isParticipant = await conversationService.isParticipant(conversationId, requesterId);
            if (!isParticipant) {
                return res.status(403).json({ error: 'Accès non autorisé' });
            }
            await conversationService.addParticipant(conversationId, userId);
            logger_1.logger.info(`Participant ajouté: ${userId} -> ${conversationId}`);
            const updated = await conversationService.getById(conversationId);
            res.json(updated);
        }
        catch (error) {
            logger_1.logger.error('Erreur ajout participant:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    /** DELETE /:conversationId/participants/:userId — Retirer un participant */
    async removeParticipant(req, res) {
        try {
            const { conversationId, userId } = req.params;
            const requesterId = req.headers['x-user-id'];
            // Seul le owner/admin ou l'utilisateur lui-même peut retirer
            const requesterRole = await conversationService.getParticipantRole(conversationId, requesterId);
            if (!requesterRole) {
                return res.status(403).json({ error: 'Accès non autorisé' });
            }
            if (requesterId !== userId && requesterRole !== 'owner' && requesterRole !== 'admin') {
                return res.status(403).json({ error: 'Permissions insuffisantes' });
            }
            await conversationService.removeParticipant(conversationId, userId);
            logger_1.logger.info(`Participant retiré: ${userId} <- ${conversationId}`);
            res.json({ success: true });
        }
        catch (error) {
            logger_1.logger.error('Erreur retrait participant:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // ============ QUITTER / SUPPRIMER ============
    /** POST /:conversationId/leave — Quitter un groupe */
    async leave(req, res) {
        try {
            const { conversationId } = req.params;
            const userId = req.headers['x-user-id'];
            const result = await conversationService.leaveGroup(conversationId, userId);
            logger_1.logger.info(`Utilisateur ${userId} a quitté le groupe ${conversationId}`);
            res.json(result);
        }
        catch (error) {
            logger_1.logger.error('Erreur quitter groupe:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    /** DELETE /:conversationId — Supprimer une conversation (owner only) */
    async delete(req, res) {
        try {
            const { conversationId } = req.params;
            const userId = req.headers['x-user-id'];
            // Vérifier que c'est le owner
            const role = await conversationService.getParticipantRole(conversationId, userId);
            if (role !== 'owner') {
                return res.status(403).json({ error: 'Seul le propriétaire peut supprimer le groupe' });
            }
            await conversationService.delete(conversationId);
            logger_1.logger.info(`Conversation supprimée: ${conversationId}`);
            res.json({ success: true });
        }
        catch (error) {
            logger_1.logger.error('Erreur suppression conversation:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
}
exports.ConversationController = ConversationController;
exports.conversationController = new ConversationController();
//# sourceMappingURL=conversations.controller.js.map