import { Conversation, CreateConversationDTO } from '../types/message';
export declare class ConversationService {
    private get db();
    private get redis();
    create(dto: CreateConversationDTO): Promise<Conversation>;
    getById(conversationId: string): Promise<Conversation | null>;
    getByUser(userId: string): Promise<Conversation[]>;
    findOrCreateDM(userId1: string, userId2: string): Promise<Conversation>;
    addParticipant(conversationId: string, userId: string): Promise<void>;
    removeParticipant(conversationId: string, userId: string): Promise<void>;
    isParticipant(conversationId: string, userId: string): Promise<boolean>;
    getParticipantRole(conversationId: string, userId: string): Promise<string | null>;
    private getParticipants;
    countParticipants(conversationId: string): Promise<number>;
    updateName(conversationId: string, name: string): Promise<void>;
    updateAvatar(conversationId: string, avatarUrl: string): Promise<void>;
    update(conversationId: string, data: {
        name?: string;
        avatarUrl?: string;
    }): Promise<void>;
    transferOwnership(conversationId: string, newOwnerId: string): Promise<void>;
    delete(conversationId: string): Promise<void>;
    leaveGroup(conversationId: string, userId: string): Promise<{
        deleted: boolean;
        newOwnerId?: string;
    }>;
}
export declare const conversationService: ConversationService;
//# sourceMappingURL=conversations.service.d.ts.map