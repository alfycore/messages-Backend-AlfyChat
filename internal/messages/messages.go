// ==========================================
// ALFYCHAT - MESSAGES (Signal Protocol E2EE)
// Le serveur stocke uniquement des ciphertexts opaques.
// ==========================================

package messages

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/alfychat/messages/internal/platform"
	"github.com/google/uuid"
)

const msgCacheTTL = 4 // secondes : court pour rester cohérent avec le temps réel

var uuidFullRe = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ── Formatage ─────────────────────────────────────────────────────────────

func (h *handlers) reactionsBulk(ctx context.Context, ids []string) (map[string][]any, error) {
	out := map[string][]any{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := h.db.Rows(ctx, "SELECT message_id, user_id, emoji, created_at FROM message_reactions WHERE message_id IN ("+placeholders(len(ids))+")", idsToArgs(ids)...)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		id := r.Str("message_id")
		out[id] = append(out[id], platform.O("userId", r.Get("user_id"), "emoji", r.Get("emoji"), "createdAt", r.Get("created_at")))
	}
	return out, nil
}

// formatMessage rend le message avec ses ciphertexts opaques — le client déchiffre.
func formatMessage(row *platform.Object, reactions []any) *platform.Object {
	if reactions == nil {
		reactions = []any{}
	}
	m := platform.O("id", row.Get("id"), "conversationId", row.Get("conversation_id"), "senderId", row.Get("sender_id"), "content", row.Get("content"))
	if v := row.Get("sender_content"); v != nil {
		m.Set("senderContent", v)
	}
	if v := row.Get("e2ee_type"); v != nil {
		m.Set("e2eeType", v)
	}
	m.Set("replyToId", row.Get("reply_to_id")).
		Set("isEdited", row.Bool("is_edited")).
		Set("isDeleted", row.Bool("is_deleted")).
		Set("createdAt", row.Get("created_at")).
		Set("updatedAt", row.Get("updated_at")).
		Set("reactions", reactions).
		Set("readBy", []any{})
	if platform.Truthy(row.Get("sender_username")) {
		m.Set("sender", platform.O("id", row.Get("sender_id"), "username", row.Get("sender_username"),
			"displayName", row.Get("sender_display_name"), "avatarUrl", row.Get("sender_avatar")))
	}
	return m
}

const messageSelect = `SELECT m.id, m.conversation_id, m.sender_id,
             m.content, m.sender_content, m.e2ee_type,
             m.nonce, m.reply_to_id, m.is_edited, m.is_deleted,
             m.created_at, m.updated_at,
             u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id`

func (h *handlers) formatRows(ctx context.Context, rows []*platform.Object) ([]any, error) {
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.Str("id")
	}
	reactions, err := h.reactionsBulk(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = formatMessage(r, reactions[r.Str("id")])
	}
	return out, nil
}

// ── Accès à un message ────────────────────────────────────────────────────

// assertMessageAccess : l'appelant doit participer à la conversation du message.
func (h *handlers) assertMessageAccess(ctx context.Context, messageID, userID any) error {
	rows, err := h.db.Rows(ctx,
		`SELECT 1
       FROM messages m
       JOIN conversation_participants cp
         ON cp.conversation_id = m.conversation_id AND cp.user_id = ?
       WHERE m.id = ?
       LIMIT 1`, platform.SQLParam(userID), platform.SQLParam(messageID))
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return errForbidden
	}
	return nil
}

func (h *handlers) messageByID(ctx context.Context, id any) (*platform.Object, error) {
	rows, err := h.db.Rows(ctx, messageSelect+" WHERE m.id = ?", platform.SQLParam(id))
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	reactions, err := h.db.Rows(ctx, "SELECT user_id, emoji, created_at FROM message_reactions WHERE message_id = ?", platform.SQLParam(id))
	if err != nil {
		return nil, err
	}
	list := make([]any, len(reactions))
	for i, r := range reactions {
		list[i] = platform.O("userId", r.Get("user_id"), "emoji", r.Get("emoji"), "createdAt", r.Get("created_at"))
	}
	return formatMessage(rows[0], list), nil
}

