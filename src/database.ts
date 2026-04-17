import mysql, { Pool, ResultSetHeader, RowDataPacket, PoolConnection } from 'mysql2/promise';

interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

let pool: Pool | null = null;

export function getDatabaseClient(config?: DatabaseConfig) {
  if (!pool && config) {
    pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 30,
      charset: 'utf8mb4',
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      connectTimeout: 10000,
      idleTimeout: 60000,
    });
  }
  
  if (!pool) throw new Error('Database not initialized');

  return {
    async query<T extends RowDataPacket[]>(sql: string, params?: any[]): Promise<T[]> {
      const [rows] = await pool!.execute<T>(sql, params);
      return [rows];
    },

    async execute(sql: string, params?: any[]): Promise<ResultSetHeader> {
      const [result] = await pool!.execute<ResultSetHeader>(sql, params);
      return result;
    },

    async transaction<T>(callback: (conn: PoolConnection) => Promise<T>): Promise<T> {
      const conn = await pool!.getConnection();
      await conn.beginTransaction();
      try {
        const result = await callback(conn);
        await conn.commit();
        return result;
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }
    },
  };
}

export async function runMigrations(db: ReturnType<typeof getDatabaseClient>): Promise<void> {
  const migrations = [
    `CREATE TABLE IF NOT EXISTS conversations (
      id VARCHAR(100) PRIMARY KEY,
      type ENUM('dm', 'group', 'direct') NOT NULL,
      name VARCHAR(100),
      avatar_url VARCHAR(500),
      owner_id VARCHAR(36),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_type (type),
      INDEX idx_owner (owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id VARCHAR(100) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      role ENUM('owner', 'admin', 'member') DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_read_at TIMESTAMP NULL,
      PRIMARY KEY (conversation_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(36) PRIMARY KEY,
      conversation_id VARCHAR(100) NOT NULL,
      sender_id VARCHAR(36) NOT NULL,
      content TEXT NOT NULL,
      sender_content TEXT DEFAULT NULL,
      e2ee_type TINYINT DEFAULT NULL,
      nonce VARCHAR(64) DEFAULT NULL,
      reply_to_id VARCHAR(36),
      is_edited BOOLEAN DEFAULT FALSE,
      is_deleted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_conversation (conversation_id),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS message_read_status (
      message_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS attachments (
      id VARCHAR(36) PRIMARY KEY,
      message_id VARCHAR(36) NOT NULL,
      type ENUM('image', 'video', 'audio', 'file') NOT NULL,
      url VARCHAR(500) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      size BIGINT NOT NULL,
      mime_type VARCHAR(100) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS message_reactions (
      id VARCHAR(36),
      message_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      emoji VARCHAR(32) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id, emoji)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Les clés E2EE sont stockées uniquement dans Redis (jamais en DB)

    // ===== SYSTÈME HYBRIDE MP =====

    // Stats par conversation DM (suivi quota)
    `CREATE TABLE IF NOT EXISTS dm_conversation_stats (
      conversation_id VARCHAR(100) PRIMARY KEY,
      message_count INT UNSIGNED DEFAULT 0,
      oldest_message_at TIMESTAMP NULL,
      newest_message_at TIMESTAMP NULL,
      last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      archived_count INT UNSIGNED DEFAULT 0,
      recent_activity_count INT UNSIGNED DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Log des archives poussées vers les peers
    `CREATE TABLE IF NOT EXISTS dm_archive_log (
      id VARCHAR(36) PRIMARY KEY,
      conversation_id VARCHAR(100) NOT NULL,
      messages_archived INT UNSIGNED NOT NULL,
      oldest_message_at DATETIME NOT NULL,
      newest_message_at DATETIME NOT NULL,
      reason ENUM('quota_exceeded', 'age_exceeded', 'purge_inactive') NOT NULL,
      archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_conv_archive (conversation_id),
      INDEX idx_archived_at (archived_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Index pour la purge par date (création conditionnelle gérée après)

    // Table notifications — pings persistants en DB jusqu'à lecture
    `CREATE TABLE IF NOT EXISTS notifications (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      conversation_id VARCHAR(100) NOT NULL,
      sender_name VARCHAR(100) NOT NULL,
      message_count INT UNSIGNED DEFAULT 1,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_conv (user_id, conversation_id),
      INDEX idx_user_unread (user_id, is_read)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const sql of migrations) {
    await db.execute(sql);
  }

  // créer les index non supportés par certaines versions via CREATE INDEX IF NOT EXISTS
  try {
    const [idxRows]: any = await db.execute(
      `SELECT COUNT(*) as cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'messages' AND index_name = 'idx_messages_conv_created'`
    );
    if (!idxRows || idxRows[0]?.cnt === 0) {
      await db.execute(`CREATE INDEX idx_messages_conv_created ON messages (conversation_id, created_at)`);
    }
  } catch (e: any) {
    console.log('Index migration warning:', e?.message ?? e);
  }

  // Index composite pour la requête principale (conversation_id, is_deleted, created_at)
  try {
    const [idxRows2]: any = await db.execute(
      `SELECT COUNT(*) as cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'messages' AND index_name = 'idx_messages_conv_deleted_created'`
    );
    if (!idxRows2 || idxRows2[0]?.cnt === 0) {
      await db.execute(`CREATE INDEX idx_messages_conv_deleted_created ON messages (conversation_id, is_deleted, created_at DESC)`);
    }
  } catch (e: any) {
    console.log('Index composite migration warning:', e?.message ?? e);
  }

  // Index sur message_reactions.message_id pour le batch fetch
  try {
    const [idxRows3]: any = await db.execute(
      `SELECT COUNT(*) as cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'message_reactions' AND index_name = 'idx_reactions_message'`
    );
    if (!idxRows3 || idxRows3[0]?.cnt === 0) {
      await db.execute(`CREATE INDEX idx_reactions_message ON message_reactions (message_id)`);
    }
  } catch (e: any) {
    console.log('Index reactions migration warning:', e?.message ?? e);
  }

  // ALTER TABLE migrations pour colonnes manquantes sur tables existantes
  const alterMigrations = [
    `ALTER TABLE conversations MODIFY COLUMN id VARCHAR(100) NOT NULL`,
    `ALTER TABLE conversations ADD COLUMN avatar_url VARCHAR(500) DEFAULT NULL`,
    `ALTER TABLE conversations ADD COLUMN owner_id VARCHAR(36) DEFAULT NULL`,
    `ALTER TABLE conversations MODIFY COLUMN type ENUM('dm','group','direct') NOT NULL`,
    `ALTER TABLE conversation_participants MODIFY COLUMN conversation_id VARCHAR(100) NOT NULL`,
    `ALTER TABLE conversation_participants ADD COLUMN role ENUM('owner','admin','member') DEFAULT 'member'`,
    `ALTER TABLE conversation_participants ADD COLUMN last_read_at TIMESTAMP NULL DEFAULT NULL`,
    `ALTER TABLE messages MODIFY COLUMN conversation_id VARCHAR(100) NOT NULL`,
    `ALTER TABLE dm_conversation_stats MODIFY COLUMN conversation_id VARCHAR(100) NOT NULL`,
    `ALTER TABLE dm_archive_log MODIFY COLUMN conversation_id VARCHAR(100) NOT NULL`,
    // Migration E2EE Signal Protocol: ajouter sender_content et e2ee_type
    `ALTER TABLE messages ADD COLUMN sender_content TEXT DEFAULT NULL`,
    `ALTER TABLE messages ADD COLUMN e2ee_type TINYINT DEFAULT NULL`,
    // Migration E2EE: ajouter nonce, supprimer anciennes colonnes
    `ALTER TABLE messages ADD COLUMN nonce VARCHAR(64) DEFAULT NULL`,
    // Migration MEDIUMTEXT: supporter les ciphertexts ECDH longs
    `ALTER TABLE messages MODIFY COLUMN content MEDIUMTEXT NOT NULL`,
    `ALTER TABLE messages MODIFY COLUMN sender_content MEDIUMTEXT DEFAULT NULL`,
  ];

  for (const sql of alterMigrations) {
    try {
      await db.execute(sql);
    } catch (e: any) {
      // Ignorer erreurs "Duplicate column" (1060) ou "Duplicate key" (1061)
      if (e?.errno !== 1060 && e?.errno !== 1061) {
        console.log('ALTER migration warning:', e.message);
      }
    }
  }

  // Migrer les données de l'ancienne table "reactions" vers "message_reactions" si elle existe encore
  try {
    const [rows]: any = await db.execute(`SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'reactions'`);
    if (rows[0]?.cnt > 0) {
      console.log('⚠️ Ancienne table "reactions" détectée, migration des données...');
      await db.execute(`INSERT IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) SELECT message_id, user_id, emoji, created_at FROM reactions`);
      await db.execute(`DROP TABLE reactions`);
      console.log('✅ Données migrées et ancienne table "reactions" supprimée');
    }
  } catch (e: any) {
    console.log('Migration reactions:', e.message);
  }

  // Supprimer anciennes colonnes E2EE et table encryption_keys
  const dropMigrations = [
    `ALTER TABLE messages DROP COLUMN encryption_level`,
    `ALTER TABLE messages DROP COLUMN iv`,
    `ALTER TABLE messages DROP COLUMN auth_tag`,
  ];

  for (const sql of dropMigrations) {
    try {
      await db.execute(sql);
      console.log(`✅ Migration E2EE: ${sql}`);
    } catch (e: any) {
      // errno 1091 = "Can't DROP; check that column/key exists" → déjà supprimé, ignorer
      if (e?.errno !== 1091) {
        console.log('DROP column migration warning:', e.message);
      }
    }
  }

  // Supprimer l'ancienne table encryption_keys si elle existe
  try {
    await db.execute(`DROP TABLE IF EXISTS encryption_keys`);
  } catch (e: any) {
    console.log('DROP encryption_keys warning:', e.message);
  }

  // ==========================================
  // NOUVELLES FEATURES — MESSAGES VOCAUX & DMs ÉPINGLÉS
  // ==========================================

  // message_type: type de message (text, voice, image, file, system)
  // voice_url: URL du clip audio pour les messages vocaux
  // voice_duration: durée en secondes du message vocal
  const msgNewCols = [
    `ALTER TABLE messages ADD COLUMN message_type ENUM('text','voice','image','file','system') NOT NULL DEFAULT 'text'`,
    `ALTER TABLE messages ADD COLUMN voice_url VARCHAR(500) NULL`,
    `ALTER TABLE messages ADD COLUMN voice_duration INT NULL COMMENT 'Durée en secondes (messages vocaux)'`,
  ];
  for (const sql of msgNewCols) {
    try { await db.execute(sql); } catch (e: any) {
      if (e?.errno !== 1060 && e?.errno !== 1061) console.log('Messages new cols migration warning:', e?.message);
    }
  }

  // pinned_conversations: DMs épinglés en haut de la liste (dupliqué ici pour accès local)
  await db.execute(
    `CREATE TABLE IF NOT EXISTS pinned_conversations (
      user_id VARCHAR(36) NOT NULL,
      conversation_id VARCHAR(100) NOT NULL,
      pin_order INT DEFAULT 0,
      pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, conversation_id),
      INDEX idx_user_pinned (user_id, pin_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}
