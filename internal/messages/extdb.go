// ==========================================
// ALFYCHAT - BASE EXTERNE UTILISATEUR
// Chaque utilisateur peut brancher sa propre base MySQL pour recevoir ses
// anciens messages archivés. L'hôte vient de l'utilisateur : il est vérifié
// publique à chaque connexion (sans cela, c'était une sonde SSRF).
// ==========================================

package messages

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alfychat/messages/internal/platform"
	"github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/scrypt"
)

func encryptionKeyHex() string { return platform.Env("ARCHIVE_DB_ENCRYPTION_KEY", "") }

var (
	legacyKeyOnce sync.Once
	legacyKey     []byte
)

// legacyDevKey : clé de repli historique, codée en dur donc publique. Elle ne sert
// plus qu'à DÉCHIFFRER les mots de passe enregistrés avant la configuration d'une
// vraie clé ; tout nouveau chiffrement exige ARCHIVE_DB_ENCRYPTION_KEY.
func legacyDevKey() []byte {
	legacyKeyOnce.Do(func() {
		legacyKey, _ = scrypt.Key([]byte("alfychat-archive-key-dev"), []byte("salt"), 16384, 8, 1, 32)
	})
	return legacyKey
}

func configuredKey() ([]byte, error) {
	if k := encryptionKeyHex(); len(k) == 64 {
		return hex.DecodeString(k)
	}
	return nil, errors.New("ARCHIVE_DB_ENCRYPTION_KEY non configurée")
}

// encryptPassword : « v2:iv:tag:chiffré » (AES-256-GCM, hexadécimal).
func encryptPassword(plain string) (string, error) {
	key, err := configuredKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, 12)
	_, _ = rand.Read(iv)
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	enc, tag := sealed[:len(sealed)-16], sealed[len(sealed)-16:]
	return strings.Join([]string{"v2", hex.EncodeToString(iv), hex.EncodeToString(tag), hex.EncodeToString(enc)}, ":"), nil
}

func decryptPassword(stored string) (string, error) {
	parts := strings.Split(stored, ":")
	var key []byte
	if len(parts) > 0 && parts[0] == "v2" {
		k, err := configuredKey()
		if err != nil {
			return "", err
		}
		key, parts = k, parts[1:]
	} else {
		key = legacyDevKey()
	}
	if len(parts) < 3 {
		return "", errors.New("mot de passe chiffré illisible")
	}
	iv, e1 := hex.DecodeString(parts[0])
	tag, e2 := hex.DecodeString(parts[1])
	enc, e3 := hex.DecodeString(parts[2])
	if e1 != nil || e2 != nil || e3 != nil {
		return "", errors.New("mot de passe chiffré illisible")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, iv, append(append([]byte{}, enc...), tag...), nil)
	return string(plain), err
}

// ── Garde réseau ──────────────────────────────────────────────────────────

func isPrivateAddress(ip net.IP) bool {
	// To4 couvre aussi les adresses IPv6 mappées (::ffff:a.b.c.d).
	if v4 := ip.To4(); v4 != nil {
		a, b := v4[0], v4[1]
		return a == 10 || a == 127 || a == 0 ||
			(a == 172 && b >= 16 && b <= 31) ||
			(a == 192 && b == 168) ||
			(a == 169 && b == 254) ||
			(a == 100 && b >= 64 && b <= 127) ||
			a >= 224
	}
	s := strings.ToLower(ip.String())
	return s == "::1" || s == "::" || strings.HasPrefix(s, "fc") || strings.HasPrefix(s, "fd") || strings.HasPrefix(s, "fe80")
}

// assertPublicDbHost : l'hôte résout-il UNIQUEMENT vers des adresses publiques ?
func assertPublicDbHost(host any) bool {
	hs, ok := host.(string)
	if !ok || hs == "" || len(hs) > 255 {
		return false
	}
	h := strings.ToLower(strings.TrimSpace(hs))
	if h == "localhost" || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") || strings.HasSuffix(h, ".localhost") {
		return false
	}
	var addrs []net.IP
	if ip := net.ParseIP(h); ip != nil {
		addrs = []net.IP{ip}
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, h)
		if err != nil {
			return false
		}
		for _, a := range ips {
			addrs = append(addrs, a.IP)
		}
	}
	if len(addrs) == 0 {
		return false
	}
	for _, a := range addrs {
		if isPrivateAddress(a) {
			return false
		}
	}
	return true
}

