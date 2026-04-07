"use strict";
// ==========================================
// ALFYCHAT - CONTRÔLEUR MESSAGES
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageController = exports.MessageController = void 0;
const messages_service_1 = require("../services/messages.service");
const logger_1 = require("../utils/logger");
const messageService = new messages_service_1.MessageService();
class MessageController {
    // Créer un message
    async create(req, res) {
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
            logger_1.logger.info(`Message créé: ${message.id} (E2EE)`);
            res.status(201).json(message);
        }
        catch (error) {
            logger_1.logger.error('Erreur création message:', error);
            if (error.message === 'Conversation non trouvée') {
                return res.status(404).json({ error: error.message });
            }
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // Récupérer les messages d'une conversation
    async getByConversation(req, res) {
        try {
            const { conversationId } = req.params;
            const { limit = '50', before } = req.query;
            const userId = req.headers['x-user-id'];
            const messages = await messageService.getByConversation(conversationId, userId, parseInt(limit), before);
            res.json(messages);
        }
        catch (error) {
            logger_1.logger.error('Erreur récupération messages:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // Récupérer un message par ID
    async getById(req, res) {
        try {
            const { messageId } = req.params;
            const userId = req.headers['x-user-id'];
            const message = await messageService.getById(messageId, userId);
            if (!message) {
                return res.status(404).json({ error: 'Message non trouvé' });
            }
            res.json(message);
        }
        catch (error) {
            logger_1.logger.error('Erreur récupération message:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // Mettre à jour un message
    async update(req, res) {
        try {
            const { messageId } = req.params;
            const { content } = req.body;
            const senderId = req.headers['x-user-id'];
            const message = await messageService.update(messageId, senderId, { content });
            if (!message) {
                return res.status(404).json({ error: 'Message non trouvé ou non autorisé' });
            }
            logger_1.logger.info(`Message modifié: ${messageId}`);
            res.json(message);
        }
        catch (error) {
            logger_1.logger.error('Erreur modification message:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // Supprimer un message
    async delete(req, res) {
        try {
            const { messageId } = req.params;
            const senderId = req.headers['x-user-id'];
            const deleted = await messageService.delete(messageId, senderId);
            if (!deleted) {
                return res.status(404).json({ error: 'Message non trouvé ou non autorisé' });
            }
            logger_1.logger.info(`Message supprimé: ${messageId}`);
            res.json({ success: true });
        }
        catch (error) {
            logger_1.logger.error('Erreur suppression message:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // Ajouter une réaction
    async addReaction(req, res) {
        try {
            const { messageId } = req.params;
            const { emoji } = req.body;
            const userId = req.headers['x-user-id'];
            await messageService.addReaction(messageId, userId, emoji);
            res.json({ success: true });
        }
        catch (error) {
            logger_1.logger.error('Erreur ajout réaction:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // Supprimer une réaction
    async removeReaction(req, res) {
        try {
            const { messageId, emoji } = req.params;
            const userId = req.headers['x-user-id'];
            await messageService.removeReaction(messageId, userId, emoji);
            res.json({ success: true });
        }
        catch (error) {
            logger_1.logger.error('Erreur suppression réaction:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    // Marquer comme lu
    async markAsRead(req, res) {
        try {
            const { conversationId } = req.params;
            const userId = req.headers['x-user-id'];
            await messageService.markAsRead(conversationId, userId);
            res.json({ success: true });
        }
        catch (error) {
            logger_1.logger.error('Erreur marquage lu:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
}
exports.MessageController = MessageController;
exports.messageController = new MessageController();
//# sourceMappingURL=messages.controller.js.map