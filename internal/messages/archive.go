// ==========================================
// ALFYCHAT - ARCHIVAGE HYBRIDE DES MP
// Quota 20 000 messages / 150 jours, push vers les peers, purge des inactifs.
// ==========================================

package messages

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"time"

	"github.com/alfychat/messages/internal/platform"
	"github.com/google/uuid"
)

const (
	dmQuotaMaxMessages    = 20000
	dmQuotaMaxDays        = 150
	dmPurgeInactiveThresh = 90
	dmPurgeInactiveKeep   = 500
	dmP2PCacheTTL         = 3600
)

// archivingEnabled : DM_ARCHIVE=off coupe l'archivage automatique (création,
// maintenance quotidienne). Les routes de consultation restent actives.
func archivingEnabled() bool { return platform.Env("DM_ARCHIVE", "on") != "off" }

func isoOrNow(v any) any {
	if v == nil {
		return platform.JSDate(platform.Now())
	}
	return v
}

// conversationStats lit ou calcule les statistiques d'une conversation (cache 5 min).
func (h *handlers) conversationStats(ctx context.Context, convID string) (*platform.Object, error) {
	if cached, ok, err := h.rget(ctx, "dm:stats:"+convID); err != nil {
		return nil, err
	} else if ok {
		if parsed, perr := platform.ParseJSON([]byte(cached)); perr == nil {
			if o, isObj := parsed.(*platform.Object); isObj {
				return o, nil
			}
		}
	}
	row, err := h.db.First(ctx,
		`SELECT
        COUNT(*) as message_count,
        MIN(created_at) as oldest_message_at,
        MAX(created_at) as newest_message_at,
        MAX(created_at) as last_activity_at,
        SUM(CASE WHEN created_at > DATE_SUB(NOW(), INTERVAL 20 DAY) THEN 1 ELSE 0 END) as recent_activity_count
       FROM messages
       WHERE conversation_id = ? AND is_deleted = FALSE`, convID)
	if err != nil {
		return nil, err
	}
	arch, err := h.db.First(ctx, `SELECT COALESCE(SUM(messages_archived), 0) as archived_count
       FROM dm_archive_log WHERE conversation_id = ?`, convID)
	if err != nil {
		return nil, err
	}
	get := func(o *platform.Object, k string) any {
		if o == nil {
			return nil
		}
		return o.Get(k)
	}
	num := func(v any) float64 {
		if !platform.Truthy(v) {
			return 0
		}
		return platform.ToNumber(v)
	}
	stats := platform.O(
		"conversationId", convID,
		"messageCount", num(get(row, "message_count")),
		"oldestMessageAt", isoOrNow(get(row, "oldest_message_at")),
		"newestMessageAt", isoOrNow(get(row, "newest_message_at")),
		"lastActivityAt", isoOrNow(get(row, "last_activity_at")),
		"archivedCount", num(get(arch, "archived_count")),
		"recentActivityCount", num(get(row, "recent_activity_count")),
	)
	if _, err := h.db.Exec(ctx,
		`INSERT INTO dm_conversation_stats
        (conversation_id, message_count, oldest_message_at, newest_message_at,
         last_activity_at, archived_count, recent_activity_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        message_count = VALUES(message_count),
        oldest_message_at = VALUES(oldest_message_at),
        newest_message_at = VALUES(newest_message_at),
        last_activity_at = VALUES(last_activity_at),
        archived_count = VALUES(archived_count),
        recent_activity_count = VALUES(recent_activity_count)`,
		convID, int64(stats.Int("messageCount")), parseTime(stats.Get("oldestMessageAt")), parseTime(stats.Get("newestMessageAt")),
		parseTime(stats.Get("lastActivityAt")), int64(stats.Int("archivedCount")), int64(stats.Int("recentActivityCount"))); err != nil {
		return nil, err
	}
	if err := h.rset(ctx, "dm:stats:"+convID, platform.JSONString(stats), 300); err != nil {
		return nil, err
	}
	return stats, nil
}

// checkQuota dit s'il faut archiver et combien de messages.
func (h *handlers) checkQuota(ctx context.Context, convID string) (exceeded bool, reason string, toArchive int64, err error) {
	stats, err := h.conversationStats(ctx, convID)
	if err != nil {
		return false, "", 0, err
	}
	if n := platform.ToNumber(stats.Get("messageCount")); n > dmQuotaMaxMessages {
		return true, "quota_exceeded", int64(n-dmQuotaMaxMessages) + 1000, nil // 1000 de marge
	}
	cutoff := time.Now().AddDate(0, 0, -dmQuotaMaxDays)
	row, err := h.db.First(ctx, `SELECT COUNT(*) as count FROM messages
       WHERE conversation_id = ? AND created_at < ? AND is_deleted = FALSE`, convID, cutoff)
	if err != nil {
		return false, "", 0, err
	}
	if row != nil && row.Int("count") > 0 {
		return true, "age_exceeded", row.Int("count"), nil
	}
	return false, "", 0, nil
}

