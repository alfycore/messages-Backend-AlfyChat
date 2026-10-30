package messages

import (
	"net/http"
	"strings"

	"github.com/alfychat/messages/internal/platform"
	"github.com/redis/go-redis/v9"
)

// Register déclare les routes dans l'ordre d'Express.
func Register(srv *platform.Server, db *platform.DB, rdb *redis.Client, auth *platform.Auth) *handlers {
	h := &handlers{db: db, rdb: rdb, auth: auth}
	a := auth.Require
	for _, m := range []string{"/messages", "/conversations", "/archive", "/notifications", "/messages/notifications"} {
		srv.Mount(m)
	}

	// ── /messages ──
	srv.Handle("GET /messages", a(h.list))
	srv.Handle("POST /messages", h.internalOnly(validated(chains(
		platform.BodyField("id").Optional().IsUUID(),
		platform.BodyField("conversationId").IsString().NotEmpty(),
		platform.BodyField("senderId").IsUUID(),
		platform.BodyField("content").NotEmpty().IsLength(0, 131072),
		platform.BodyField("senderContent").Optional().IsString().IsLength(0, 131072),
		platform.BodyField("e2eeType").Optional().ToInt().IsIn("1", "3", "4"),
		platform.BodyField("replyToId").Optional().IsUUID(),
	), h.create)))
	srv.Handle("GET /messages/search", a(validated(chains(
		platform.QueryField("conversationId").IsString().NotEmpty(),
		platform.QueryField("q").IsString().IsLength(1, 200),
		platform.QueryField("limit").Optional().IsInt(platform.MinMax(1, 50)),
		platform.QueryField("before").Optional().IsISO8601(),
	), h.accessCheck(func(r *http.Request) string { return platform.JSString(platform.Query(r).Get("conversationId")) }, h.search))))
	srv.Handle("GET /messages/conversation/{conversationId}", a(validated(chains(
		platform.ParamField("conversationId").IsString().NotEmpty(),
		platform.QueryField("limit").Optional().IsInt(platform.MinMax(1, 100)),
		platform.QueryField("before").Optional().IsISO8601(),
	), h.accessCheck(func(r *http.Request) string { return r.PathValue("conversationId") }, h.byConversation))))
	srv.Handle("GET /messages/{messageId}", a(validated(chains(platform.ParamField("messageId").IsUUID()), h.getByID)))
	srv.Handle("PATCH /messages/{messageId}", a(validated(chains(
		platform.ParamField("messageId").IsUUID(),
		platform.BodyField("content").NotEmpty().IsLength(0, 131072),
		platform.BodyField("senderContent").Optional().IsString().IsLength(0, 131072),
		platform.BodyField("e2eeType").Optional().ToInt().IsIn("1", "3", "4"),
	), h.update)))
	srv.Handle("DELETE /messages/{messageId}", a(validated(chains(platform.ParamField("messageId").IsUUID()), h.delete)))
	srv.Handle("POST /messages/{messageId}/reactions", a(validated(chains(
		platform.ParamField("messageId").IsUUID(),
		platform.BodyField("emoji").IsString().IsLength(1, 50),
	), h.addReaction)))
	srv.Handle("DELETE /messages/{messageId}/reactions/{emoji}", a(validated(chains(platform.ParamField("messageId").IsUUID()), h.removeReaction)))
	srv.Handle("POST /messages/conversation/{conversationId}/read", a(validated(chains(platform.ParamField("conversationId").IsUUID()), h.markRead)))
	srv.Handle("POST /messages/voice", a(h.voice))
	srv.Handle("DELETE /messages/user/{userId}/all", a(h.deleteAllOfUser))

	// ── /conversations ──
	srv.Handle("GET /conversations", a(h.listConversations))
	srv.Handle("POST /conversations", a(validated(chains(
		platform.BodyField("type").IsIn("dm", "group"),
		platform.BodyField("participantIds").IsArray(2, 100),
		platform.BodyField("participantIds.*").IsString(),
		platform.BodyField("name").Optional().IsString().IsLength(0, 100),
		platform.BodyField("avatarUrl").Optional().IsString(),
	), h.createConv)))
	srv.Handle("POST /conversations/dm", a(validated(chains(platform.BodyField("recipientId").IsString()), h.dm)))
	srv.Handle("GET /conversations/user/{userId}", a(validated(chains(platform.ParamField("userId").IsString()), h.convsOfUser)))
	srv.Handle("GET /conversations/pinned", a(h.pinned))
	srv.Handle("GET /conversations/{conversationId}", a(validated(chains(platform.ParamField("conversationId").IsString()), h.getConv)))
	srv.Handle("PATCH /conversations/{conversationId}", a(validated(chains(
		platform.ParamField("conversationId").IsString(),
		platform.BodyField("name").Optional().IsString().IsLength(0, 100),
		platform.BodyField("avatarUrl").Optional().IsString(),
	), h.updateConv)))
	srv.Handle("GET /conversations/{conversationId}/participants", h.internalOnly(validated(chains(platform.ParamField("conversationId").IsString()), h.participantsList)))
	srv.Handle("GET /conversations/{conversationId}/participants/{userId}/check", h.internalOnly(validated(chains(
		platform.ParamField("conversationId").IsString(), platform.ParamField("userId").IsString()), h.participantCheck)))
	srv.Handle("POST /conversations/{conversationId}/participants", a(validated(chains(
		platform.ParamField("conversationId").IsString(), platform.BodyField("userId").IsString()), h.addParticipant)))
	srv.Handle("DELETE /conversations/{conversationId}/participants/{userId}", a(validated(chains(
		platform.ParamField("conversationId").IsString(), platform.ParamField("userId").IsString()), h.removeParticipant)))
	srv.Handle("POST /conversations/{conversationId}/leave", a(validated(chains(platform.ParamField("conversationId").IsString()), h.leave)))
	srv.Handle("DELETE /conversations/{conversationId}", a(validated(chains(platform.ParamField("conversationId").IsString()), h.deleteConv)))
	srv.Handle("POST /conversations/{conversationId}/pin", a(validated(chains(platform.ParamField("conversationId").IsString()), h.pin)))
	srv.Handle("DELETE /conversations/{conversationId}/pin", a(validated(chains(platform.ParamField("conversationId").IsString()), h.unpin)))

	// ── /archive ──
	convParam := func(r *http.Request) string { return r.PathValue("conversationId") }
	convChain := chains(platform.ParamField("conversationId").IsString().NotEmpty())
	srv.Handle("GET /archive/status/{conversationId}", a(validated(convChain, h.requireConversationAccess(convParam, h.archiveStatus))))
	srv.Handle("GET /archive/stats/{conversationId}", a(validated(convChain, h.requireConversationAccess(convParam, h.archiveStats))))
	srv.Handle("GET /archive/quota/{conversationId}", a(validated(convChain, h.requireConversationAccess(convParam, h.archiveQuota))))
	srv.Handle("POST /archive/confirm", a(validated(chains(
		platform.BodyField("conversationId").IsString().NotEmpty(), platform.BodyField("archiveLogId").IsString().NotEmpty()), h.archiveConfirm)))
	srv.Handle("GET /archive/message/{messageId}", a(validated(chains(platform.ParamField("messageId").IsString().NotEmpty()), h.archiveMessage)))
	srv.Handle("POST /archive/cache", h.internalOnly(validated(chains(platform.BodyField("messages").IsArray(1, -1)), h.archiveCache)))
	srv.Handle("POST /archive/maintenance", h.internalOnly(h.archiveMaintenance))
	srv.Handle("GET /archive/external-db", a(h.extGet))
	srv.Handle("POST /archive/external-db", a(validated(extDBChains2, h.extSave)))
	srv.Handle("POST /archive/external-db/test", a(validated(extDBChains2, h.extTest)))
	srv.Handle("GET /archive/external-db/messages", a(h.extMessages))
	srv.Handle("DELETE /archive/external-db", a(h.extDelete))

	// ── /notifications (et alias /messages/notifications) ──
	for _, prefix := range []string{"/notifications", "/messages/notifications"} {
		srv.Handle("POST "+prefix, h.internalOnly(h.notifCreate))
		srv.Handle("GET "+prefix, a(h.notifList))
		srv.Handle("PATCH "+prefix+"/read", a(h.notifRead))
		srv.Handle("GET "+prefix+"/settings", a(h.notifSettings))
		srv.Handle("PUT "+prefix+"/settings/{targetId}", a(h.notifSettingPut))
		srv.Handle("DELETE "+prefix+"/settings/{targetId}", a(h.notifSettingDelete))
	}

	srv.Handle("GET /health", func(w http.ResponseWriter, r *http.Request) {
		platform.JSON(w, 200, platform.O("status", "ok", "service", "messages"))
	})
	srv.Handle("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		body := platform.O("service", "messages", "serviceId", platform.Env("SERVICE_ID", "messages-default"),
			"location", strings.ToUpper(platform.Env("SERVICE_LOCATION", "EU")))
		m := platform.CollectServiceMetrics()
		for _, k := range m.Keys() {
			body.Set(k, m.Get(k))
		}
		body.Set("uptime", platform.Uptime())
		platform.JSON(w, 200, body)
	})
	return h
}

func extDBChains2() []*platform.Chain { return extDBChains() }

// StartMaintenance lance la maintenance quotidienne des MP.
func (h *handlers) StartMaintenance() { h.startMaintenance() }
