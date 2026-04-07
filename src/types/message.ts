// ==========================================
// ALFYCHAT - TYPES MESSAGES (Signal Protocol E2EE)
// ==========================================

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  /**
   * Ciphertext Signal opaque pour le DESTINATAIRE (base64).
   * Le serveur ne déchiffre jamais ce contenu.
   */
  content: string;
  /**
   * Ciphertext Signal opaque pour l'EXPÉDITEUR (base64).
   * Permet à l'expéditeur de relire ses propres messages.
   */
  senderContent?: string;
  /**
   * Type de message Signal Protocol :
   *   1 = WhisperMessage (session établie)
   *   3 = PreKeyWhisperMessage (premier message, établit la session X3DH)
   *   undefined = message non chiffré (canaux serveur, anciens messages)
   */
  e2eeType?: 1 | 3;
  replyToId?: string;
  isEdited: boolean;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt?: Date;
  reactions: Reaction[];
  readBy: string[];
  sender?: MessageSender;
}

export interface MessageSender {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}

export interface Reaction {
  userId: string;
  emoji: string;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  type: 'dm' | 'group';
  name?: string;
  avatarUrl?: string;
  ownerId?: string;
  participants: ConversationParticipant[];
  participantIds: string[];
  lastMessage?: Message;
  unreadCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationParticipant {
  userId: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: Date;
  lastReadAt?: Date;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  isOnline?: boolean;
}

export interface CreateMessageDTO {
  conversationId: string;
  senderId: string;
  /** Ciphertext Signal pour le destinataire (base64) */
  content: string;
  /** Ciphertext Signal pour l'expéditeur (base64) */
  senderContent?: string;
  /** Type Signal : 1 = Whisper, 3 = PreKey */
  e2eeType?: 1 | 3;
  replyToId?: string;
}

export interface UpdateMessageDTO {
  /** Nouveau ciphertext Signal pour le destinataire */
  content: string;
  /** Nouveau ciphertext Signal pour l'expéditeur */
  senderContent?: string;
  /** Type Signal : 1 = Whisper, 3 = PreKey */
  e2eeType?: 1 | 3;
}

export interface CreateConversationDTO {
  type: 'dm' | 'group';
  participantIds: string[];
  name?: string;
  avatarUrl?: string;
  ownerId?: string;
}