// archiveOldMessages sort les N plus anciens messages vers les peers. Ils ne sont
// supprimés qu'après confirmation de tous les participants (confirmArchive).
func (h *handlers) archiveOldMessages(ctx context.Context, convID string, count int64, reason string) (*platform.Object, error) {
	rows, err := h.db.Rows(ctx,
		`SELECT m.id, m.conversation_id, m.sender_id, m.content,
              m.nonce, m.reply_to_id,
              m.created_at
       FROM messages m
       WHERE m.conversation_id = ? AND m.is_deleted = FALSE
       ORDER BY m.created_at ASC
       LIMIT ?`, convID, count)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	now := platform.JSDate(platform.Now())
	entries := make([]any, len(rows))
	ids := make([]string, len(rows))
	for i, m := range rows {
		ids[i] = m.Str("id")
		entries[i] = platform.O("messageId", m.Get("id"), "conversationId", m.Get("conversation_id"), "senderId", m.Get("sender_id"),
			"content", m.Get("content"), "nonce", m.Get("nonce"), "encryptionKey", "", "replyToId", m.Get("reply_to_id"),
			"createdAt", m.Get("created_at"), "archivedAt", now)
	}
	logID := uuid.NewString()
	if _, err := h.db.Exec(ctx,
		`INSERT INTO dm_archive_log (id, conversation_id, messages_archived, oldest_message_at, newest_message_at, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
		logID, convID, len(rows), parseTime(rows[0].Get("created_at")), parseTime(rows[len(rows)-1].Get("created_at")), reason); err != nil {
		return nil, err
	}
	idsJSON, _ := json.Marshal(ids)
	if err := h.rset(ctx, "dm:archiving:"+convID+":"+logID, string(idsJSON), 3600); err != nil {
		return nil, err
	}
	slog.Info(fmt.Sprintf("📦 Archivage DM: %d MP de %s (%s)", len(rows), convID, reason))

	// Export vers les bases externes des participants (sans attendre).
	platform.Go(func() {
		if err := h.exportToParticipants(context.Background(), convID, entries); err != nil {
			slog.Warn("Erreur export DB externe pour " + convID + ": " + err.Error())
		}
	})
	return platform.O("conversationId", convID, "messages", entries, "reason", reason, "totalArchived", len(rows)), nil
}

// confirmArchive : quand tous les participants ont confirmé, les messages sont supprimés.
func (h *handlers) confirmArchive(ctx context.Context, convID, logID, peerID string) (bool, error) {
	key := "dm:archiving:" + convID + ":" + logID
	data, ok, err := h.rget(ctx, key)
	if err != nil || !ok {
		return false, err
	}
	confirmKey := "dm:archive:confirm:" + logID
	var confirms []string
	if raw, found, err := h.rget(ctx, confirmKey); err != nil {
		return false, err
	} else if found {
		_ = json.Unmarshal([]byte(raw), &confirms)
	}
	if !contains(confirms, peerID) {
		confirms = append(confirms, peerID)
		b, _ := json.Marshal(confirms)
		if err := h.rset(ctx, confirmKey, string(b), 3600); err != nil {
			return false, err
		}
	}
	participants, err := h.db.Rows(ctx, "SELECT user_id FROM conversation_participants WHERE conversation_id = ?", convID)
	if err != nil {
		return false, err
	}
	if len(confirms) < len(participants) {
		return false, nil
	}
	var ids []string
	_ = json.Unmarshal([]byte(data), &ids)
	if len(ids) > 0 {
		ph, args := placeholders(len(ids)), idsToArgs(ids)
		if _, err := h.db.Exec(ctx, "DELETE FROM message_reactions WHERE message_id IN ("+ph+")", args...); err != nil {
			return false, err
		}
		if _, err := h.db.Exec(ctx, "DELETE FROM messages WHERE id IN ("+ph+")", args...); err != nil {
			return false, err
		}
		slog.Info(fmt.Sprintf("🗑️ %d MP supprimés de la DB après confirmation P2P (%s)", len(ids), convID))
	}
	if err := h.rdel(ctx, key, confirmKey, "dm:stats:"+convID); err != nil {
		return false, err
	}
	return true, nil
}

func (h *handlers) checkAndArchiveAfterCreate(ctx context.Context, convID string) (*platform.Object, error) {
	if !archivingEnabled() {
		return nil, nil
	}
	exceeded, reason, n, err := h.checkQuota(ctx, convID)
	if err != nil || !exceeded {
		return nil, err
	}
	return h.archiveOldMessages(ctx, convID, n, reason)
}

// purgeInactive archive les MP des conversations inactives au-delà de 500 messages.
func (h *handlers) purgeInactive(ctx context.Context) (*platform.Object, error) {
	purged, total := 0, int64(0)
	events := []any{}
	convs, err := h.db.Rows(ctx,
		`SELECT c.id,
              COUNT(m.id) as total_messages,
              SUM(CASE WHEN m.created_at > DATE_SUB(NOW(), INTERVAL 20 DAY) THEN 1 ELSE 0 END) as recent_messages
       FROM conversations c
       JOIN messages m ON c.id = m.conversation_id AND m.is_deleted = FALSE
       WHERE c.type IN ('direct', 'dm')
       GROUP BY c.id
       HAVING total_messages > ?`, dmPurgeInactiveKeep)
	if err != nil {
		return nil, err
	}
	for _, c := range convs {
		if platform.ToNumber(c.Get("recent_messages")) < dmPurgeInactiveThresh {
			toArchive := c.Int("total_messages") - dmPurgeInactiveKeep
			if toArchive > 0 {
				ev, err := h.archiveOldMessages(ctx, c.Str("id"), toArchive, "purge_inactive")
				if err != nil {
					return nil, err
				}
				if ev != nil {
					events = append(events, ev)
					purged++
					total += toArchive
				}
			}
		}
	}
	slog.Info(fmt.Sprintf("🧹 Purge intelligente: %d conversations, %d MP archivés", purged, total))
	return platform.O("purgedConversations", purged, "totalMessagesPurged", total, "archiveEvents", events), nil
}

// dailyMaintenance : purge des inactifs puis archivage par âge de tous les MP.
func (h *handlers) dailyMaintenance(ctx context.Context) (*platform.Object, error) {
	slog.Info("🔧 Début maintenance quotidienne DM...")
	purge, err := h.purgeInactive(ctx)
	if err != nil {
		return nil, err
	}
	ageCount := int64(0)
	convs, err := h.db.Rows(ctx, `SELECT DISTINCT conversation_id
       FROM messages
       WHERE conversation_id LIKE 'dm_%'
         AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
         AND is_deleted = FALSE`, dmQuotaMaxDays)
	if err != nil {
		return nil, err
	}
	for _, c := range convs {
		exceeded, reason, n, err := h.checkQuota(ctx, c.Str("conversation_id"))
		if err != nil {
			return nil, err
		}
		if exceeded && reason == "age_exceeded" {
			if _, err := h.archiveOldMessages(ctx, c.Str("conversation_id"), n, "age_exceeded"); err != nil {
				return nil, err
			}
			ageCount += n
		}
	}
	slog.Info(fmt.Sprintf("🔧 Maintenance terminée: %d purges, %d MP archivés par âge", purge.Int("purgedConversations"), ageCount))
	return platform.O("purgeResult", purge, "ageArchiveCount", ageCount), nil
}

// StartMaintenance lance la maintenance quotidienne (toutes les 24 h).
func (h *handlers) startMaintenance() {
	ticker := time.NewTicker(24 * time.Hour)
	platform.Go(func() {
		for range ticker.C {
			if !archivingEnabled() {
				continue
			}
			slog.Info("⏰ Démarrage maintenance DM programmée...")
			if _, err := h.dailyMaintenance(context.Background()); err != nil {
				slog.Error("Erreur maintenance DM programmée", "err", err)
			}
		}
	})
	slog.Info("📦 Système hybride DM activé (quota 20k/30j + P2P)")
}

// ── Routes ────────────────────────────────────────────────────────────────

func (h *handlers) archiveStatus(w http.ResponseWriter, r *http.Request) {
	stats, err := h.conversationStats(r.Context(), r.PathValue("conversationId"))
	if err != nil {
		fail(w, "Erreur récupération statut archive:", err)
		return
	}
	pct := platform.ToNumber(stats.Get("messageCount")) / dmQuotaMaxMessages * 100
	platform.JSON(w, 200, platform.O("conversationId", r.PathValue("conversationId"),
		"serverMessageCount", stats.Get("messageCount"), "localMessageCount", 0,
		"oldestServerMessage", stats.Get("oldestMessageAt"), "quotaUsagePercent", math.Min(pct, 100)))
}

func (h *handlers) archiveStats(w http.ResponseWriter, r *http.Request) {
	stats, err := h.conversationStats(r.Context(), r.PathValue("conversationId"))
	if err != nil {
		fail(w, "Erreur récupération stats:", err)
		return
	}
	platform.JSON(w, 200, stats)
}

func (h *handlers) archiveQuota(w http.ResponseWriter, r *http.Request) {
	exceeded, reason, n, err := h.checkQuota(r.Context(), r.PathValue("conversationId"))
	if err != nil {
		fail(w, "Erreur vérification quota:", err)
		return
	}
	res := platform.O("exceeded", exceeded)
	if exceeded {
		res.Set("reason", reason)
	}
	platform.JSON(w, 200, res.Set("messagesToArchive", n))
}

func (h *handlers) archiveConfirm(w http.ResponseWriter, r *http.Request) {
	body, userID := platform.Body(r), platform.UserID(r)
	convID, logID := platform.JSString(body.Get("conversationId")), platform.JSString(body.Get("archiveLogId"))
	ok, err := h.canAccessConversation(r.Context(), convID, userID)
	if err != nil {
		fail(w, "Erreur confirmation archive:", err)
		return
	}
	if !ok {
		platform.Error(w, 403, "Accès non autorisé")
		return
	}
	all, err := h.confirmArchive(r.Context(), convID, logID, userID)
	if err != nil {
		fail(w, "Erreur confirmation archive:", err)
		return
	}
	msg := "Confirmation enregistrée, en attente des autres peers"
	if all {
		msg = "Tous les peers ont confirmé, messages supprimés du serveur"
	}
	platform.JSON(w, 200, platform.O("success", true, "allConfirmed", all, "message", msg))
}

func (h *handlers) archiveMessage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cached, ok, err := h.rget(ctx, "dm:cached:msg:"+r.PathValue("messageId"))
	if err != nil {
		fail(w, "Erreur récupération message archivé:", err)
		return
	}
	if ok {
		if parsed, perr := platform.ParseJSON([]byte(cached)); perr == nil {
			conv := ""
			if v := platform.GetPath(parsed, "conversationId"); v != platform.Undefined && v != nil {
				conv = platform.JSString(v)
			}
			allowed, err := h.canAccessConversation(ctx, conv, platform.UserID(r))
			if err != nil {
				fail(w, "Erreur récupération message archivé:", err)
				return
			}
			if allowed {
				platform.JSON(w, 200, platform.O("source", "cache", "message", parsed))
				return
			}
		}
	}
	platform.JSON(w, 200, platform.O("source", "peer_needed", "message", nil))
}

var messageIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// POST /archive/cache — met en cache des messages récupérés d'un peer (gateway).
// Le gateway envoie `id`, le service indexait sur `messageId` : on normalise, et
// seuls les messages à identifiant et conversation valides sont gardés.
func (h *handlers) archiveCache(w http.ResponseWriter, r *http.Request) {
	list, _ := platform.Body(r).Get("messages").([]any)
	if len(list) > 200 {
		list = list[:200]
	}
	kept := 0
	for _, item := range list {
		m, ok := item.(*platform.Object)
		if !ok {
			continue
		}
		id := m.Get("messageId")
		if id == nil || id == platform.Undefined {
			id = m.Get("id")
		}
		idStr, idOK := id.(string)
		conv, convOK := m.Get("conversationId").(string)
		if !idOK || !messageIDRe.MatchString(idStr) || !convOK || len([]rune(conv)) > 128 {
			continue
		}
		entry := m.Clone().Set("messageId", idStr)
		if err := h.rset(r.Context(), "dm:cached:msg:"+idStr, platform.JSONString(entry), dmP2PCacheTTL); err != nil {
			fail(w, "Erreur mise en cache:", err)
			return
		}
		kept++
	}
	platform.JSON(w, 200, platform.O("success", true, "cached", kept))
}

func (h *handlers) archiveMaintenance(w http.ResponseWriter, r *http.Request) {
	res, err := h.dailyMaintenance(r.Context())
	if err != nil {
		fail(w, "Erreur maintenance:", err)
		return
	}
	out := platform.O("success", true)
	for _, k := range res.Keys() {
		out.Set(k, res.Get(k))
	}
	platform.JSON(w, 200, out)
}
