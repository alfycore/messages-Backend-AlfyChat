import { Message, CreateMessageDTO, UpdateMessageDTO } from '../types/message';
export declare class MessageService {
    private get db();
    private get redis();
    create(dto: CreateMessageDTO): Promise<Message>;
    getByConversation(conversationId: string, _userId: string, limit?: number, before?: string): Promise<Message[]>;
    getById(messageId: string, _userId: string): Promise<Message | null>;
    update(messageId: string, senderId: string, dto: UpdateMessageDTO): Promise<Message | null>;
    delete(messageId: string, senderId: string): Promise<boolean>;
    addReaction(messageId: string, userId: string, emoji: string): Promise<void>;
    removeReaction(messageId: string, userId: string, emoji: string): Promise<void>;
    markAsRead(conversationId: string, userId: string): Promise<void>;
    getUnreadCount(conversationId: string, userId: string): Promise<number>;
    private getReactions;
    private formatMessage;
}
export declare const messageService: MessageService;
//# sourceMappingURL=messages.service.d.ts.map