// ── Connexion à la base de l'utilisateur ──────────────────────────────────

func openExternal(host string, port int, user, password, database string) (*sql.DB, error) {
	cfg := mysql.NewConfig()
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(host, strconv.Itoa(port))
	cfg.User, cfg.Passwd, cfg.DBName = user, password, database
	cfg.Timeout = 8 * time.Second
	cfg.ParseTime = true
	cfg.Loc = time.Local
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

func (h *handlers) testConnection(host string, port int, user, password, database string) bool {
	db, err := openExternal(host, port, user, password, database)
	if err != nil {
		return false
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	return db.PingContext(ctx) == nil
}

func (h *handlers) openForUser(ctx context.Context, userID string) (*sql.DB, error) {
	row, err := h.db.First(ctx, `SELECT host, port, db_user, db_password_enc, db_name
       FROM user_archive_db_config WHERE user_id = ?`, userID)
	if err != nil || row == nil {
		return nil, err
	}
	// Revérifié à chaque connexion : un nom DNS peut pointer plus tard vers une adresse interne.
	if !assertPublicDbHost(row.Get("host")) {
		slog.Warn("DB externe refusée (hôte non public) pour " + userID)
		return nil, nil
	}
	password, err := decryptPassword(row.Str("db_password_enc"))
	if err != nil {
		return nil, err
	}
	return openExternal(row.Str("host"), int(row.Int("port")), row.Str("db_user"), password, row.Str("db_name"))
}

func ensureArchiveTable(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
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
    `)
	return err
}

func (h *handlers) exportMessages(ctx context.Context, userID string, entries []any) {
	if len(entries) == 0 {
		return
	}
	db, err := h.openForUser(ctx, userID)
	if err != nil {
		slog.Warn(fmt.Sprintf("Erreur export DB externe (user %s): %v", userID, err))
		return
	}
	if db == nil {
		return
	}
	defer db.Close()
	if err := ensureArchiveTable(ctx, db); err != nil {
		slog.Warn(fmt.Sprintf("Erreur export DB externe (user %s): %v", userID, err))
		return
	}
	for _, e := range entries {
		m := e.(*platform.Object)
		if _, err := db.ExecContext(ctx, `INSERT IGNORE INTO alfychat_archived_messages
             (id, conversation_id, sender_id, content, nonce, reply_to_id, created_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			m.Get("messageId"), m.Get("conversationId"), m.Get("senderId"), m.Get("content"), m.Get("nonce"), m.Get("replyToId"),
			parseTime(m.Get("createdAt")), parseTime(m.Get("archivedAt"))); err != nil {
			slog.Warn(fmt.Sprintf("Erreur export DB externe (user %s): %v", userID, err))
			return
		}
	}
	slog.Info(fmt.Sprintf("📤 %d messages exportés vers DB externe (user %s)", len(entries), userID))
}

// exportToParticipants exporte vers les bases de tous les participants.
func (h *handlers) exportToParticipants(ctx context.Context, convID string, entries []any) error {
	if len(entries) == 0 {
		return nil
	}
	rows, err := h.db.Rows(ctx, "SELECT user_id FROM conversation_participants WHERE conversation_id = ?", convID)
	if err != nil {
		return err
	}
	var wg sync.WaitGroup
	for _, r := range rows {
		wg.Add(1)
		uid := r.Str("user_id")
		go func() {
			defer wg.Done()
			h.exportMessages(ctx, uid, entries)
		}()
	}
	wg.Wait()
	return nil
}

func rowToEntry(row *platform.Object) *platform.Object {
	e := platform.O("messageId", row.Get("id"), "conversationId", row.Get("conversation_id"), "senderId", row.Get("sender_id"), "content", row.Get("content"))
	if v := row.Get("nonce"); v != nil {
		e.Set("nonce", v)
	}
	e.Set("encryptionKey", "")
	if v := row.Get("reply_to_id"); v != nil {
		e.Set("replyToId", v)
	}
	return e.Set("createdAt", row.Get("created_at")).Set("archivedAt", row.Get("archived_at"))
}

// fetchFromExternal lit des messages dans la base de l'utilisateur (pour répondre aux peers).
func (h *handlers) fetchFromExternal(ctx context.Context, userID, convID, before, messageID string, limit float64) []any {
	out := []any{}
	db, err := h.openForUser(ctx, userID)
	if err != nil || db == nil {
		if err != nil {
			slog.Warn(fmt.Sprintf("Erreur lecture DB externe (user %s): %v", userID, err))
		}
		return out
	}
	defer db.Close()
	if err := ensureArchiveTable(ctx, db); err != nil {
		slog.Warn(fmt.Sprintf("Erreur lecture DB externe (user %s): %v", userID, err))
		return out
	}
	var query string
	var args []any
	switch {
	case messageID != "":
		query, args = "SELECT * FROM alfychat_archived_messages WHERE id = ? AND conversation_id = ? LIMIT 1", []any{messageID, convID}
	case before != "":
		query = `SELECT * FROM alfychat_archived_messages
           WHERE conversation_id = ? AND created_at < ?
           ORDER BY created_at DESC LIMIT ?`
		args = []any{convID, before, int64(limit)}
	default:
		query = `SELECT * FROM alfychat_archived_messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC LIMIT ?`
		args = []any{convID, int64(limit)}
	}
	rs, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		slog.Warn(fmt.Sprintf("Erreur lecture DB externe (user %s): %v", userID, err))
		return out
	}
	rows, err := platform.ScanRows(rs)
	rs.Close()
	if err != nil {
		slog.Warn(fmt.Sprintf("Erreur lecture DB externe (user %s): %v", userID, err))
		return out
	}
	for _, r := range rows {
		out = append(out, rowToEntry(r))
	}
	return out
}

