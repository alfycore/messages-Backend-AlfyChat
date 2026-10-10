// ==========================================
// ALFYCHAT - SERVICE DB EXTERNE UTILISATEUR
// Permet à chaque user de configurer sa propre
// base MySQL pour recevoir ses anciens messages.
// ==========================================

import mysql from 'mysql2/promise';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { getDatabaseClient } from '../database';
import { logger } from '../utils/logger';
import type { DMArchiveEntry } from '../types/dm-archive';

const ENCRYPTION_KEY_HEX = process.env.ARCHIVE_DB_ENCRYPTION_KEY || '';

// Clé de repli historique (codée en dur, donc publique) : elle ne sert plus
// qu'à DÉCHIFFRER les mots de passe enregistrés avant la configuration d'une
// vraie clé. Tout nouveau chiffrement exige ARCHIVE_DB_ENCRYPTION_KEY.
const LEGACY_DEV_KEY = crypto.scryptSync('alfychat-archive-key-dev', 'salt', 32);

if (ENCRYPTION_KEY_HEX.length !== 64) {
  logger.warn('ARCHIVE_DB_ENCRYPTION_KEY absente ou invalide (64 caractères hex attendus) — la configuration de bases externes est désactivée.');
}

function getEncKey(): Buffer {
  if (ENCRYPTION_KEY_HEX.length === 64) return Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
  throw new Error('ARCHIVE_DB_ENCRYPTION_KEY non configurée');
}

function encryptPassword(plain: string): string {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Préfixe v2 : chiffré avec la clé configurée (les anciennes valeurs n'en ont pas).
  return ['v2', iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decryptPassword(stored: string): string {
  const parts = stored.split(':');
  const versioned = parts[0] === 'v2';
  const [ivHex, tagHex, encHex] = versioned ? parts.slice(1) : parts;
  const key = versioned ? getEncKey() : LEGACY_DEV_KEY;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
}

// ── Garde réseau ──────────────────────────────────────────────────────────
// L'hôte de la « base externe » vient de l'utilisateur : sans contrôle, le
// service se connectait à n'importe quelle adresse interne (localhost, réseau
// Docker, métadonnées cloud…).

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

/** L'hôte résout-il UNIQUEMENT vers des adresses publiques ? */
export async function assertPublicDbHost(host: unknown): Promise<boolean> {
  if (typeof host !== 'string' || !host || host.length > 255) return false;
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return false;
  try {
    const addrs = net.isIP(h) ? [h] : (await dns.lookup(h, { all: true })).map((a) => a.address);
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a));
  } catch {
    return false;
  }
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

    // Revérifié à chaque connexion : un nom DNS peut pointer plus tard vers
    // une adresse interne (rebinding).
    if (!(await assertPublicDbHost(row.host))) {
      logger.warn(`DB externe refusée (hôte non public) pour ${userId}`);
      return null;
    }

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
