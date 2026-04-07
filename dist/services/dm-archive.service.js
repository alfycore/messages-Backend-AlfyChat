"use strict";
// ==========================================
// ALFYCHAT - SERVICE D'ARCHIVAGE DM HYBRIDE
// Gestion du quota 20k/30j + push P2P + purge
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.dmArchiveService = exports.DMArchiveService = void 0;
const uuid_1 = require("uuid");
const database_1 = require("../database");
const redis_1 = require("../redis");
const logger_1 = require("../utils/logger");
const dm_archive_1 = require("../types/dm-archive");
class DMArchiveService {
    get db() {
        return (0, database_1.getDatabaseClient)();
    }
    get redis() {
        return (0, redis_1.getRedisClient)();
    }
    // ============================================================
    // STATS & QUOTA
    // ============================================================
    /**
     * Récupère ou calcule les stats d'une conversation DM
     */
    async getConversationStats(conversationId) {
        // Essayer le cache Redis d'abord
        const cached = await this.redis.get(`dm:stats:${conversationId}`);
        if (cached) {
            return JSON.parse(cached);
        }
        // Calculer depuis la DB
        const [rows] = await this.db.query(`SELECT 
        COUNT(*) as message_count,
        MIN(created_at) as oldest_message_at,
        MAX(created_at) as newest_message_at,
        MAX(created_at) as last_activity_at,
        SUM(CASE WHEN created_at > DATE_SUB(NOW(), INTERVAL 20 DAY) THEN 1 ELSE 0 END) as recent_activity_count
       FROM messages 
       WHERE conversation_id = ? AND is_deleted = FALSE`, [conversationId]);
        const row = rows[0];
        // Récupérer le count archivé
        const [archRows] = await this.db.query(`SELECT COALESCE(SUM(messages_archived), 0) as archived_count 
       FROM dm_archive_log WHERE conversation_id = ?`, [conversationId]);
        const stats = {
            conversationId,
            messageCount: row?.message_count || 0,
            oldestMessageAt: row?.oldest_message_at || new Date(),
            newestMessageAt: row?.newest_message_at || new Date(),
            lastActivityAt: row?.last_activity_at || new Date(),
            archivedCount: archRows[0]?.archived_count || 0,
            recentActivityCount: row?.recent_activity_count || 0,
        };
        // Mettre à jour la table de stats
        await this.db.execute(`INSERT INTO dm_conversation_stats 
        (conversation_id, message_count, oldest_message_at, newest_message_at, 
         last_activity_at, archived_count, recent_activity_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        message_count = VALUES(message_count),
        oldest_message_at = VALUES(oldest_message_at),
        newest_message_at = VALUES(newest_message_at),
        last_activity_at = VALUES(last_activity_at),
        archived_count = VALUES(archived_count),
        recent_activity_count = VALUES(recent_activity_count)`, [
            conversationId, stats.messageCount, stats.oldestMessageAt,
            stats.newestMessageAt, stats.lastActivityAt,
            stats.archivedCount, stats.recentActivityCount,
        ]);
        // Cache 5 minutes
        await this.redis.set(`dm:stats:${conversationId}`, JSON.stringify(stats), 300);
        return stats;
    }
    /**
     * Vérifie si le quota est dépassé et retourne le nombre de MP à archiver
     */
    async checkQuota(conversationId) {
        const stats = await this.getConversationStats(conversationId);
        // Vérifier quota nombre de messages (>20k)
        if (stats.messageCount > dm_archive_1.DM_QUOTA_MAX_MESSAGES) {
            const excess = stats.messageCount - dm_archive_1.DM_QUOTA_MAX_MESSAGES;
            return {
                exceeded: true,
                reason: 'quota_exceeded',
                messagesToArchive: excess + 1000, // Archiver 1000 de plus pour avoir de la marge
            };
        }
        // Vérifier quota âge (>30 jours)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - dm_archive_1.DM_QUOTA_MAX_DAYS);
        const [oldRows] = await this.db.query(`SELECT COUNT(*) as count FROM messages 
       WHERE conversation_id = ? AND created_at < ? AND is_deleted = FALSE`, [conversationId, thirtyDaysAgo]);
        const oldCount = oldRows[0]?.count || 0;
        if (oldCount > 0) {
            return {
                exceeded: true,
                reason: 'age_exceeded',
                messagesToArchive: oldCount,
            };
        }
        return { exceeded: false, messagesToArchive: 0 };
    }
    /**
     * Retourne le statut d'archive pour un client
     */
    async getArchiveStatus(conversationId) {
        const stats = await this.getConversationStats(conversationId);
        const quotaPercent = (stats.messageCount / dm_archive_1.DM_QUOTA_MAX_MESSAGES) * 100;
        return {
            conversationId,
            serverMessageCount: stats.messageCount,
            localMessageCount: 0, // Sera rempli côté client
            oldestServerMessage: stats.oldestMessageAt,
            oldestLocalMessage: undefined,
            quotaUsagePercent: Math.min(quotaPercent, 100),
        };
    }
    // ============================================================
    // ARCHIVAGE (Push vers P2P)
    // ============================================================
    /**
     * Archive les messages les plus anciens d'une conversation
     * Retourne les messages à pousser vers les peers
     */
    async archiveOldMessages(conversationId, count, reason) {
        // Récupérer les N messages les plus anciens
        const [rows] = await this.db.query(`SELECT m.id, m.conversation_id, m.sender_id, m.content, 
              m.nonce, m.reply_to_id,
              m.created_at
       FROM messages m
       WHERE m.conversation_id = ? AND m.is_deleted = FALSE
       ORDER BY m.created_at ASC
       LIMIT ?`, [conversationId, count]);
        const messages = rows;
        if (messages.length === 0)
            return null;
        // Construire les entrées d'archive
        const archiveEntries = messages.map(msg => ({
            messageId: msg.id,
            conversationId: msg.conversation_id,
            senderId: msg.sender_id,
            content: msg.content,
            nonce: msg.nonce,
            encryptionKey: '',
            replyToId: msg.reply_to_id,
            createdAt: msg.created_at,
            archivedAt: new Date(),
        }));
        // Logger l'archivage
        const archiveLogId = (0, uuid_1.v4)();
        await this.db.execute(`INSERT INTO dm_archive_log (id, conversation_id, messages_archived, oldest_message_at, newest_message_at, reason)
       VALUES (?, ?, ?, ?, ?, ?)`, [
            archiveLogId,
            conversationId,
            messages.length,
            messages[0].created_at,
            messages[messages.length - 1].created_at,
            reason,
        ]);
        // Supprimer les messages archivés de la DB (après confirmation push)
        // On ne supprime PAS encore - on attend la confirmation des peers
        // Marquer les messages comme "en cours d'archivage" dans Redis
        const messageIds = messages.map(m => m.id);
        await this.redis.set(`dm:archiving:${conversationId}:${archiveLogId}`, JSON.stringify(messageIds), 3600 // 1h timeout pour la confirmation
        );
        logger_1.logger.info(`📦 Archivage DM: ${messages.length} MP de ${conversationId} (${reason})`);
        return {
            conversationId,
            messages: archiveEntries,
            reason,
            totalArchived: messages.length,
        };
    }
    /**
     * Confirme que les peers ont bien reçu les messages archivés
     * Supprime alors les messages de la DB serveur
     */
    async confirmArchive(conversationId, archiveLogId, peerId) {
        const key = `dm:archiving:${conversationId}:${archiveLogId}`;
        const data = await this.redis.get(key);
        if (!data)
            return false;
        // Tracker les confirmations des peers
        const confirmKey = `dm:archive:confirm:${archiveLogId}`;
        const confirmData = await this.redis.get(confirmKey);
        const confirms = confirmData ? JSON.parse(confirmData) : [];
        if (!confirms.includes(peerId)) {
            confirms.push(peerId);
            await this.redis.set(confirmKey, JSON.stringify(confirms), 3600);
        }
        // On a besoin des 2 peers pour confirmer (sender + receiver)
        // Récupérer les participants
        const [participants] = await this.db.query('SELECT user_id FROM conversation_participants WHERE conversation_id = ?', [conversationId]);
        const participantIds = participants.map(p => p.user_id);
        if (confirms.length >= participantIds.length) {
            // Tous les peers ont confirmé → supprimer de la DB
            const messageIds = JSON.parse(data);
            if (messageIds.length > 0) {
                const placeholders = messageIds.map(() => '?').join(',');
                // Supprimer les réactions
                await this.db.execute(`DELETE FROM message_reactions WHERE message_id IN (${placeholders})`, messageIds);
                // Supprimer les messages
                await this.db.execute(`DELETE FROM messages WHERE id IN (${placeholders})`, messageIds);
                logger_1.logger.info(`🗑️ ${messageIds.length} MP supprimés de la DB après confirmation P2P (${conversationId})`);
            }
            // Nettoyer Redis
            await this.redis.del(key);
            await this.redis.del(confirmKey);
            // Invalider le cache stats
            await this.redis.del(`dm:stats:${conversationId}`);
            return true;
        }
        return false;
    }
    // ============================================================
    // RÉCUPÉRATION P2P
    // ============================================================
    /**
     * Cherche un message archivé dans le cache Redis
     * Si trouvé, le retourne. Sinon, retourne null (il faudra demander aux peers)
     */
    async getCachedArchivedMessage(messageId) {
        const cached = await this.redis.get(`dm:cached:msg:${messageId}`);
        if (cached) {
            return JSON.parse(cached);
        }
        return null;
    }
    /**
     * Met en cache un message récupéré d'un peer (Redis 24h)
     */
    async cacheArchivedMessage(message) {
        await this.redis.set(`dm:cached:msg:${message.messageId}`, JSON.stringify(message), dm_archive_1.DM_P2P_CACHE_TTL);
        logger_1.logger.info(`💾 MP ${message.messageId} mis en cache Redis (24h)`);
    }
    /**
     * Met en cache plusieurs messages récupérés d'un peer
     */
    async cacheBulkArchivedMessages(messages) {
        for (const msg of messages) {
            await this.cacheArchivedMessage(msg);
        }
    }
    // ============================================================
    // PURGE INTELLIGENTE
    // ============================================================
    /**
     * Identifie les conversations DM inactives et les purge
     * Règle: Si <10 MP dans les 20 derniers jours → garder seulement 10-20 MP
     */
    async purgeInactiveConversations() {
        let purgedConversations = 0;
        let totalMessagesPurged = 0;
        const archiveEvents = [];
        // Trouver toutes les conversations DM
        const [conversations] = await this.db.query(`SELECT c.id, 
              COUNT(m.id) as total_messages,
              SUM(CASE WHEN m.created_at > DATE_SUB(NOW(), INTERVAL 20 DAY) THEN 1 ELSE 0 END) as recent_messages
       FROM conversations c
       JOIN messages m ON c.id = m.conversation_id AND m.is_deleted = FALSE
       WHERE c.type IN ('direct', 'dm')
       GROUP BY c.id
       HAVING total_messages > ?`, [dm_archive_1.DM_PURGE_INACTIVE_KEEP]);
        for (const conv of conversations) {
            // Vérifier si l'utilisateur est inactif (< seuil dans les 20 derniers jours)
            if (conv.recent_messages < dm_archive_1.DM_PURGE_INACTIVE_THRESHOLD) {
                const messagesToArchive = conv.total_messages - dm_archive_1.DM_PURGE_INACTIVE_KEEP;
                if (messagesToArchive > 0) {
                    const event = await this.archiveOldMessages(conv.id, messagesToArchive, 'purge_inactive');
                    if (event) {
                        archiveEvents.push(event);
                        purgedConversations++;
                        totalMessagesPurged += messagesToArchive;
                    }
                }
            }
        }
        logger_1.logger.info(`🧹 Purge intelligente: ${purgedConversations} conversations, ${totalMessagesPurged} MP archivés`);
        return { purgedConversations, totalMessagesPurged, archiveEvents };
    }
    /**
     * Vérifie et archive automatiquement après chaque nouveau message
     * Appelé par MessageService.create()
     */
    async checkAndArchiveAfterCreate(conversationId) {
        // Ne traiter que les conversations DM
        if (!conversationId.startsWith('dm_'))
            return null;
        const quota = await this.checkQuota(conversationId);
        if (!quota.exceeded)
            return null;
        return this.archiveOldMessages(conversationId, quota.messagesToArchive, quota.reason);
    }
    // ============================================================
    // CRON / MAINTENANCE
    // ============================================================
    /**
     * Tâche de maintenance quotidienne
     * - Purge des conversations inactives
     * - Archivage des MP >30 jours
     * - Nettoyage des caches expirés
     */
    async runDailyMaintenance() {
        logger_1.logger.info('🔧 Début maintenance quotidienne DM...');
        // 1. Purge des inactifs
        const purgeResult = await this.purgeInactiveConversations();
        // 2. Archiver les MP >30 jours pour TOUTES les conversations DM
        let ageArchiveCount = 0;
        const [dmConversations] = await this.db.query(`SELECT DISTINCT conversation_id 
       FROM messages 
       WHERE conversation_id LIKE 'dm_%' 
         AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
         AND is_deleted = FALSE`, [dm_archive_1.DM_QUOTA_MAX_DAYS]);
        for (const conv of dmConversations) {
            const quota = await this.checkQuota(conv.conversation_id);
            if (quota.exceeded && quota.reason === 'age_exceeded') {
                await this.archiveOldMessages(conv.conversation_id, quota.messagesToArchive, 'age_exceeded');
                ageArchiveCount += quota.messagesToArchive;
            }
        }
        logger_1.logger.info(`🔧 Maintenance terminée: ${purgeResult.purgedConversations} purges, ${ageArchiveCount} MP archivés par âge`);
        return { purgeResult, ageArchiveCount };
    }
}
exports.DMArchiveService = DMArchiveService;
exports.dmArchiveService = new DMArchiveService();
//# sourceMappingURL=dm-archive.service.js.map