// ── Routes ────────────────────────────────────────────────────────────────

// allowExternalDbAttempt plafonne à 10 par heure les tests de connexion sortante.
func (h *handlers) allowExternalDbAttempt(ctx context.Context, userID string) bool {
	key := "extdb:attempts:" + userID
	n, err := h.rdb.Incr(ctx, key).Result()
	if err != nil {
		return false
	}
	if n == 1 {
		if h.rdb.Expire(ctx, key, time.Hour).Err() != nil {
			return false
		}
	}
	return n <= 10
}

func extDBChains() []*platform.Chain {
	return []*platform.Chain{
		platform.BodyField("host").IsString().IsLength(1, 255).Trim(),
		platform.BodyField("port").Optional().IsInt(platform.MinMax(1, 65535)).ToInt(),
		platform.BodyField("user").IsString().IsLength(1, 128).Trim(),
		platform.BodyField("password").IsString().IsLength(1, -1),
		platform.BodyField("database").IsString().IsLength(1, 128).Trim(),
	}
}

// extParams lit host, port, user, password, database du corps validé.
func extParams(r *http.Request) (host string, port int, user, password, database string) {
	body := platform.Body(r)
	host, _ = body.Get("host").(string)
	user, _ = body.Get("user").(string)
	password, _ = body.Get("password").(string)
	database, _ = body.Get("database").(string)
	port = 3306
	if v := platform.GetPath(body, "port"); v != platform.Undefined {
		if n := platform.ToNumber(v); !math.IsNaN(n) && n != 0 {
			port = int(n)
		}
	}
	return
}

