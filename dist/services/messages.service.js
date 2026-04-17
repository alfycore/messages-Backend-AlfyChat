"use strict";
// ==========================================
// ALFYCHAT - SERVICE MESSAGES (Signal Protocol E2EE)
// Le serveur stocke uniquement des ciphertexts opaques Signal.
// Tout le chiffrement/déchiffrement se fait côté client.
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageService = exports.MessageService = void 0;
const uuid_1 = require("uuid");
const database_1 = require("../database");
const redis_1 = require("../redis");
const dm_archive_service_1 = require("./dm-archive.service");
const dmArchiveService = new dm_archive_service_1.DMArchiveService();
class MessageService {
    get db() {
        return (0, database_1.getDatabaseClient)();
    }
    get redis() {
        return (0, redis_1.getRedisClient)();
    }
    // Rechercher des messages dans une conversation (LIKE sur content, uniquement non-E2EE)
    async search(conversationId, searchQuery, _userId, limit = 30, before) {
        const safeLimit = Math.min(Math.max(Math.floor(limit) || 30, 1), 50);
        const likePattern = `%${searchQuery.replace(/[%_\\]/g, '\\$&')}%`;
        let query = `
      SELECT m.id, m.conversation_id, m.sender_id,
             m.content, m.sender_content, m.e2ee_type,
             m.nonce, m.reply_to_id, m.is_edited, m.is_deleted,
             m.created_at, m.updated_at,
             u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = ? AND m.is_deleted = FALSE
        AND m.e2ee_type IS NULL
        AND m.content LIKE ?
    `;
        const params = [conversationId, likePattern];
        if (before) {
            query += ' AND m.created_at < ?';
            params.push(before);
        }
        query += ` ORDER BY m.created_at DESC LIMIT ${safeLimit}`;
        const [rows] = await this.db.query(query, params);
        const messages = rows;
        return Promise.all(messages.map(async (msg) => {
            const reactions = await this.getReactions(msg.id);
            return this.formatMessage(msg, reactions);
        }));
    }
    // Créer un message — accepte des ciphertexts Signal E2EE opaques
    // Si dto.id est fourni (pré-généré par le gateway pour livraison optimiste), l'utilise directement.
    async create(dto) {
        const messageId = dto.id || (0, uuid_1.v4)();
        // Récupérer les participants de la conversation
        let [participants] = await this.db.query('SELECT user_id FROM conversation_participants WHERE conversation_id = ?', [dto.conversationId]);
        // Si la conversation n'existe pas (DM), la créer automatiquement
        if (participants.length === 0 && dto.conversationId.startsWith('dm_')) {
            const userIds = dto.conversationId.replace('dm_', '').split('_');
            try {
                await this.db.execute(`INSERT INTO conversations (id, type, created_at, updated_at)
           VALUES (?, 'direct', NOW(), NOW())
           ON DUPLICATE KEY UPDATE updated_at = NOW()`, [dto.conversationId]);
                for (const userId of userIds) {
                    await this.db.execute(`INSERT INTO conversation_participants (conversation_id, user_id, joined_at)
             VALUES (?, ?, NOW())
             ON DUPLICATE KEY UPDATE joined_at = joined_at`, [dto.conversationId, userId]);
                }
            }
            catch (error) {
                console.error('❌ Erreur création conversation DM:', error);
                throw error;
            }
            [participants] = await this.db.query('SELECT user_id FROM conversation_participants WHERE conversation_id = ?', [dto.conversationId]);
        }
        if (participants.length === 0) {
            throw new Error('Conversation non trouvée');
        }
        // Stocker le ciphertext Signal opaque (le serveur ne déchiffre JAMAIS)
        // content       = ciphertext pour le destinataire
        // sender_content = ciphertext pour l'expéditeur (lui permet de relire ses propres messages)
        await this.db.execute(`INSERT INTO messages (id, conversation_id, sender_id, content, sender_content, e2ee_type, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            messageId,
            dto.conversationId,
            dto.senderId,
            dto.content,
            dto.senderContent ?? null,
            dto.e2eeType ?? null,
            dto.replyToId ?? null,
        ]);
        await this.db.execute('UPDATE conversations SET updated_at = NOW() WHERE id = ?', [dto.conversationId]);
        // Système hybride DM : vérifier quota après création (fire-and-forget — non bloquant)
        let archiveEvent = null;
        if (dto.conversationId.startsWith('dm_')) {
            try {
                await this.redis.del(`dm:stats:${dto.conversationId}`);
                archiveEvent = await dmArchiveService.checkAndArchiveAfterCreate(dto.conversationId);
            }
            catch (e) {
                // Non-bloquant : le message est bien sauvegardé, l'erreur cache/archive est ignorée
                console.warn('[Messages] Redis/archive post-create non-bloquant:', e);
            }
        }
        const message = {
            id: messageId,
            conversationId: dto.conversationId,
            senderId: dto.senderId,
            content: dto.content,
            senderContent: dto.senderContent,
            e2eeType: dto.e2eeType,
            replyToId: dto.replyToId,
            isEdited: false,
            isDeleted: false,
            createdAt: new Date(),
            reactions: [],
            readBy: [dto.senderId],
        };
        if (archiveEvent) {
            message.archiveEvent = archiveEvent;
        }
        return message;
    }
    // Récupérer les messages d'une conversation — retourne les ciphertexts Signal opaques
    async getByConversation(conversationId, _userId, limit = 50, before) {
        let query = `
      SELECT m.id, m.conversation_id, m.sender_id,
             m.content, m.sender_content, m.e2ee_type,
             m.nonce, m.reply_to_id, m.is_edited, m.is_deleted,
             m.created_at, m.updated_at,
             u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = ? AND m.is_deleted = FALSE
    `;
        const params = [conversationId];
        if (before) {
            query += ' AND m.created_at < ?';
            params.push(before);
        }
        const safeLimit = Math.min(Math.max(Math.floor(limit) || 50, 1), 100);
        query += ` ORDER BY m.created_at DESC LIMIT ${safeLimit}`;
        const [rows] = await this.db.query(query, params);
        const messages = rows;
        return Promise.all(messages.map(async (msg) => {
            const reactions = await this.getReactions(msg.id);
            return this.formatMessage(msg, reactions);
        }));
    }
    // Récupérer un message par ID
    async getById(messageId, _userId) {
        const [rows] = await this.db.query(`SELECT m.id, m.conversation_id, m.sender_id,
              m.content, m.sender_content, m.e2ee_type,
              m.nonce, m.reply_to_id, m.is_edited, m.is_deleted,
              m.created_at, m.updated_at,
              u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.id = ?`, [messageId]);
        const messages = rows;
        if (messages.length === 0)
            return null;
        const reactions = await this.getReactions(messageId);
        return this.formatMessage(messages[0], reactions);
    }
    // Mettre à jour un message — accepte les nouveaux ciphertexts Signal du client
    async update(messageId, senderId, dto) {
        const [rows] = await this.db.query('SELECT id FROM messages WHERE id = ? AND sender_id = ?', [messageId, senderId]);
        if (rows.length === 0)
            return null;
        await this.db.execute(`UPDATE messages
       SET content = ?, sender_content = ?, e2ee_type = ?, is_edited = TRUE, updated_at = NOW()
       WHERE id = ?`, [dto.content, dto.senderContent ?? null, dto.e2eeType ?? null, messageId]);
        return this.getById(messageId, senderId);
    }
    // Supprimer un message (soft delete)
    async delete(messageId, senderId) {
        const result = await this.db.execute('UPDATE messages SET is_deleted = TRUE, content = "[Message supprimé]" WHERE id = ? AND sender_id = ?', [messageId, senderId]);
        return (result[0]).affectedRows > 0;
    }
    // Ajouter une réaction
    async addReaction(messageId, userId, emoji) {
        await this.db.execute(`INSERT IGNORE INTO message_reactions (id, message_id, user_id, emoji)
       VALUES (?, ?, ?, ?)`, [(0, uuid_1.v4)(), messageId, userId, emoji]);
    }
    // Supprimer une réaction
    async removeReaction(messageId, userId, emoji) {
        await this.db.execute('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageId, userId, emoji]);
    }
    // Marquer comme lu
    async markAsRead(conversationId, userId) {
        await this.db.execute(`UPDATE conversation_participants SET last_read_at = NOW()
       WHERE conversation_id = ? AND user_id = ?`, [conversationId, userId]);
    }
    // Récupérer le nombre de messages non lus
    async getUnreadCount(conversationId, userId) {
        const [rows] = await this.db.query(`SELECT COUNT(*) as count FROM messages m
       JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id
       WHERE m.conversation_id = ? AND cp.user_id = ?
       AND m.created_at > COALESCE(cp.last_read_at, '1970-01-01')
       AND m.sender_id != ?`, [conversationId, userId, userId]);
        return rows[0]?.count || 0;
    }
    // Helpers privés
    async getReactions(messageId) {
        const [rows] = await this.db.query('SELECT user_id, emoji, created_at FROM message_reactions WHERE message_id = ?', [messageId]);
        return rows.map(r => ({
            userId: r.user_id,
            emoji: r.emoji,
            createdAt: r.created_at,
        }));
    }
    // Retourne le message avec ses ciphertexts Signal opaques — le client déchiffre
    formatMessage(row, reactions) {
        return {
            id: row.id,
            conversationId: row.conversation_id,
            senderId: row.sender_id,
            content: row.content,
            senderContent: row.sender_content ?? undefined,
            e2eeType: row.e2ee_type ?? undefined,
            replyToId: row.reply_to_id,
            isEdited: Boolean(row.is_edited),
            isDeleted: Boolean(row.is_deleted),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            reactions,
            readBy: [],
            sender: row.sender_username ? {
                id: row.sender_id,
                username: row.sender_username,
                displayName: row.sender_display_name,
                avatarUrl: row.sender_avatar,
            } : undefined,
        };
    }
}
exports.MessageService = MessageService;
exports.messageService = new MessageService();
//# sourceMappingURL=messages.service.js.map