// ── Lecture ───────────────────────────────────────────────────────────────

// GET /messages — par channelId ou recipientId, avec cache Redis versionné.
func (h *handlers) list(w http.ResponseWriter, r *http.Request) {
	ctx, q, userID := r.Context(), platform.Query(r), platform.UserID(r)
	recipientID, channelID := q.Get("recipientId"), q.Get("channelId")
	var conversationID string

	switch {
	case platform.Truthy(recipientID):
		ids := []string{userID, platform.JSString(recipientID)}
		sort.Strings(ids)
		conversationID = "dm_" + ids[0] + "_" + ids[1]
	case platform.Truthy(channelID):
		cid := platform.JSString(channelID)
		if strings.HasPrefix(cid, "dm_") {
			if !isDmParticipant(cid, userID) {
				platform.Error(w, 403, "Accès non autorisé")
				return
			}
		} else {
			ok, err := h.isParticipantSQL(ctx, cid, userID)
			if err != nil {
				fail(w, "Erreur récupération messages:", err)
				return
			}
			if !ok {
				platform.Error(w, 403, "Accès non autorisé")
				return
			}
		}
		conversationID = cid
	}
	if conversationID == "" {
		platform.JSON(w, 200, []any{})
		return
	}

	limit := q.Get("limit")
	if limit == platform.Undefined {
		limit = float64(50)
	}
	before := platform.GetPath(q, "before")
	beforeKey := ""
	if platform.Truthy(before) {
		beforeKey = platform.JSString(before)
	}
	cacheKey := "msg:" + conversationID + ":" + h.cacheVersion(ctx, conversationID) + ":" + platform.JSString(limit) + ":" + beforeKey
	if cached, ok, _ := h.rget(ctx, cacheKey); ok && cached != "" {
		if parsed, err := platform.ParseJSON([]byte(cached)); err == nil {
			w.Header().Set("X-Cache", "HIT")
			platform.JSON(w, 200, parsed)
			return
		}
	}

	query := `
        SELECT m.id, m.conversation_id as conversationId, m.sender_id as senderId,
               m.content, m.sender_content as senderContent, m.e2ee_type as e2eeType,
               m.reply_to_id as replyToId,
               m.created_at as createdAt, m.is_edited as isEdited, m.updated_at as updatedAt,
               u.username as senderUsername, u.display_name as senderDisplayName, u.avatar_url as senderAvatarUrl
        FROM messages m
        LEFT JOIN users u ON m.sender_id = u.id
        WHERE m.conversation_id = ? AND m.is_deleted = FALSE
      `
	args := []any{conversationID}
	if platform.Truthy(before) {
		query += " AND m.created_at < ?"
		args = append(args, platform.SQLParam(before))
	}
	n := intParam(limit)
	if math.IsNaN(n) || n == 0 {
		n = 50
	}
	query += fmt.Sprintf(" ORDER BY m.created_at DESC LIMIT %d", int(math.Min(math.Max(n, 1), 100)))
	rowsDesc, err := h.db.Rows(ctx, query, args...)
	if err != nil {
		fail(w, "Erreur récupération messages:", err)
		return
	}
	rows := make([]*platform.Object, len(rowsDesc))
	for i, row := range rowsDesc {
		rows[len(rowsDesc)-1-i] = row
	}

	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = row.Str("id")
	}
	reactionsMap := map[string][]any{}
	if len(ids) > 0 {
		rrows, err := h.db.Rows(ctx, "SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN ("+placeholders(len(ids))+")", idsToArgs(ids)...)
		if err != nil {
			fail(w, "Erreur récupération messages:", err)
			return
		}
		for _, rr := range rrows {
			id := rr.Str("message_id")
			reactionsMap[id] = append(reactionsMap[id], platform.O("emoji", rr.Get("emoji"), "userId", rr.Get("user_id")))
		}
	}

	messages := make([]any, len(rows))
	for i, row := range rows {
		reactions := reactionsMap[row.Str("id")]
		if reactions == nil {
			reactions = []any{}
		}
		replyTo := row.Get("replyToId")
		if !platform.Truthy(replyTo) {
			replyTo = nil
		}
		messages[i] = platform.O(
			"id", row.Get("id"),
			"conversationId", row.Get("conversationId"),
			"senderId", row.Get("senderId"),
			"authorId", row.Get("senderId"),
			"content", row.Get("content"),
			"senderContent", row.Get("senderContent"),
			"e2eeType", row.Get("e2eeType"),
			"replyToId", replyTo,
			"createdAt", row.Get("createdAt"),
			"updatedAt", row.Get("updatedAt"),
			"isEdited", row.Get("isEdited"),
			"reactions", reactions,
			"sender", platform.O("id", row.Get("senderId"), "username", row.Get("senderUsername"),
				"displayName", row.Get("senderDisplayName"), "avatarUrl", row.Get("senderAvatarUrl")),
		)
	}
	_ = h.rset(ctx, cacheKey, platform.JSONString(messages), msgCacheTTL)
	w.Header().Set("X-Cache", "MISS")
	platform.JSON(w, 200, messages)
}