func (h *handlers) extGet(w http.ResponseWriter, r *http.Request) {
	row, err := h.db.First(r.Context(), `SELECT user_id, host, port, db_user, db_name, created_at, updated_at
       FROM user_archive_db_config WHERE user_id = ?`, platform.UserID(r))
	if err != nil {
		fail(w, "Erreur récupération config DB externe:", err)
		return
	}
	if row == nil {
		platform.JSON(w, 200, platform.O("configured", false))
		return
	}
	platform.JSON(w, 200, platform.O("configured", true, "userId", row.Get("user_id"), "host", row.Get("host"), "port", row.Get("port"),
		"user", row.Get("db_user"), "database", row.Get("db_name"), "createdAt", row.Get("created_at"), "updatedAt", row.Get("updated_at")))
}

func (h *handlers) extSave(w http.ResponseWriter, r *http.Request) {
	ctx, userID := r.Context(), platform.UserID(r)
	host, port, user, password, database := extParams(r)
	if !h.allowExternalDbAttempt(ctx, userID) {
		platform.Error(w, 429, "Trop de tentatives, réessayez plus tard")
		return
	}
	if !assertPublicDbHost(host) {
		platform.Error(w, 400, "Hôte refusé — une adresse publique est requise")
		return
	}
	if !h.testConnection(host, port, user, password, database) {
		platform.Error(w, 400, "Connexion impossible avec ces paramètres")
		return
	}
	enc, err := encryptPassword(password)
	if err != nil {
		fail(w, "Erreur sauvegarde config DB externe:", err)
		return
	}
	if _, err := h.db.Exec(ctx, `INSERT INTO user_archive_db_config (user_id, host, port, db_user, db_password_enc, db_name)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         host = VALUES(host),
         port = VALUES(port),
         db_user = VALUES(db_user),
         db_password_enc = VALUES(db_password_enc),
         db_name = VALUES(db_name),
         updated_at = NOW()`, userID, host, port, user, enc, database); err != nil {
		fail(w, "Erreur sauvegarde config DB externe:", err)
		return
	}
	platform.JSON(w, 200, platform.O("success", true, "message", "Base de données externe configurée avec succès"))
}

func (h *handlers) extTest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	host, port, user, password, database := extParams(r)
	if !h.allowExternalDbAttempt(ctx, platform.UserID(r)) {
		platform.Error(w, 429, "Trop de tentatives, réessayez plus tard")
		return
	}
	if !assertPublicDbHost(host) {
		platform.JSON(w, 400, platform.O("ok", false, "error", "Hôte refusé — une adresse publique est requise"))
		return
	}
	// Pas de message d'erreur brut : il révélait l'état du réseau interne.
	if h.testConnection(host, port, user, password, database) {
		platform.JSON(w, 200, platform.O("ok", true))
		return
	}
	platform.JSON(w, 200, platform.O("ok", false, "error", "Connexion impossible avec ces paramètres"))
}

func (h *handlers) extMessages(w http.ResponseWriter, r *http.Request) {
	ctx, q, userID := r.Context(), platform.Query(r), platform.UserID(r)
	str := func(k string) string {
		if s, ok := q.Get(k).(string); ok {
			return s
		}
		return ""
	}
	convID := str("conversationId")
	if convID == "" {
		platform.Error(w, 400, "conversationId requis")
		return
	}
	ok, err := h.canAccessConversation(ctx, convID, userID)
	if err != nil {
		fail(w, "Erreur lecture DB externe:", err)
		return
	}
	if !ok {
		platform.Error(w, 403, "Accès non autorisé")
		return
	}
	limit := 50.0
	if l := str("limit"); l != "" {
		limit = math.Min(intParam(l), 200)
	}
	if math.IsNaN(limit) || limit == 0 {
		limit = 50
	}
	limit = math.Min(limit, 200)
	platform.JSON(w, 200, platform.O("messages", h.fetchFromExternal(ctx, userID, convID, str("before"), str("messageId"), limit)))
}

func (h *handlers) extDelete(w http.ResponseWriter, r *http.Request) {
	if _, err := h.db.Exec(r.Context(), "DELETE FROM user_archive_db_config WHERE user_id = ?", platform.UserID(r)); err != nil {
		fail(w, "Erreur suppression config DB externe:", err)
		return
	}
	platform.JSON(w, 200, platform.O("success", true))
}
