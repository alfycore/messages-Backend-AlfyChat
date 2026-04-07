"use strict";
// ==========================================
// ALFYCHAT - ROUTES MESSAGES (Signal Protocol E2EE)
// Le serveur est un relais opaque — pas de déchiffrement côté serveur.
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.messagesRouter = void 0;
const express_1 = require("express");
const express_validator_1 = require("express-validator");
const messages_controller_1 = require("../controllers/messages.controller");
const validate_1 = require("../middleware/validate");
const auth_1 = require("../middleware/auth");
const database_1 = require("../database");
exports.messagesRouter = (0, express_1.Router)();
// Récupérer les messages (par channelId ou recipientId)
// Retourne les ciphertexts Signal opaques — le client déchiffre
exports.messagesRouter.get('/', auth_1.authMiddleware, (0, express_validator_1.query)('limit').optional().isInt({ min: 1, max: 100 }), (0, express_validator_1.query)('before').optional().isISO8601(), async (req, res) => {
    try {
        const userId = req.userId;
        const { recipientId, channelId, limit = 50, before } = req.query;
        let conversationId = null;
        if (recipientId) {
            const sortedIds = [userId, recipientId].sort();
            conversationId = `dm_${sortedIds[0]}_${sortedIds[1]}`;
        }
        else if (channelId) {
            conversationId = channelId;
        }
        if (!conversationId) {
            return res.json([]);
        }
        const db = (0, database_1.getDatabaseClient)();
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
        const params = [conversationId];
        if (before) {
            msgQuery += ' AND m.created_at < ?';
            params.push(before);
        }
        const limitInt = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
        msgQuery += ` ORDER BY m.created_at DESC LIMIT ${limitInt}`;
        const [rowsDesc] = await db.query(msgQuery, params);
        const rows = rowsDesc.reverse();
        // Charger les réactions pour tous les messages
        const messageIds = rows.map((r) => r.id);
        let reactionsMap = {};
        if (messageIds.length > 0) {
            const placeholders = messageIds.map(() => '?').join(',');
            const [reactionRows] = await db.query(`SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (${placeholders})`, messageIds);
            for (const r of reactionRows) {
                if (!reactionsMap[r.message_id])
                    reactionsMap[r.message_id] = [];
                reactionsMap[r.message_id].push({ emoji: r.emoji, userId: r.user_id });
            }
        }
        // Retourner les ciphertexts opaques — AUCUN déchiffrement côté serveur
        const messages = rows.map((row) => ({
            id: row.id,
            conversationId: row.conversationId,
            senderId: row.senderId,
            authorId: row.senderId,
            content: row.content, // ciphertext Signal pour le destinataire
            senderContent: row.senderContent, // ciphertext Signal pour l'expéditeur
            e2eeType: row.e2eeType, // 1 = Whisper, 3 = PreKey, null = non chiffré
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
    }
    catch (error) {
        console.error('Erreur récupération messages:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Créer un message Signal E2EE
exports.messagesRouter.post('/', (0, express_validator_1.body)('conversationId').isString().notEmpty(), (0, express_validator_1.body)('senderId').isUUID(), (0, express_validator_1.body)('content').notEmpty().isLength({ max: 65535 }), // ciphertext Signal
(0, express_validator_1.body)('senderContent').optional().isString(), // ciphertext pour l'expéditeur
(0, express_validator_1.body)('e2eeType').optional().isIn([1, 3]), // type Signal
(0, express_validator_1.body)('replyToId').optional().isUUID(), validate_1.validateRequest, messages_controller_1.messageController.create.bind(messages_controller_1.messageController));
// Récupérer les messages d'une conversation
exports.messagesRouter.get('/conversation/:conversationId', (0, express_validator_1.param)('conversationId').isString().notEmpty(), (0, express_validator_1.query)('limit').optional().isInt({ min: 1, max: 100 }), (0, express_validator_1.query)('before').optional().isISO8601(), validate_1.validateRequest, messages_controller_1.messageController.getByConversation.bind(messages_controller_1.messageController));
// Récupérer un message par ID
exports.messagesRouter.get('/:messageId', (0, express_validator_1.param)('messageId').isUUID(), validate_1.validateRequest, messages_controller_1.messageController.getById.bind(messages_controller_1.messageController));
// Mettre à jour un message (édition — nouveaux ciphertexts Signal)
exports.messagesRouter.patch('/:messageId', (0, express_validator_1.param)('messageId').isUUID(), (0, express_validator_1.body)('content').notEmpty().isLength({ max: 65535 }), (0, express_validator_1.body)('senderContent').optional().isString(), (0, express_validator_1.body)('e2eeType').optional().isIn([1, 3]), validate_1.validateRequest, messages_controller_1.messageController.update.bind(messages_controller_1.messageController));
// Supprimer un message
exports.messagesRouter.delete('/:messageId', (0, express_validator_1.param)('messageId').isUUID(), validate_1.validateRequest, messages_controller_1.messageController.delete.bind(messages_controller_1.messageController));
// Ajouter une réaction
exports.messagesRouter.post('/:messageId/reactions', (0, express_validator_1.param)('messageId').isUUID(), (0, express_validator_1.body)('emoji').isString().isLength({ min: 1, max: 50 }), validate_1.validateRequest, messages_controller_1.messageController.addReaction.bind(messages_controller_1.messageController));
// Supprimer une réaction
exports.messagesRouter.delete('/:messageId/reactions/:emoji', (0, express_validator_1.param)('messageId').isUUID(), validate_1.validateRequest, messages_controller_1.messageController.removeReaction.bind(messages_controller_1.messageController));
// Marquer comme lu
exports.messagesRouter.post('/conversation/:conversationId/read', (0, express_validator_1.param)('conversationId').isUUID(), validate_1.validateRequest, messages_controller_1.messageController.markAsRead.bind(messages_controller_1.messageController));
//# sourceMappingURL=messages.js.map