// accessCheck vérifie l'appartenance avant de passer au handler suivant.
func (h *handlers) accessCheck(conversationID func(*http.Request) string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cid, userID := conversationID(r), platform.UserID(r)
		if strings.HasPrefix(cid, "dm_") {
			if !isDmParticipant(cid, userID) {
				platform.Error(w, 403, "Accès non autorisé")
				return
			}
		} else {
			ok, err := h.isParticipantSQL(r.Context(), cid, userID)
			if err != nil {
				serverError(w)
				return
			}
			if !ok {
				platform.Error(w, 403, "Accès non autorisé")
				return
			}
		}
		next(w, r)
	}
}

// GET /messages/search — uniquement les messages non chiffrés.
func (h *handlers) search(w http.ResponseWriter, r *http.Request) {
	ctx, q := r.Context(), platform.Query(r)
	limit := math.Floor(intParam(q.Get("limit")))
	if math.IsNaN(limit) || limit == 0 {
		limit = 30
	}
	safeLimit := int(math.Min(math.Max(limit, 1), 50))
	pattern := "%" + likeEscape(platform.JSString(q.Get("q"))) + "%"

	query := messageSelect + `
      WHERE m.conversation_id = ? AND m.is_deleted = FALSE
        AND m.e2ee_type IS NULL
        AND m.content LIKE ?`
	args := []any{platform.SQLParam(q.Get("conversationId")), pattern}
	if before := q.Get("before"); platform.Truthy(before) {
		query += " AND m.created_at < ?"
		args = append(args, platform.SQLParam(before))
	}
	query += fmt.Sprintf(" ORDER BY m.created_at DESC LIMIT %d", safeLimit)
	rows, err := h.db.Rows(ctx, query, args...)
	if err != nil {
		fail(w, "Erreur recherche messages:", err)
		return
	}
	out, err := h.formatRows(ctx, rows)
	if err != nil {
		fail(w, "Erreur recherche messages:", err)
		return
	}
	platform.JSON(w, 200, out)
}

// likeEscape échappe % _ \ pour un motif LIKE.
func likeEscape(s string) string {
	var b strings.Builder
	for _, c := range s {
		if c == '%' || c == '_' || c == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(c)
	}
	return b.String()
}

