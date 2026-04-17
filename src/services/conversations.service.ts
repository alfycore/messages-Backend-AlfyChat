// ==========================================
// ALFYCHAT - SERVICE CONVERSATIONS (Group DM)
// Système de conversations DM + Groupes complet
// ==========================================

import { v4 as uuidv4 } from 'uuid';
import { getDatabaseClient } from '../database';
import { getRedisClient } from '../redis';
import { Conversation, ConversationParticipant, CreateConversationDTO } from '../types/message';

/**
 * Helper pour extraire les lignes du résultat de db.query()
 * db.query() retourne [rows] donc on prend toujours [0]
 */
function extractRows(result: any): any[] {
  if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
    return result[0];
  }
  if (Array.isArray(result)) return result;
  return [];
}

export class ConversationService {
  private get db() {
    return getDatabaseClient();
  }

  private get redis() {
    return getRedisClient();
  }

  // ============ CRÉATION ============

  async create(dto: CreateConversationDTO): Promise<Conversation> {
    const conversationId = uuidv4();
    const ownerId = dto.ownerId || dto.participantIds[0];

    await this.db.execute(
      `INSERT INTO conversations (id, type, name, avatar_url, owner_id) VALUES (?, ?, ?, ?, ?)`,
      [conversationId, dto.type, dto.name || null, dto.avatarUrl || null, dto.type === 'group' ? ownerId : null]
    );

    for (const userId of dto.participantIds) {
      const role = (dto.type === 'group' && userId === ownerId) ? 'owner' : 'member';
      await this.db.execute(
        `INSERT INTO conversation_participants (conversation_id, user_id, role)
         VALUES (?, ?, ?)`,
        [conversationId, userId, role]
      );
    }

    return this.getById(conversationId) as Promise<Conversation>;
  }

  // ============ LECTURE ============

  async getById(conversationId: string): Promise<Conversation | null> {
    const result = await this.db.query(
      'SELECT * FROM conversations WHERE id = ?',
      [conversationId]
    );
    const rows = extractRows(result);

    if (rows.length === 0) return null;

    const conv = rows[0];
    const participants = await this.getParticipants(conversationId);

    return {
      id: conv.id,
      type: conv.type === 'direct' ? 'dm' : conv.type,
      name: conv.name,
      avatarUrl: conv.avatar_url,
      ownerId: conv.owner_id,
      participants,
      participantIds: participants.map(p => p.userId),
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
    };
  }

  async getByUser(userId: string): Promise<Conversation[]> {
    const result = await this.db.query(
      `SELECT c.id, c.type, c.name, c.avatar_url, c.owner_id,
              c.created_at, c.updated_at,
              lm.content  AS last_message,
              lm.created_at AS last_message_at
       FROM conversations c
       JOIN conversation_participants cp ON c.id = cp.conversation_id
       LEFT JOIN messages lm ON lm.id = (
         SELECT id FROM messages
         WHERE conversation_id = c.id
         ORDER BY created_at DESC
         LIMIT 1
       )
       WHERE cp.user_id = ?
       ORDER BY COALESCE(lm.created_at, c.updated_at) DESC`,
      [userId]
    );
    const rows = extractRows(result);
    if (rows.length === 0) return [];

    // Charger TOUS les participants en une seule requête (évite le N+1)
    const convIds = rows.map((r: any) => r.id);
    const placeholders = convIds.map(() => '?').join(',');
    const participantsResult = await this.db.query(
      `SELECT cp.conversation_id, cp.user_id, cp.role, cp.joined_at, cp.last_read_at,
              u.username, u.display_name, u.avatar_url, u.is_online
       FROM conversation_participants cp
       LEFT JOIN users u ON cp.user_id = u.id
       WHERE cp.conversation_id IN (${placeholders})`,
      convIds
    );
    const allParticipants = extractRows(participantsResult);

    // Grouper les participants par conversation_id
    const participantsByConv = new Map<string, ConversationParticipant[]>();
    for (const p of allParticipants) {
      const list = participantsByConv.get(p.conversation_id) ?? [];
      list.push({
        userId: p.user_id,
        role: p.role || 'member',
        joinedAt: p.joined_at,
        lastReadAt: p.last_read_at,
        username: p.username,
        displayName: p.display_name,
        avatarUrl: p.avatar_url,
        isOnline: !!p.is_online,
      });
      participantsByConv.set(p.conversation_id, list);
    }

    return rows.map((conv: any) => {
      const participants = participantsByConv.get(conv.id) ?? [];
      return {
        id: conv.id,
        type: conv.type === 'direct' ? 'dm' : conv.type,
        name: conv.name,
        avatarUrl: conv.avatar_url,
        ownerId: conv.owner_id,
        participants,
        participantIds: participants.map((p: ConversationParticipant) => p.userId),
        createdAt: conv.created_at,
        updatedAt: conv.updated_at,
        lastMessage: conv.last_message ?? null,
        lastMessageAt: conv.last_message_at ?? conv.updated_at,
      } as Conversation;
    });
  }

