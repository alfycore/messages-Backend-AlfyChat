// ==========================================
// ALFYCHAT - SERVICE DB EXTERNE UTILISATEUR
// Permet à chaque user de configurer sa propre
// base MySQL pour recevoir ses anciens messages.
// ==========================================

import mysql from 'mysql2/promise';
import crypto from 'crypto';
import { getDatabaseClient } from '../database';
import { logger } from '../utils/logger';
import type { DMArchiveEntry } from '../types/dm-archive';

const ENCRYPTION_KEY_HEX = process.env.ARCHIVE_DB_ENCRYPTION_KEY || '';
// Clé de 32 octets pour AES-256-GCM — doit être définie en production
function getEncKey(): Buffer {
  if (ENCRYPTION_KEY_HEX.length === 64) return Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
  // Fallback déterministe (dev uniquement — DÉFINIR LA VAR EN PROD)
  return crypto.scryptSync('alfychat-archive-key-dev', 'salt', 32);
}

function encryptPassword(plain: string): string {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decryptPassword(stored: string): string {
  const [ivHex, tagHex, encHex] = stored.split(':');
  const key = getEncKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
}

export interface ArchiveDbConfig {
  userId: string;
  host: string;
  port: number;
  user: string;
  database: string;
  createdAt: Date;
  updatedAt: Date;
}

export class ExternalDbService {
  private get db() {
    return getDatabaseClient();
  }

  async saveConfig(
    userId: string,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string
  ): Promise<void> {
    const encryptedPassword = encryptPassword(password);
    await this.db.execute(
      `INSERT INTO user_archive_db_config (user_id, host, port, db_user, db_password_enc, db_name)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         host = VALUES(host),
         port = VALUES(port),
         db_user = VALUES(db_user),
         db_password_enc = VALUES(db_password_enc),
         db_name = VALUES(db_name),
         updated_at = NOW()`,
      [userId, host, port, user, encryptedPassword, database]
    );
  }

  async getConfig(userId: string): Promise<ArchiveDbConfig | null> {
    const [rows] = await this.db.query(
      `SELECT user_id, host, port, db_user, db_name, created_at, updated_at
       FROM user_archive_db_config WHERE user_id = ?`,
      [userId]
    );
    const row = (rows as any[])[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      host: row.host,
      port: row.port,
      user: row.db_user,
      database: row.db_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async deleteConfig(userId: string): Promise<void> {
    await this.db.execute(
      `DELETE FROM user_archive_db_config WHERE user_id = ?`,
      [userId]
    );
  }

  private async openConnection(userId: string): Promise<mysql.Connection | null> {
    const [rows] = await this.db.query(
      `SELECT host, port, db_user, db_password_enc, db_name
       FROM user_archive_db_config WHERE user_id = ?`,
      [userId]
    );
    const row = (rows as any[])[0];
    if (!row) return null;

    const password = decryptPassword(row.db_password_enc);
    return mysql.createConnection({
      host: row.host,
      port: Number(row.port),
      user: row.db_user,
      password,
      database: row.db_name,
      connectTimeout: 8000,
    });
  }

  async testConnection(
    host: string,
    port: number,
    user: string,
    password: string,
    database: string
  ): Promise<{ ok: boolean; error?: string }> {
    let conn: mysql.Connection | null = null;
    try {
      conn = await mysql.createConnection({ host, port, user, password, database, connectTimeout: 8000 });
      await conn.ping();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'Connexion échouée' };
    } finally {
      try { await conn?.end(); } catch {}
    }
  }

  private async ensureTable(conn: mysql.Connection): Promise<void> {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS alfychat_archived_messages (
        id VARCHAR(36) PRIMARY KEY,
        conversation_id VARCHAR(100) NOT NULL,
        sender_id VARCHAR(36) NOT NULL,
        content MEDIUMTEXT NOT NULL,
        nonce VARCHAR(64) DEFAULT NULL,
        reply_to_id VARCHAR(36) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        archived_at DATETIME NOT NULL,
        INDEX idx_conv (conversation_id),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async exportMessages(userId: string, messages: DMArchiveEntry[]): Promise<void> {
    if (messages.length === 0) return;

    let conn: mysql.Connection | null = null;
    try {
      conn = await this.openConnection(userId);
      if (!conn) return;

      await this.ensureTable(conn);

      for (const msg of messages) {
        await conn.execute(
          `INSERT IGNORE INTO alfychat_archived_messages
             (id, conversation_id, sender_id, content, nonce, reply_to_id, created_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            msg.messageId,
            msg.conversationId,
            msg.senderId,
            msg.content,
            msg.nonce ?? null,
            msg.replyToId ?? null,
            msg.createdAt,
            msg.archivedAt,
          ]
        );
      }

      logger.info(`📤 ${messages.length} messages exportés vers DB externe (user ${userId})`);
    } catch (e: any) {
      logger.warn(`Erreur export DB externe (user ${userId}): ${e?.message}`);
    } finally {
      try { await conn?.end(); } catch {}
    }
  }

  // Exporte vers toutes les DBs des participants d'une conversation
  async exportToParticipants(
    conversationId: string,
    messages: DMArchiveEntry[]
  ): Promise<void> {
    if (messages.length === 0) return;

    const [rows] = await this.db.query(
      `SELECT user_id FROM conversation_participants WHERE conversation_id = ?`,
      [conversationId]
    );
    const participantIds = (rows as any[]).map((r) => r.user_id);

    await Promise.allSettled(
      participantIds.map((uid) => this.exportMessages(uid, messages))
    );
  }

  // Récupère des messages depuis la DB externe de l'utilisateur (pour répondre aux peers)
  async fetchFromExternalDb(
    userId: string,
    conversationId: string,
    options: { before?: string; limit?: number; messageId?: string }
  ): Promise<DMArchiveEntry[]> {
    let conn: mysql.Connection | null = null;
    try {
      conn = await this.openConnection(userId);
      if (!conn) return [];

      await this.ensureTable(conn);

      if (options.messageId) {
        const [rows] = await conn.execute<any[]>(
          `SELECT * FROM alfychat_archived_messages WHERE id = ? AND conversation_id = ? LIMIT 1`,
          [options.messageId, conversationId]
        );
        return (rows as any[]).map(this.rowToEntry);
      }

      const limit = Math.min(options.limit || 50, 200);
      if (options.before) {
        const [rows] = await conn.execute<any[]>(
          `SELECT * FROM alfychat_archived_messages
           WHERE conversation_id = ? AND created_at < ?
           ORDER BY created_at DESC LIMIT ?`,
          [conversationId, options.before, limit]
        );
        return (rows as any[]).map(this.rowToEntry);
      }

      const [rows] = await conn.execute<any[]>(
        `SELECT * FROM alfychat_archived_messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        [conversationId, limit]
      );
      return (rows as any[]).map(this.rowToEntry);
    } catch (e: any) {
      logger.warn(`Erreur lecture DB externe (user ${userId}): ${e?.message}`);
      return [];
    } finally {
      try { await conn?.end(); } catch {}
    }
  }

  private rowToEntry(row: any): DMArchiveEntry {
    return {
      messageId: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      content: row.content,
      nonce: row.nonce ?? undefined,
      encryptionKey: '',
      replyToId: row.reply_to_id ?? undefined,
      createdAt: row.created_at,
      archivedAt: row.archived_at,
    };
  }
}
