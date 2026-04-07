import type { DMConversationStats, DMArchiveEntry, DMArchivePushEvent, DMArchiveStatus } from '../types/dm-archive';
export declare class DMArchiveService {
    private get db();
    private get redis();
    /**
     * Récupère ou calcule les stats d'une conversation DM
     */
    getConversationStats(conversationId: string): Promise<DMConversationStats>;
    /**
     * Vérifie si le quota est dépassé et retourne le nombre de MP à archiver
     */
    checkQuota(conversationId: string): Promise<{
        exceeded: boolean;
        reason?: 'quota_exceeded' | 'age_exceeded';
        messagesToArchive: number;
    }>;
    /**
     * Retourne le statut d'archive pour un client
     */
    getArchiveStatus(conversationId: string): Promise<DMArchiveStatus>;
    /**
     * Archive les messages les plus anciens d'une conversation
     * Retourne les messages à pousser vers les peers
     */
    archiveOldMessages(conversationId: string, count: number, reason: 'quota_exceeded' | 'age_exceeded' | 'purge_inactive'): Promise<DMArchivePushEvent | null>;
    /**
     * Confirme que les peers ont bien reçu les messages archivés
     * Supprime alors les messages de la DB serveur
     */
    confirmArchive(conversationId: string, archiveLogId: string, peerId: string): Promise<boolean>;
    /**
     * Cherche un message archivé dans le cache Redis
     * Si trouvé, le retourne. Sinon, retourne null (il faudra demander aux peers)
     */
    getCachedArchivedMessage(messageId: string): Promise<DMArchiveEntry | null>;
    /**
     * Met en cache un message récupéré d'un peer (Redis 24h)
     */
    cacheArchivedMessage(message: DMArchiveEntry): Promise<void>;
    /**
     * Met en cache plusieurs messages récupérés d'un peer
     */
    cacheBulkArchivedMessages(messages: DMArchiveEntry[]): Promise<void>;
    /**
     * Identifie les conversations DM inactives et les purge
     * Règle: Si <10 MP dans les 20 derniers jours → garder seulement 10-20 MP
     */
    purgeInactiveConversations(): Promise<{
        purgedConversations: number;
        totalMessagesPurged: number;
        archiveEvents: DMArchivePushEvent[];
    }>;
    /**
     * Vérifie et archive automatiquement après chaque nouveau message
     * Appelé par MessageService.create()
     */
    checkAndArchiveAfterCreate(conversationId: string): Promise<DMArchivePushEvent | null>;
    /**
     * Tâche de maintenance quotidienne
     * - Purge des conversations inactives
     * - Archivage des MP >30 jours
     * - Nettoyage des caches expirés
     */
    runDailyMaintenance(): Promise<{
        purgeResult: Awaited<ReturnType<DMArchiveService['purgeInactiveConversations']>>;
        ageArchiveCount: number;
    }>;
}
export declare const dmArchiveService: DMArchiveService;
//# sourceMappingURL=dm-archive.service.d.ts.map