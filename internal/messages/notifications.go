// ==========================================
// ALFYCHAT - NOTIFICATIONS
// Pings persistants jusqu'à lecture, réglages par canal / MP / groupe.
// ==========================================

package messages

import (
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/alfychat/messages/internal/platform"
	"github.com/google/uuid"
)

func notifFail(w http.ResponseWriter, logMsg string, err error) {
	slog.Error(logMsg, "err", err)
	platform.Error(w, 500, "Erreur interne")
}

// POST /notifications — ajoute ou incrémente une notification (appel interne).
func (h *handlers) notifCreate(w http.ResponseWriter, r *http.Request) {
	body := platform.Body(r)
	userID, convID, senderName := body.Get("userId"), body.Get("conversationId"), body.Get("senderName")
	if !platform.Truthy(userID) || !platform.Truthy(convID) || !platform.Truthy(senderName) {
		platform.Error(w, 400, "userId, conversationId et senderName sont requis")
		return
	}
	typ := platform.GetPath(body, "notificationType")
	if typ == platform.Undefined || typ == nil {
		typ = "message"
	}
	nullable := func(key string) any {
		if v := platform.GetPath(body, key); v != platform.Undefined {
			return platform.SQLParam(v)
		}
		return nil
	}
	// UPSERT : message_count s'incrémente si la ligne existe déjà ; une mention reste une mention.
	if _, err := h.db.Exec(r.Context(),
		`INSERT INTO notifications (id, user_id, conversation_id, sender_name, sender_id, notification_type, channel_name, message_count, is_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, FALSE)
       ON DUPLICATE KEY UPDATE
         message_count     = message_count + 1,
         sender_name       = VALUES(sender_name),
         sender_id         = VALUES(sender_id),
         notification_type = IF(VALUES(notification_type) = 'mention', 'mention', notification_type),
         channel_name      = COALESCE(VALUES(channel_name), channel_name),
         is_read           = FALSE,
         updated_at        = CURRENT_TIMESTAMP`,
		uuid.NewString(), platform.SQLParam(userID), platform.SQLParam(convID), platform.SQLParam(senderName),
		nullable("senderId"), platform.SQLParam(typ), nullable("channelName")); err != nil {
		notifFail(w, "POST /notifications error:", err)
		return
	}
	platform.JSON(w, 200, platform.O("success", true))
}

// GET /notifications — notifications non lues de l'utilisateur connecté.
func (h *handlers) notifList(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.Rows(r.Context(),
		`SELECT conversation_id, sender_name, message_count, notification_type, channel_name, created_at, updated_at
       FROM notifications
       WHERE user_id = ? AND is_read = FALSE
       ORDER BY updated_at DESC`, platform.UserID(r))
	if err != nil {
		notifFail(w, "GET /notifications error:", err)
		return
	}
	result := platform.O()
	for _, row := range rows {
		typ := row.Get("notification_type")
		if !platform.Truthy(typ) {
			typ = "message"
		}
		item := platform.O("count", row.Get("message_count"), "senderName", row.Get("sender_name"), "type", typ)
		if platform.Truthy(row.Get("channel_name")) {
			item.Set("channelName", row.Get("channel_name"))
		}
		result.Set(row.Str("conversation_id"), item)
	}
	platform.JSON(w, 200, result)
}

// PATCH /notifications/read — marque lues les notifications d'une conversation (ou toutes).
func (h *handlers) notifRead(w http.ResponseWriter, r *http.Request) {
	ctx, userID := r.Context(), platform.UserID(r)
	conv := platform.Body(r).Get("conversationId")
	if platform.Truthy(conv) {
		key := platform.JSString(conv)
		// Le front peut n'envoyer que l'UUID du destinataire : on retrouve la clé « dm_<a>_<b> ».
		if !strings.HasPrefix(key, "dm_") && !strings.HasPrefix(key, "group:") && !strings.HasPrefix(key, "channel:") {
			ids := []string{userID, key}
			sort.Strings(ids)
			key = "dm_" + ids[0] + "_" + ids[1]
		}
		if _, err := h.db.Exec(ctx, `UPDATE notifications SET is_read = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND conversation_id = ?`, userID, key); err != nil {
			notifFail(w, "PATCH /notifications/read error:", err)
			return
		}
	} else if _, err := h.db.Exec(ctx, `UPDATE notifications SET is_read = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`, userID); err != nil {
		notifFail(w, "PATCH /notifications/read error:", err)
		return
	}
	platform.JSON(w, 200, platform.O("success", true))
}

// GET /notifications/settings
func (h *handlers) notifSettings(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.Rows(r.Context(), "SELECT target_id, target_type, level FROM channel_notification_settings WHERE user_id = ?", platform.UserID(r))
	if err != nil {
		notifFail(w, "GET /notifications/settings error:", err)
		return
	}
	result := platform.O()
	for _, row := range rows {
		result.Set(row.Str("target_id"), platform.O("level", row.Get("level"), "targetType", row.Get("target_type")))
	}
	platform.JSON(w, 200, result)
}

// PUT /notifications/settings/:targetId
func (h *handlers) notifSettingPut(w http.ResponseWriter, r *http.Request) {
	body := platform.Body(r)
	level, targetType := body.Get("level"), body.Get("targetType")
	if !oneOf(level, "all", "mentions", "nothing") {
		platform.Error(w, 400, "level invalide (all | mentions | nothing)")
		return
	}
	if !oneOf(targetType, "channel", "dm", "group", "server") {
		platform.Error(w, 400, "targetType invalide")
		return
	}
	targetID := r.PathValue("targetId")
	if _, err := h.db.Exec(r.Context(),
		`INSERT INTO channel_notification_settings (user_id, target_id, target_type, level)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE level = VALUES(level), updated_at = CURRENT_TIMESTAMP`,
		platform.UserID(r), targetID, targetType, level); err != nil {
		notifFail(w, "PUT /notifications/settings/:targetId error:", err)
		return
	}
	platform.JSON(w, 200, platform.O("success", true, "targetId", targetID, "level", level))
}

// DELETE /notifications/settings/:targetId — retour au défaut « all ».
func (h *handlers) notifSettingDelete(w http.ResponseWriter, r *http.Request) {
	if _, err := h.db.Exec(r.Context(), "DELETE FROM channel_notification_settings WHERE user_id = ? AND target_id = ?",
		platform.UserID(r), r.PathValue("targetId")); err != nil {
		notifFail(w, "DELETE /notifications/settings/:targetId error:", err)
		return
	}
	platform.JSON(w, 200, platform.O("success", true))
}

func oneOf(v any, options ...string) bool {
	for _, o := range options {
		if platform.StrictEqual(v, o) {
			return true
		}
	}
	return false
}