  async findOrCreateDM(userId1: string, userId2: string): Promise<Conversation> {
    const result = await this.db.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.user_id = ?
       JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id = ?
       WHERE c.type IN ('dm', 'direct')`,
      [userId1, userId2]
    );
    const rows = extractRows(result);

    if (rows.length > 0) {
      return this.getById(rows[0].id) as Promise<Conversation>;
    }

    return this.create({
      type: 'dm',
      participantIds: [userId1, userId2],
    });
  }

  // ============ GESTION DES PARTICIPANTS ============

  async addParticipant(conversationId: string, userId: string): Promise<void> {
    await this.db.execute(
      `INSERT IGNORE INTO conversation_participants (conversation_id, user_id, role)
       VALUES (?, ?, 'member')`,
      [conversationId, userId]
    );
    await this.db.execute(
      'UPDATE conversations SET updated_at = NOW() WHERE id = ?',
      [conversationId]
    );
  }

  async removeParticipant(conversationId: string, userId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
      [conversationId, userId]
    );
    await this.db.execute(
      'UPDATE conversations SET updated_at = NOW() WHERE id = ?',
      [conversationId]
    );
  }

  async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
      [conversationId, userId]
    );
    return extractRows(result).length > 0;
  }

  async getParticipantRole(conversationId: string, userId: string): Promise<string | null> {
    const result = await this.db.query(
      'SELECT role FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
      [conversationId, userId]
    );
    const rows = extractRows(result);
    if (rows.length === 0) return null;
    return rows[0].role;
  }

  private async getParticipants(conversationId: string): Promise<ConversationParticipant[]> {
    const result = await this.db.query(
      `SELECT cp.user_id, cp.role, cp.joined_at, cp.last_read_at,
              u.username, u.display_name, u.avatar_url, u.is_online
       FROM conversation_participants cp
       LEFT JOIN users u ON cp.user_id = u.id
       WHERE cp.conversation_id = ?`,
      [conversationId]
    );
    const rows = extractRows(result);

    return rows.map((p: any) => ({
      userId: p.user_id,
      role: p.role || 'member',
      joinedAt: p.joined_at,
      lastReadAt: p.last_read_at,
      username: p.username,
      displayName: p.display_name,
      avatarUrl: p.avatar_url,
      isOnline: !!p.is_online,
    }));
  }

  async countParticipants(conversationId: string): Promise<number> {
    const result = await this.db.query(
      'SELECT COUNT(*) as count FROM conversation_participants WHERE conversation_id = ?',
      [conversationId]
    );
    const rows = extractRows(result);
    return rows[0]?.count || 0;
  }

  // ============ MISE À JOUR ============

  async updateName(conversationId: string, name: string): Promise<void> {
    await this.db.execute(
      'UPDATE conversations SET name = ?, updated_at = NOW() WHERE id = ?',
      [name, conversationId]
    );
  }

  async updateAvatar(conversationId: string, avatarUrl: string): Promise<void> {
    await this.db.execute(
      'UPDATE conversations SET avatar_url = ?, updated_at = NOW() WHERE id = ?',
      [avatarUrl, conversationId]
    );
  }

  async update(conversationId: string, data: { name?: string; avatarUrl?: string }): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.avatarUrl !== undefined) {
      fields.push('avatar_url = ?');
      values.push(data.avatarUrl);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = NOW()');
    values.push(conversationId);

    await this.db.execute(
      `UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
  }

  async transferOwnership(conversationId: string, newOwnerId: string): Promise<void> {
    await this.db.execute(
      'UPDATE conversations SET owner_id = ?, updated_at = NOW() WHERE id = ?',
      [newOwnerId, conversationId]
    );
    await this.db.execute(
      `UPDATE conversation_participants SET role = 'owner' WHERE conversation_id = ? AND user_id = ?`,
      [conversationId, newOwnerId]
    );
    await this.db.execute(
      `UPDATE conversation_participants SET role = 'member' WHERE conversation_id = ? AND user_id != ? AND role = 'owner'`,
      [conversationId, newOwnerId]
    );
  }

  // ============ SUPPRESSION ============

  async delete(conversationId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM conversations WHERE id = ?',
      [conversationId]
    );
  }

  async leaveGroup(conversationId: string, userId: string): Promise<{ deleted: boolean; newOwnerId?: string }> {
    const role = await this.getParticipantRole(conversationId, userId);
    if (!role) throw new Error('Utilisateur non participant');

    const participantCount = await this.countParticipants(conversationId);

    if (participantCount <= 1) {
      await this.delete(conversationId);
      return { deleted: true };
    }

    let newOwnerId: string | undefined;
    if (role === 'owner') {
      const result = await this.db.query(
        `SELECT user_id FROM conversation_participants 
         WHERE conversation_id = ? AND user_id != ?
         ORDER BY joined_at ASC LIMIT 1`,
        [conversationId, userId]
      );
      const rows = extractRows(result);
      if (rows.length > 0) {
        newOwnerId = rows[0].user_id as string;
        await this.transferOwnership(conversationId, newOwnerId);
      }
    }

    await this.removeParticipant(conversationId, userId);

    return { deleted: false, newOwnerId };
  }
}

export const conversationService = new ConversationService();
