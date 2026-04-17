"use strict";
// ==========================================
// ALFYCHAT - ROUTES MESSAGES (Signal Protocol E2EE)
// Le serveur est un relais opaque — pas de déchiffrement côté serveur.
// ==========================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.messagesRouter = void 0;
const express_1 = require("express");
const express_validator_1 = require("express-validator");
const messages_controller_1 = require("../controllers/messages.controller");
const validate_1 = require("../middleware/validate");
const auth_1 = require("../middleware/auth");
const internal_1 = require("../middleware/internal");
const database_1 = require("../database");
const redis_1 = require("../redis");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const uuid_1 = require("uuid");
const VOICE_UPLOAD_DIR = path_1.default.join(process.env.UPLOADS_DIR || '/uploads', 'voice');
if (!fs_1.default.existsSync(VOICE_UPLOAD_DIR)) {
    fs_1.default.mkdirSync(VOICE_UPLOAD_DIR, { recursive: true });
}
const voiceStorage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, VOICE_UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, `${(0, uuid_1.v4)()}.ogg`),
});
const voiceUpload = (0, multer_1.default)({
    storage: voiceStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
    fileFilter: (_req, file, cb) => {
        const allowed = ['audio/ogg', 'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        }
        else {
            cb(new Error('Format audio non supporté'));
        }
    },
});
// TTL du cache messages (secondes). Court pour rester cohérent avec le temps réel.
const MSG_CACHE_TTL = 4;
exports.messagesRouter = (0, express_1.Router)();
// Récupérer les messages (par channelId ou recipientId)
// Retourne les ciphertexts Signal opaques — le client déchiffre
exports.messagesRouter.get('/', auth_1.authMiddleware, (0, express_validator_1.query)('limit').optional().isInt({ min: 1, max: 100 }), (0, express_validator_1.query)('before').optional().isISO8601(), async (req, res) => {
    try {
        const userId = req.userId;
        const { recipientId, channelId, limit = 50, before } = req.query;
        let conversationId = null;
        if (recipientId) {
            // DM déterministe — le room ID inclut forcément userId
            const sortedIds = [userId, recipientId].sort();
            conversationId = `dm_${sortedIds[0]}_${sortedIds[1]}`;
        }
        else if (channelId) {
            const cid = channelId;
            // Vérifier l'appartenance avant de servir les messages
            if (cid.startsWith('dm_')) {
                // Format dm_UUID1_UUID2 — vérifier que userId est l'un des deux
                if (!cid.includes(userId)) {
                    return res.status(403).json({ error: 'Accès non autorisé' });
                }
            }
            else {
                // Conversation UUID (groupe) — vérifier en base
                const db = (0, database_1.getDatabaseClient)();
                const [rows] = await db.query('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1', [cid, userId]);
                if (rows.length === 0) {
                    return res.status(403).json({ error: 'Accès non autorisé' });
                }
            }
            conversationId = cid;
        }
        if (!conversationId) {
            return res.json([]);
        }
        // ── Cache Redis ──────────────────────────────────────
        const redis = (0, redis_1.getRedisClient)();
        const cacheKey = `msg:${conversationId}:${limit}:${before || ''}`;
        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                res.setHeader('X-Cache', 'HIT');
                return res.json(JSON.parse(cached));
            }
        }
        catch { /* cache miss, continue */ }
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
        // Écrire le résultat en cache Redis (fire-and-forget)
        try {
            await redis.set(cacheKey, JSON.stringify(messages), MSG_CACHE_TTL);
        }
        catch { /* non-bloquant */ }
        res.setHeader('X-Cache', 'MISS');
        res.json(messages);
    }
    catch (error) {
        console.error('Erreur récupération messages:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Créer un message Signal E2EE (appel interne gateway → messages)
exports.messagesRouter.post('/', internal_1.internalOnly, (0, express_validator_1.body)('id').optional().isUUID(), (0, express_validator_1.body)('conversationId').isString().notEmpty(), (0, express_validator_1.body)('senderId').isUUID(), (0, express_validator_1.body)('content').notEmpty().isLength({ max: 131072 }), // ciphertext Signal (ECDH peut être grand)
(0, express_validator_1.body)('senderContent').optional().isString().isLength({ max: 131072 }), (0, express_validator_1.body)('e2eeType').optional().isIn([1, 3]), // type Signal
(0, express_validator_1.body)('replyToId').optional().isUUID(), validate_1.validateRequest, messages_controller_1.messageController.create.bind(messages_controller_1.messageController));
// Rechercher des messages dans une conversation (uniquement non-E2EE)
exports.messagesRouter.get('/search', auth_1.authMiddleware, (0, express_validator_1.query)('conversationId').isString().notEmpty(), (0, express_validator_1.query)('q').isString().isLength({ min: 1, max: 200 }), (0, express_validator_1.query)('limit').optional().isInt({ min: 1, max: 50 }), (0, express_validator_1.query)('before').optional().isISO8601(), validate_1.validateRequest, async (req, res, next) => {
    try {
        const userId = req.userId;
        const conversationId = req.query.conversationId;
        // Vérifier l'accès
        if (conversationId.startsWith('dm_')) {
            if (!conversationId.includes(userId)) {
                return res.status(403).json({ error: 'Accès non autorisé' });
            }
        }
        else {
            const db = (0, database_1.getDatabaseClient)();
            const [rows] = await db.query('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1', [conversationId, userId]);
            if (rows.length === 0) {
                return res.status(403).json({ error: 'Accès non autorisé' });
            }
        }
        next();
    }
    catch {
        res.status(500).json({ error: 'Erreur serveur' });
    }
}, messages_controller_1.messageController.search.bind(messages_controller_1.messageController));
// Récupérer les messages d'une conversation
exports.messagesRouter.get('/conversation/:conversationId', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString().notEmpty(), (0, express_validator_1.query)('limit').optional().isInt({ min: 1, max: 100 }), (0, express_validator_1.query)('before').optional().isISO8601(), validate_1.validateRequest, async (req, res, next) => {
    try {
        const userId = req.userId;
        const { conversationId } = req.params;
        if (conversationId.startsWith('dm_')) {
            if (!conversationId.includes(userId)) {
                return res.status(403).json({ error: 'Accès non autorisé' });
            }
        }
        else {
            const db = (0, database_1.getDatabaseClient)();
            const [rows] = await db.query('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1', [conversationId, userId]);
            if (rows.length === 0) {
                return res.status(403).json({ error: 'Accès non autorisé' });
            }
        }
        next();
    }
    catch {
        res.status(500).json({ error: 'Erreur serveur' });
    }
}, messages_controller_1.messageController.getByConversation.bind(messages_controller_1.messageController));
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
// ============ MESSAGES VOCAUX ============
// Envoyer un message vocal (clip audio)
exports.messagesRouter.post('/voice', auth_1.authMiddleware, voiceUpload.single('audio'), async (req, res) => {
    try {
        const userId = req.userId;
        const { conversationId, duration } = req.body;
        if (!req.file) {
            return res.status(400).json({ error: 'Fichier audio requis' });
        }
        if (!conversationId) {
            return res.status(400).json({ error: 'conversationId requis' });
        }
        const db = (0, database_1.getDatabaseClient)();
        // Vérifier l'accès à la conversation
        if (!conversationId.startsWith('dm_')) {
            const [rows] = await db.query('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1', [conversationId, userId]);
            if (rows.length === 0) {
                fs_1.default.unlinkSync(req.file.path);
                return res.status(403).json({ error: 'Accès non autorisé' });
            }
        }
        else if (!conversationId.includes(userId)) {
            fs_1.default.unlinkSync(req.file.path);
            return res.status(403).json({ error: 'Accès non autorisé' });
        }
        const messageId = (0, uuid_1.v4)();
        const voiceUrl = `/uploads/voice/${req.file.filename}`;
        const voiceDuration = parseInt(duration) || null;
        await db.execute(`INSERT INTO messages (id, conversation_id, sender_id, content, message_type, voice_url, voice_duration)
         VALUES (?, ?, ?, '', 'voice', ?, ?)`, [messageId, conversationId, userId, voiceUrl, voiceDuration]);
        // Invalider le cache Redis de la conversation
        const redis = (0, redis_1.getRedisClient)();
        const cachePattern = `msg:${conversationId}:*`;
        try {
            const keys = await redis.keys(cachePattern);
            if (keys.length)
                await redis.del(...keys);
        }
        catch { /* non-bloquant */ }
        res.status(201).json({
            id: messageId,
            conversationId,
            senderId: userId,
            messageType: 'voice',
            voiceUrl,
            voiceDuration,
            createdAt: new Date().toISOString(),
        });
    }
    catch (error) {
        if (req.file?.path) {
            try {
                fs_1.default.unlinkSync(req.file.path);
            }
            catch { /* ignore */ }
        }
        console.error('Erreur message vocal:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// ============ SUPPRESSION RGPD — Messages d'un utilisateur ============
// Supprimer tous les messages d'un utilisateur (appelé par le service users/RGPD)
exports.messagesRouter.delete('/user/:userId/all', auth_1.authMiddleware, async (req, res) => {
    try {
        const requesterId = req.userId;
        const { userId } = req.params;
        // Seul l'utilisateur lui-même ou un admin peut faire cette demande
        if (requesterId !== userId) {
            return res.status(403).json({ error: 'Non autorisé' });
        }
        const db = (0, database_1.getDatabaseClient)();
        await db.execute(`UPDATE messages SET content = '[Message supprimé]', sender_content = NULL, is_deleted = TRUE
         WHERE sender_id = ?`, [userId]);
        res.json({ success: true, message: 'Tous vos messages ont été supprimés.' });
    }
    catch (error) {
        console.error('Erreur suppression messages RGPD:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
//# sourceMappingURL=messages.js.map