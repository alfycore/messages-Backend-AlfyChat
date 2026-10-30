// ==========================================
// ALFYCHAT - SERVICE MESSAGES
// Relais opaque de ciphertexts E2EE, conversations, archivage de MP, notifications.
// ==========================================

package messages

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/alfychat/messages/internal/platform"
	"github.com/redis/go-redis/v9"
)

type handlers struct {
	db   *platform.DB
	rdb  *redis.Client
	auth *platform.Auth
}

var (
	uuidRe       = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	dmIDRe       = regexp.MustCompile(`^dm_([0-9a-fA-F-]{36})_([0-9a-fA-F-]{36})$`)
	errForbidden = errors.New("Forbidden: not a participant of this conversation")
)

// isDmParticipant décompose dm_<uuidA>_<uuidB> et compare exactement : un simple
// `includes(userId)` acceptait un identifiant contenant l'UUID n'importe où.
func isDmParticipant(conversationID, userID string) bool {
	m := dmIDRe.FindStringSubmatch(conversationID)
	return m != nil && (m[1] == userID || m[2] == userID)
}

func serverError(w http.ResponseWriter) { platform.Error(w, 500, "Erreur serveur") }

func fail(w http.ResponseWriter, logMsg string, err error) {
	slog.Error(logMsg, "err", err)
	serverError(w)
}

// validated reproduit [validators..., validateRequest, handler] : 400 au format
// { error, details: [{ field, message }] } du middleware de validation.
func validated(chains func() []*platform.Chain, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if errs := platform.Validate(r, chains()...); len(errs) > 0 {
			details := make([]any, len(errs))
			for i, e := range errs {
				details[i] = platform.O("field", e.Get("path"), "message", e.Get("msg"))
			}
			platform.JSON(w, 400, platform.O("error", "Données invalides", "details", details))
			return
		}
		next(w, r)
	}
}

func chains(c ...*platform.Chain) func() []*platform.Chain {
	return func() []*platform.Chain { return c }
}

// internalOnly : routes inter-services (gateway → messages).
func (h *handlers) internalOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !platform.SafeCompare(r.Header.Get("X-Internal-Secret"), h.auth.InternalSecret()) {
			platform.Error(w, 403, "Accès interdit — réservé aux services internes")
			return
		}
		next(w, r)
	}
}

// ── Redis ─────────────────────────────────────────────────────────────────

func (h *handlers) rget(ctx context.Context, key string) (string, bool, error) {
	v, err := h.rdb.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	return v, err == nil, err
}

func (h *handlers) rset(ctx context.Context, key, value string, ttlSeconds int) error {
	return h.rdb.Set(ctx, key, value, time.Duration(ttlSeconds)*time.Second).Err()
}

func (h *handlers) rdel(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	return h.rdb.Del(ctx, keys...).Err()
}

// bumpCacheVersion remplace l'invalidation par motif (`KEYS msg:<conv>:*` bloquait
// Redis, partagé par le gateway et tous les services) : la clé de cache embarque
// une version, un INCR périme l'ancienne qui expire ensuite via son TTL.
func (h *handlers) bumpCacheVersion(ctx context.Context, conversationID string) error {
	key := "msgver:" + conversationID
	if err := h.rdb.Incr(ctx, key).Err(); err != nil {
		return err
	}
	return h.rdb.Expire(ctx, key, 24*time.Hour).Err()
}

func (h *handlers) cacheVersion(ctx context.Context, conversationID string) string {
	v, ok, _ := h.rget(ctx, "msgver:"+conversationID)
	if !ok {
		return "0"
	}
	return v
}

// ── Accès aux conversations ───────────────────────────────────────────────

// isParticipantSQL : appartenance à une conversation (base partagée).
func (h *handlers) isParticipantSQL(ctx context.Context, conversationID, userID any) (bool, error) {
	rows, err := h.db.Rows(ctx, "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1",
		platform.SQLParam(conversationID), platform.SQLParam(userID))
	return len(rows) > 0, err
}

// canAccessConversation : DM par décomposition de l'identifiant, groupe par la base.
func (h *handlers) canAccessConversation(ctx context.Context, conversationID, userID string) (bool, error) {
	if conversationID == "" || userID == "" {
		return false, nil
	}
	if m := dmIDRe.FindStringSubmatch(conversationID); m != nil {
		return m[1] == userID || m[2] == userID, nil
	}
	return h.isParticipantSQL(ctx, conversationID, userID)
}

// requireConversationAccess : l'appelant doit participer à la conversation `id`.
func (h *handlers) requireConversationAccess(id func(*http.Request) string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ok, err := h.canAccessConversation(r.Context(), id(r), platform.UserID(r))
		if err != nil {
			serverError(w)
			return
		}
		if !ok {
			platform.Error(w, 403, "Accès non autorisé")
			return
		}
		next(w, r)
	}
}

// ── Aides JS ──────────────────────────────────────────────────────────────

// parseTime relit une date ISO produite par JSDate pour la repasser en paramètre SQL.
func parseTime(v any) any {
	s, ok := v.(string)
	if !ok {
		return v
	}
	if t, err := time.Parse("2006-01-02T15:04:05.000Z", s); err == nil {
		return t
	}
	return v
}

// intParam : parseInt(String(v)).
func intParam(v any) float64 { return platform.JSParseInt(platform.JSString(v)) }

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func placeholders(n int) string { return platform.Placeholders(n) }

func idsToArgs(ids []string) []any { return platform.Args(ids) }

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func hasPrefix(s, p string) bool { return strings.HasPrefix(s, p) }