// GET /messages/conversation/:conversationId
func (h *handlers) byConversation(w http.ResponseWriter, r *http.Request) {
	ctx, q := r.Context(), platform.Query(r)
	limit := math.Floor(intParam(orDefaultQ(q, "limit", "50")))
	if math.IsNaN(limit) || limit == 0 {
		limit = 50
	}
	safeLimit := int(math.Min(math.Max(limit, 1), 100))

	query := messageSelect + `
      WHERE m.conversation_id = ? AND m.is_deleted = FALSE`
	args := []any{r.PathValue("conversationId")}
	if before := q.Get("before"); platform.Truthy(before) {
		query += " AND m.created_at < ?"
		args = append(args, platform.SQLParam(before))
	}
	query += fmt.Sprintf(" ORDER BY m.created_at DESC LIMIT %d", safeLimit)
	rows, err := h.db.Rows(ctx, query, args...)
	if err != nil {
		fail(w, "Erreur récupération messages:", err)
		return
	}
	out, err := h.formatRows(ctx, rows)
	if err != nil {
		fail(w, "Erreur récupération messages:", err)
		return
	}
	platform.JSON(w, 200, out)
}

func orDefaultQ(q *platform.Object, key string, def any) any {
	if v := q.Get(key); v != nil && v != platform.Undefined {
		return v
	}
	return def
}

// GET /messages/:messageId — réservé aux participants de la conversation.
func (h *handlers) getByID(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), r.PathValue("messageId")
	if err := h.assertMessageAccess(ctx, id, platform.UserID(r)); err != nil {
		fail(w, "Erreur récupération message:", err)
		return
	}
	msg, err := h.messageByID(ctx, id)
	if err != nil {
		fail(w, "Erreur récupération message:", err)
		return
	}
	if msg == nil {
		platform.Error(w, 404, "Message non trouvé")
		return
	}
	platform.JSON(w, 200, msg)
}

// ── Écriture ──────────────────────────────────────────────────────────────

