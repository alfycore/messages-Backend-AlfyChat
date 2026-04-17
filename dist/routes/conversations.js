"use strict";
// ==========================================
// ALFYCHAT - ROUTES CONVERSATIONS (Group DM)
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.conversationsRouter = void 0;
const express_1 = require("express");
const express_validator_1 = require("express-validator");
const conversations_controller_1 = require("../controllers/conversations.controller");
const validate_1 = require("../middleware/validate");
const auth_1 = require("../middleware/auth");
const database_1 = require("../database");
const conversations_service_1 = require("../services/conversations.service");
exports.conversationsRouter = (0, express_1.Router)();
const conversationService = new conversations_service_1.ConversationService();
// ============ GET / — Toutes les conversations de l'utilisateur connecté ============
exports.conversationsRouter.get('/', async (req, res, next) => {
    // Accepter soit un JWT (frontend), soit un x-user-id header (appel gateway interne)
    const internalUserId = req.headers['x-user-id'];
    if (internalUserId && !req.headers.authorization) {
        req.userId = internalUserId;
        return next();
    }
    return (0, auth_1.authMiddleware)(req, res, next);
}, async (req, res) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ error: 'Non authentifié' });
        }
        // Récupérer les conversations via le service
        const conversations = await conversationService.getByUser(userId);
        // Formater la réponse
        const result = conversations.map(conv => {
            const recipientId = conv.type === 'dm'
                ? conv.participantIds.find((id) => id !== userId)
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
    }
    catch (error) {
        console.error('Erreur récupération conversations:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// ============ POST / — Créer une conversation ============
exports.conversationsRouter.post('/', (0, express_validator_1.body)('type').isIn(['dm', 'group']), (0, express_validator_1.body)('participantIds').isArray({ min: 2 }), (0, express_validator_1.body)('participantIds.*').isString(), (0, express_validator_1.body)('name').optional().isString().isLength({ max: 100 }), (0, express_validator_1.body)('avatarUrl').optional().isString(), validate_1.validateRequest, conversations_controller_1.conversationController.create.bind(conversations_controller_1.conversationController));
// ============ POST /dm — Trouver ou créer un DM ============
exports.conversationsRouter.post('/dm', auth_1.authMiddleware, (0, express_validator_1.body)('recipientId').isString(), validate_1.validateRequest, async (req, res) => {
    try {
        const userId = req.userId;
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
    }
    catch (error) {
        console.error('Erreur création DM:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// ============ GET /user/:userId — Conversations d'un utilisateur ============
exports.conversationsRouter.get('/user/:userId', auth_1.authMiddleware, (0, express_validator_1.param)('userId').isString(), validate_1.validateRequest, conversations_controller_1.conversationController.getByUser.bind(conversations_controller_1.conversationController));
// ============ GET /:conversationId — Récupérer une conversation ============
exports.conversationsRouter.get('/:conversationId', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString(), validate_1.validateRequest, conversations_controller_1.conversationController.getById.bind(conversations_controller_1.conversationController));
// ============ PATCH /:conversationId — Mettre à jour (nom, avatar) ============
exports.conversationsRouter.patch('/:conversationId', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString(), (0, express_validator_1.body)('name').optional().isString().isLength({ max: 100 }), (0, express_validator_1.body)('avatarUrl').optional().isString(), validate_1.validateRequest, conversations_controller_1.conversationController.update.bind(conversations_controller_1.conversationController));
// ============ GET /:conversationId/participants/:userId/check — Vérifier appartenance (interne) ============
exports.conversationsRouter.get('/:conversationId/participants/:userId/check', (0, express_validator_1.param)('conversationId').isString(), (0, express_validator_1.param)('userId').isString(), validate_1.validateRequest, async (req, res) => {
    try {
        const { conversationId, userId } = req.params;
        const isParticipant = await conversationService.isParticipant(conversationId, userId);
        res.json({ isParticipant });
    }
    catch {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// ============ POST /:conversationId/participants — Ajouter un participant ============
exports.conversationsRouter.post('/:conversationId/participants', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString(), (0, express_validator_1.body)('userId').isString(), validate_1.validateRequest, conversations_controller_1.conversationController.addParticipant.bind(conversations_controller_1.conversationController));
// ============ DELETE /:conversationId/participants/:userId — Retirer un participant ============
exports.conversationsRouter.delete('/:conversationId/participants/:userId', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString(), (0, express_validator_1.param)('userId').isString(), validate_1.validateRequest, conversations_controller_1.conversationController.removeParticipant.bind(conversations_controller_1.conversationController));
// ============ POST /:conversationId/leave — Quitter un groupe ============
exports.conversationsRouter.post('/:conversationId/leave', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString(), validate_1.validateRequest, conversations_controller_1.conversationController.leave.bind(conversations_controller_1.conversationController));
// ============ DELETE /:conversationId — Supprimer une conversation ============
exports.conversationsRouter.delete('/:conversationId', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString(), validate_1.validateRequest, conversations_controller_1.conversationController.delete.bind(conversations_controller_1.conversationController));
// ============ ÉPINGLAGE DE DMs ============
// Épingler une conversation (stocké dans le service users, mais exposé ici pour commodité)
// Le frontend appellera directement l'API users pour les DMs épinglés
// Cette route est un alias qui redirige vers la logique users via header interne
exports.conversationsRouter.post('/:conversationId/pin', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString(), validate_1.validateRequest, async (req, res) => {
    try {
        const userId = req.userId;
        const { conversationId } = req.params;
        const db = (0, database_1.getDatabaseClient)();
        // Calculer le prochain pin_order
        const [posRows] = await db.query('SELECT COALESCE(MAX(pin_order),-1) as maxOrd FROM pinned_conversations WHERE user_id = ?', [userId]);
        const pinOrder = (posRows[0]?.maxOrd ?? -1) + 1;
        await db.execute(`INSERT IGNORE INTO pinned_conversations (user_id, conversation_id, pin_order) VALUES (?, ?, ?)`, [userId, conversationId, pinOrder]);
        res.json({ success: true, pinOrder });
    }
    catch {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
exports.conversationsRouter.delete('/:conversationId/pin', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString(), validate_1.validateRequest, async (req, res) => {
    try {
        const userId = req.userId;
        const { conversationId } = req.params;
        const db = (0, database_1.getDatabaseClient)();
        await db.execute('DELETE FROM pinned_conversations WHERE user_id = ? AND conversation_id = ?', [userId, conversationId]);
        res.json({ success: true });
    }
    catch {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Récupérer les conversations épinglées de l'utilisateur connecté
exports.conversationsRouter.get('/pinned', auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const db = (0, database_1.getDatabaseClient)();
        const [rows] = await db.query('SELECT conversation_id, pin_order FROM pinned_conversations WHERE user_id = ? ORDER BY pin_order ASC', [userId]);
        res.json(rows.map(r => ({ conversationId: r.conversation_id, pinOrder: r.pin_order })));
    }
    catch {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
//# sourceMappingURL=conversations.js.map