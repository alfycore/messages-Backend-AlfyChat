// ==========================================
// ALFYCHAT - SCHÉMA DU SERVICE MESSAGES
// ==========================================

package messages

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/alfychat/messages/internal/platform"
	"github.com/go-sql-driver/mysql"
)

const tableOpts = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"

var createTables = []string{
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
    )` + tableOpts,

	`CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id VARCHAR(100) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      role ENUM('owner', 'admin', 'member') DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_read_at TIMESTAMP NULL,
      PRIMARY KEY (conversation_id, user_id)
    )` + tableOpts,

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
    )` + tableOpts,

	`CREATE TABLE IF NOT EXISTS message_read_status (
      message_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id)
    )` + tableOpts,

	`CREATE TABLE IF NOT EXISTS attachments (
      id VARCHAR(36) PRIMARY KEY,
      message_id VARCHAR(36) NOT NULL,
      type ENUM('image', 'video', 'audio', 'file') NOT NULL,
      url VARCHAR(500) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      size BIGINT NOT NULL,
      mime_type VARCHAR(100) NOT NULL
    )` + tableOpts,

	`CREATE TABLE IF NOT EXISTS message_reactions (
      id VARCHAR(36),
      message_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      emoji VARCHAR(32) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id, emoji)
    )` + tableOpts,

	// Système hybride MP : stats par conversation (suivi du quota)
	`CREATE TABLE IF NOT EXISTS dm_conversation_stats (
      conversation_id VARCHAR(100) PRIMARY KEY,
      message_count INT UNSIGNED DEFAULT 0,
      oldest_message_at TIMESTAMP NULL,
      newest_message_at TIMESTAMP NULL,
      last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      archived_count INT UNSIGNED DEFAULT 0,
      recent_activity_count INT UNSIGNED DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )` + tableOpts,

	// Journal des archives poussées vers les peers
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
    )` + tableOpts,

	// Notifications : pings persistants jusqu'à lecture
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
    )` + tableOpts,
}

var alterColumns = []string{
	"ALTER TABLE conversations MODIFY COLUMN id VARCHAR(100) NOT NULL",
	"ALTER TABLE conversations ADD COLUMN avatar_url VARCHAR(500) DEFAULT NULL",
	"ALTER TABLE conversations ADD COLUMN owner_id VARCHAR(36) DEFAULT NULL",
	"ALTER TABLE conversations MODIFY COLUMN type ENUM('dm','group','direct') NOT NULL",
	"ALTER TABLE conversation_participants MODIFY COLUMN conversation_id VARCHAR(100) NOT NULL",
	"ALTER TABLE conversation_participants ADD COLUMN role ENUM('owner','admin','member') DEFAULT 'member'",
	"ALTER TABLE conversation_participants ADD COLUMN last_read_at TIMESTAMP NULL DEFAULT NULL",
	"ALTER TABLE messages MODIFY COLUMN conversation_id VARCHAR(100) NOT NULL",
	"ALTER TABLE dm_conversation_stats MODIFY COLUMN conversation_id VARCHAR(100) NOT NULL",
	"ALTER TABLE dm_archive_log MODIFY COLUMN conversation_id VARCHAR(100) NOT NULL",
	// E2EE Signal : sender_content, e2ee_type, nonce
	"ALTER TABLE messages ADD COLUMN sender_content TEXT DEFAULT NULL",
	"ALTER TABLE messages ADD COLUMN e2ee_type TINYINT DEFAULT NULL",
	"ALTER TABLE messages ADD COLUMN nonce VARCHAR(64) DEFAULT NULL",
	// MEDIUMTEXT pour les ciphertexts ECDH longs
	"ALTER TABLE messages MODIFY COLUMN content MEDIUMTEXT NOT NULL",
	"ALTER TABLE messages MODIFY COLUMN sender_content MEDIUMTEXT DEFAULT NULL",
}

// ignorés : « Duplicate column » (1060) et « Duplicate key name » (1061)
const (
	errDupColumn = 1060
	errDupKey    = 1061
	errCantDrop  = 1091
)

func mysqlErrno(err error) uint16 {
	var me *mysql.MySQLError
	if errors.As(err, &me) {
		return me.Number
	}
	return 0
}

// ensureIndex crée l'index s'il n'existe pas (pas de IF NOT EXISTS sur CREATE INDEX).
func ensureIndex(ctx context.Context, db *platform.DB, table, index, create, label string) {
	row, err := db.First(ctx,
		"SELECT COUNT(*) as cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = '"+table+"' AND index_name = '"+index+"'")
	if err == nil && (row == nil || row.Int("cnt") == 0) {
		_, err = db.Exec(ctx, create)
	}
	if err != nil {
		slog.Warn(label + " warning: " + err.Error())
	}
}