// POST /messages — appel interne gateway → messages.
func (h *handlers) create(w http.ResponseWriter, r *http.Request) {
	ctx, body := r.Context(), platform.Body(r)
	conversationID := body.Get("conversationId")
	convStr := platform.JSString(conversationID)
	senderID := body.Get("senderId")
	messageID := platform.Or(body.Get("id"), uuid.NewString())

	errNotFound := fmt.Errorf("Conversation non trouvée")
	create := func() (*platform.Object, error) {
		participants, err := h.db.Rows(ctx, "SELECT user_id FROM conversation_participants WHERE conversation_id = ?", platform.SQLParam(conversationID))
		if err != nil {
			return nil, err
		}
		// Conversation DM inexistante : créée automatiquement, mais seulement si
		// l'expéditeur figure parmi les deux UUID encodés dans l'identifiant.
		if len(participants) == 0 && strings.HasPrefix(convStr, "dm_") {
			var userIDs []string
			for _, id := range strings.Split(strings.Replace(convStr, "dm_", "", 1), "_") {
				if uuidFullRe.MatchString(id) {
					userIDs = append(userIDs, id)
				}
			}
			if len(userIDs) != 2 || !contains(userIDs, platform.JSString(senderID)) {
				return nil, fmt.Errorf("Forbidden: not a participant of this DM")
			}
			if _, err := h.db.Exec(ctx,
				`INSERT INTO conversations (id, type, created_at, updated_at)
           VALUES (?, 'direct', NOW(), NOW())
           ON DUPLICATE KEY UPDATE updated_at = NOW()`, convStr); err != nil {
				slog.Error("Erreur création conversation DM", "err", err)
				return nil, err
			}
			for _, uid := range userIDs {
				if _, err := h.db.Exec(ctx,
					`INSERT INTO conversation_participants (conversation_id, user_id, joined_at)
             VALUES (?, ?, NOW())
             ON DUPLICATE KEY UPDATE joined_at = joined_at`, convStr, uid); err != nil {
					slog.Error("Erreur création conversation DM", "err", err)
					return nil, err
				}
			}
			if participants, err = h.db.Rows(ctx, "SELECT user_id FROM conversation_participants WHERE conversation_id = ?", convStr); err != nil {
				return nil, err
			}
		}
		if len(participants) == 0 {
			return nil, errNotFound
		}
		isParticipant := false
		for _, p := range participants {
			if platform.StrictEqual(p.Get("user_id"), senderID) {
				isParticipant = true
			}
		}
		if !isParticipant {
			return nil, fmt.Errorf("Forbidden: sender is not a participant of this conversation")
		}

		orNil := func(key string) any { return platform.SQLParam(nilIfUndef(body, key)) }
		if _, err := h.db.Exec(ctx,
			`INSERT INTO messages (id, conversation_id, sender_id, content, sender_content, e2ee_type, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
			platform.SQLParam(messageID), platform.SQLParam(conversationID), platform.SQLParam(senderID),
			platform.SQLParam(body.Get("content")), orNil("senderContent"), orNil("e2eeType"), orNil("replyToId")); err != nil {
			return nil, err
		}
		if _, err := h.db.Exec(ctx, "UPDATE conversations SET updated_at = NOW() WHERE id = ?", platform.SQLParam(conversationID)); err != nil {
			return nil, err
		}

		// Système hybride DM : quota vérifié après création (non bloquant).
		var archiveEvent *platform.Object
		if strings.HasPrefix(convStr, "dm_") {
			if err := h.rdel(ctx, "dm:stats:"+convStr); err == nil {
				if ev, err := h.checkAndArchiveAfterCreate(ctx, convStr); err == nil {
					archiveEvent = ev
				} else {
					slog.Warn("[Messages] Redis/archive post-create non-bloquant", "err", err)
				}
			} else {
				slog.Warn("[Messages] Redis/archive post-create non-bloquant", "err", err)
			}
		}

		msg := platform.O("id", messageID, "conversationId", conversationID, "senderId", senderID, "content", body.Get("content"))
		setIfPresent(msg, body, "senderContent")
		setIfPresent(msg, body, "e2eeType")
		setIfPresent(msg, body, "replyToId")
		msg.Set("isEdited", false).Set("isDeleted", false).Set("createdAt", platform.JSDate(platform.Now())).
			Set("reactions", []any{}).Set("readBy", []any{senderID})
		if archiveEvent != nil {
			msg.Set("archiveEvent", archiveEvent)
		}
		return msg, nil
	}

	msg, err := create()
	if err != nil {
		slog.Error("Erreur création message:", "err", err)
		if err == errNotFound {
			platform.Error(w, 404, err.Error())
			return
		}
		serverError(w)
		return
	}
	slog.Info("Message créé: " + platform.JSString(msg.Get("id")) + " (E2EE)")
	platform.JSON(w, 201, msg)
	_ = h.bumpCacheVersion(ctx, convStr)
}

// nilIfUndef : `dto.x ?? null` — absent ou null donne null.
func nilIfUndef(body *platform.Object, key string) any {
	if v := platform.GetPath(body, key); v != platform.Undefined {
		return v
	}
	return nil
}

func setIfPresent(dst, body *platform.Object, key string) {
	if v := platform.GetPath(body, key); v != platform.Undefined {
		dst.Set(key, v)
	}
}

// PATCH /messages/:messageId — édition (nouveaux ciphertexts).
func (h *handlers) update(w http.ResponseWriter, r *http.Request) {
	ctx, body, id, userID := r.Context(), platform.Body(r), r.PathValue("messageId"), platform.UserID(r)
	fail500 := func(err error) { fail(w, "Erreur modification message:", err) }

	rows, err := h.db.Rows(ctx, "SELECT id FROM messages WHERE id = ? AND sender_id = ?", id, userID)
	if err != nil {
		fail500(err)
		return
	}
	if len(rows) == 0 {
		platform.Error(w, 404, "Message non trouvé ou non autorisé")
		return
	}
	// senderContent / e2eeType n'entrent dans la mise à jour que s'ils sont valides.
	var senderContent any
	if s, ok := body.Get("senderContent").(string); ok {
		senderContent = s
	}
	var e2ee any
	if n := platform.ToNumber(body.Get("e2eeType")); n == 1 || n == 3 || n == 4 {
		e2ee = int64(n)
	}
	if _, err := h.db.Exec(ctx,
		`UPDATE messages
       SET content = ?, sender_content = ?, e2ee_type = ?, is_edited = TRUE, updated_at = NOW()
       WHERE id = ?`, platform.SQLParam(body.Get("content")), senderContent, e2ee, id); err != nil {
		fail500(err)
		return
	}
	msg, err := h.messageByID(ctx, id)
	if err != nil {
		fail500(err)
		return
	}
	slog.Info("Message modifié: " + id)
	platform.JSON(w, 200, msg)
}

// DELETE /messages/:messageId — suppression logique.
func (h *handlers) delete(w http.ResponseWriter, r *http.Request) {
	res, err := h.db.Exec(r.Context(),
		`UPDATE messages SET is_deleted = TRUE, content = "[Message supprimé]" WHERE id = ? AND sender_id = ?`,
		r.PathValue("messageId"), platform.UserID(r))
	if err != nil {
		fail(w, "Erreur suppression message:", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		platform.Error(w, 404, "Message non trouvé ou non autorisé")
		return
	}
	slog.Info("Message supprimé: " + r.PathValue("messageId"))
	platform.JSON(w, 200, platform.O("success", true))
}

// POST /messages/:messageId/reactions
func (h *handlers) addReaction(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), r.PathValue("messageId")
	if err := h.assertMessageAccess(ctx, id, platform.UserID(r)); err != nil {
		fail(w, "Erreur ajout réaction:", err)
		return
	}
	if _, err := h.db.Exec(ctx, "INSERT IGNORE INTO message_reactions (id, message_id, user_id, emoji)\n       VALUES (?, ?, ?, ?)",
		uuid.NewString(), id, platform.UserID(r), platform.SQLParam(platform.Body(r).Get("emoji"))); err != nil {
		fail(w, "Erreur ajout réaction:", err)
		return
	}
	platform.JSON(w, 200, platform.O("success", true))
}

// DELETE /messages/:messageId/reactions/:emoji
func (h *handlers) removeReaction(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), r.PathValue("messageId")
	if err := h.assertMessageAccess(ctx, id, platform.UserID(r)); err != nil {
		fail(w, "Erreur suppression réaction:", err)
		return
	}
	if _, err := h.db.Exec(ctx, "DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
		id, platform.UserID(r), r.PathValue("emoji")); err != nil {
		fail(w, "Erreur suppression réaction:", err)
		return
	}
	platform.JSON(w, 200, platform.O("success", true))
}

// POST /messages/conversation/:conversationId/read
func (h *handlers) markRead(w http.ResponseWriter, r *http.Request) {
	if _, err := h.db.Exec(r.Context(), `UPDATE conversation_participants SET last_read_at = NOW()
       WHERE conversation_id = ? AND user_id = ?`, r.PathValue("conversationId"), platform.UserID(r)); err != nil {
		fail(w, "Erreur marquage lu:", err)
		return
	}
	platform.JSON(w, 200, platform.O("success", true))
}

// DELETE /messages/user/:userId/all — suppression RGPD des messages d'un utilisateur.
func (h *handlers) deleteAllOfUser(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	if platform.UserID(r) != userID {
		platform.Error(w, 403, "Non autorisé")
		return
	}
	if _, err := h.db.Exec(r.Context(),
		`UPDATE messages SET content = '[Message supprimé]', sender_content = NULL, is_deleted = TRUE
         WHERE sender_id = ?`, userID); err != nil {
		fail(w, "Erreur suppression messages RGPD:", err)
		return
	}
	platform.JSON(w, 200, platform.O("success", true, "message", "Tous vos messages ont été supprimés."))
}

// ── Messages vocaux ───────────────────────────────────────────────────────

var voiceMimes = []string{"audio/ogg", "audio/webm", "audio/mp4", "audio/mpeg", "audio/wav"}

func voiceDir() string {
	return filepath.Join(platform.Env("UPLOADS_DIR", "/uploads"), "voice")
}

// errMulter : erreur remontée par multer ; sans gestionnaire dédié sur ce routeur,
// l'application répond 500 « Internal server error ».
type voiceFile struct{ path, filename string }

// readVoice enregistre le clip sur disque (stockage multer .single('audio')).
func readVoice(r *http.Request) (file *voiceFile, fields map[string]string, err error) {
	fields = map[string]string{}
	mt, _, perr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if perr != nil || !strings.HasPrefix(mt, "multipart/") {
		return nil, fields, nil
	}
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, fields, err
	}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			return file, fields, nil
		}
		if err != nil {
			cleanup(file)
			return nil, fields, err
		}
		if err := handleVoicePart(part, &file, fields); err != nil {
			cleanup(file)
			return nil, fields, err
		}
	}
}

func cleanup(f *voiceFile) {
	if f != nil {
		_ = os.Remove(f.path)
	}
}

func handleVoicePart(part *multipart.Part, file **voiceFile, fields map[string]string) error {
	_, params, _ := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
	if _, isFile := params["filename"]; !isFile {
		b, _ := io.ReadAll(io.LimitReader(part, 1<<20))
		fields[part.FormName()] = string(b)
		return nil
	}
	if part.FormName() != "audio" {
		return fmt.Errorf("Unexpected field")
	}
	if *file != nil {
		return fmt.Errorf("Too many files")
	}
	if !contains(voiceMimes, part.Header.Get("Content-Type")) {
		return fmt.Errorf("Format audio non supporté")
	}
	name := uuid.NewString() + ".ogg"
	path := filepath.Join(voiceDir(), name)
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(part, 5*1024*1024+1))
	f.Close()
	if err != nil || n > 5*1024*1024 {
		_ = os.Remove(path)
		if err == nil {
			err = fmt.Errorf("File too large")
		}
		return err
	}
	*file = &voiceFile{path: path, filename: name}
	return nil
}

// POST /messages/voice
func (h *handlers) voice(w http.ResponseWriter, r *http.Request) {
	ctx, userID := r.Context(), platform.UserID(r)
	file, fields, err := readVoice(r)
	if err != nil {
		slog.Error("Erreur message vocal", "err", err)
		platform.JSON(w, 500, platform.O("error", "Internal server error"))
		return
	}
	if file == nil {
		platform.Error(w, 400, "Fichier audio requis")
		return
	}
	conversationID, ok := fields["conversationId"]
	if !ok || conversationID == "" {
		cleanup(file)
		platform.Error(w, 400, "conversationId requis")
		return
	}
	denied := func() {
		cleanup(file)
		platform.Error(w, 403, "Accès non autorisé")
	}
	if !strings.HasPrefix(conversationID, "dm_") {
		okSQL, err := h.isParticipantSQL(ctx, conversationID, userID)
		if err != nil {
			cleanup(file)
			fail(w, "Erreur message vocal:", err)
			return
		}
		if !okSQL {
			denied()
			return
		}
	} else if !isDmParticipant(conversationID, userID) {
		denied()
		return
	}

	messageID := uuid.NewString()
	voiceURL := "/uploads/voice/" + file.filename
	var duration any
	if n := intParam(fields["duration"]); !math.IsNaN(n) && n != 0 {
		duration = int64(n)
	}
	if _, err := h.db.Exec(ctx,
		`INSERT INTO messages (id, conversation_id, sender_id, content, message_type, voice_url, voice_duration)
         VALUES (?, ?, ?, '', 'voice', ?, ?)`, messageID, conversationID, userID, voiceURL, duration); err != nil {
		cleanup(file)
		fail(w, "Erreur message vocal:", err)
		return
	}
	_ = h.bumpCacheVersion(ctx, conversationID)
	platform.JSON(w, 201, platform.O("id", messageID, "conversationId", conversationID, "senderId", userID,
		"messageType", "voice", "voiceUrl", voiceURL, "voiceDuration", duration, "createdAt", platform.JSDate(time.Now())))
}
