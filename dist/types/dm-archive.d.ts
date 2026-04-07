export declare const DM_QUOTA_MAX_MESSAGES = 20000;
export declare const DM_QUOTA_MAX_DAYS = 30;
export declare const DM_PURGE_INACTIVE_THRESHOLD = 90;
export declare const DM_PURGE_INACTIVE_KEEP = 500;
export declare const DM_P2P_CACHE_TTL = 3600;
export interface DMConversationStats {
    conversationId: string;
    messageCount: number;
    oldestMessageAt: Date;
    newestMessageAt: Date;
    lastActivityAt: Date;
    archivedCount: number;
    recentActivityCount: number;
}
export interface DMArchiveEntry {
    messageId: string;
    conversationId: string;
    senderId: string;
    content: string;
    nonce?: string;
    encryptionKey: string;
    replyToId?: string;
    createdAt: Date;
    archivedAt: Date;
}
export interface DMArchivePushEvent {
    conversationId: string;
    messages: DMArchiveEntry[];
    reason: 'quota_exceeded' | 'age_exceeded' | 'purge_inactive';
    totalArchived: number;
}
export interface DMArchiveStatus {
    conversationId: string;
    serverMessageCount: number;
    localMessageCount: number;
    oldestServerMessage: Date;
    oldestLocalMessage?: Date;
    quotaUsagePercent: number;
}
//# sourceMappingURL=dm-archive.d.ts.map