// Migrate applique le schéma complet (idempotent).
func Migrate(ctx context.Context, db *platform.DB) error {
	for _, q := range createTables {
		if _, err := db.Exec(ctx, q); err != nil {
			return err
		}
	}

	ensureIndex(ctx, db, "messages", "idx_messages_conv_created", "CREATE INDEX idx_messages_conv_created ON messages (conversation_id, created_at)", "Index migration")
	ensureIndex(ctx, db, "messages", "idx_messages_conv_deleted_created", "CREATE INDEX idx_messages_conv_deleted_created ON messages (conversation_id, is_deleted, created_at DESC)", "Index composite migration")
	// getByUser filtre sur user_id SEUL : le préfixe de la clé primaire ne sert pas.
	ensureIndex(ctx, db, "conversation_participants", "idx_cp_user", "CREATE INDEX idx_cp_user ON conversation_participants (user_id)", "Index conversation_participants migration")
	ensureIndex(ctx, db, "message_reactions", "idx_reactions_message", "CREATE INDEX idx_reactions_message ON message_reactions (message_id)", "Index reactions migration")

	for _, q := range alterColumns {
		if _, err := db.Exec(ctx, q); err != nil {
			if n := mysqlErrno(err); n != errDupColumn && n != errDupKey {
				slog.Warn("ALTER migration warning: " + err.Error())
			}
		}
	}

	// Ancienne table « reactions » → message_reactions
	if row, err := db.First(ctx, "SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'reactions'"); err == nil && row != nil && row.Int("cnt") > 0 {
		slog.Warn("Ancienne table \"reactions\" détectée, migration des données...")
		_, err := db.Exec(ctx, "INSERT IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) SELECT message_id, user_id, emoji, created_at FROM reactions")
		if err == nil {
			_, err = db.Exec(ctx, "DROP TABLE reactions")
		}
		if err != nil {
			slog.Warn("Migration reactions: " + err.Error())
		} else {
			slog.Info("Données migrées et ancienne table \"reactions\" supprimée")
		}
	}

	// Anciennes colonnes E2EE et table encryption_keys
	for _, q := range []string{
		"ALTER TABLE messages DROP COLUMN encryption_level",
		"ALTER TABLE messages DROP COLUMN iv",
		"ALTER TABLE messages DROP COLUMN auth_tag",
	} {
		if _, err := db.Exec(ctx, q); err != nil {
			if mysqlErrno(err) != errCantDrop {
				slog.Warn("DROP column migration warning: " + err.Error())
			}
		} else {
			slog.Info(fmt.Sprintf("Migration E2EE: %s", q))
		}
	}
	if _, err := db.Exec(ctx, "DROP TABLE IF EXISTS encryption_keys"); err != nil {
		slog.Warn("DROP encryption_keys warning: " + err.Error())
	}

	// Messages vocaux
	for _, q := range []string{
		"ALTER TABLE messages ADD COLUMN message_type ENUM('text','voice','image','file','system') NOT NULL DEFAULT 'text'",
		"ALTER TABLE messages ADD COLUMN voice_url VARCHAR(500) NULL",
		"ALTER TABLE messages ADD COLUMN voice_duration INT NULL COMMENT 'Durée en secondes (messages vocaux)'",
	} {
		if _, err := db.Exec(ctx, q); err != nil {
			if n := mysqlErrno(err); n != errDupColumn && n != errDupKey {
				slog.Warn("Messages new cols migration warning: " + err.Error())
			}
		}
	}

	// is_open : ouvert (tout membre ajoute) ou fermé (seul le propriétaire)
	if _, err := db.Exec(ctx, "ALTER TABLE conversations ADD COLUMN is_open TINYINT(1) NOT NULL DEFAULT 1"); err != nil && mysqlErrno(err) != errDupColumn {
		slog.Warn("conversations.is_open migration warning: " + err.Error())
	}

	// DMs épinglés
	if _, err := db.Exec(ctx,
		`CREATE TABLE IF NOT EXISTS pinned_conversations (
      user_id VARCHAR(36) NOT NULL,
      conversation_id VARCHAR(100) NOT NULL,
      pin_order INT DEFAULT 0,
      pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, conversation_id),
      INDEX idx_user_pinned (user_id, pin_order)
    )`+tableOpts); err != nil {
		return err
	}

	// Réglages de notification par canal / DM / groupe
	if _, err := db.Exec(ctx,
		`CREATE TABLE IF NOT EXISTS channel_notification_settings (
      user_id     VARCHAR(36)  NOT NULL,
      target_id   VARCHAR(36)  NOT NULL,
      target_type ENUM('channel','dm','group','server') NOT NULL,
      level       ENUM('all','mentions','nothing') NOT NULL DEFAULT 'all',
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, target_id),
      INDEX idx_user_notif (user_id)
    )`+tableOpts); err != nil {
		return err
	}
	for _, q := range []string{
		"ALTER TABLE notifications ADD COLUMN notification_type ENUM('message','mention') NOT NULL DEFAULT 'message'",
		"ALTER TABLE notifications ADD COLUMN sender_id VARCHAR(36) NULL",
		"ALTER TABLE notifications ADD COLUMN channel_name VARCHAR(100) NULL",
	} {
		if _, err := db.Exec(ctx, q); err != nil {
			if n := mysqlErrno(err); n != errDupColumn && n != errDupKey {
				slog.Warn("Notifications alteration warning: " + err.Error())
			}
		}
	}

	// Configuration de base externe par utilisateur (export des messages archivés)
	_, err := db.Exec(ctx,
		`CREATE TABLE IF NOT EXISTS user_archive_db_config (
      user_id VARCHAR(36) PRIMARY KEY,
      host VARCHAR(255) NOT NULL,
      port SMALLINT UNSIGNED NOT NULL DEFAULT 3306,
      db_user VARCHAR(128) NOT NULL,
      db_password_enc TEXT NOT NULL,
      db_name VARCHAR(128) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`+tableOpts)
	return err
}
