// ==========================================
// ALFYCHAT - CONVERSATIONS (MP et groupes)
// ==========================================

package messages

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sort"

	"github.com/alfychat/messages/internal/platform"
	"github.com/google/uuid"
)

const maxGroupSize = 100

// ── Service ───────────────────────────────────────────────────────────────

func participantFrom(p *platform.Object) *platform.Object {
	role := p.Get("role")
	if !platform.Truthy(role) {
		role = "member"
	}
	return platform.O("userId", p.Get("user_id"), "role", role, "joinedAt", p.Get("joined_at"), "lastReadAt", p.Get("last_read_at"),
		"username", p.Get("username"), "displayName", p.Get("display_name"), "avatarUrl", p.Get("avatar_url"), "isOnline", p.Bool("is_online"))
}

func convType(v any) any {
	if v == "direct" {
		return "dm"
	}
	return v
}

func participantIDs(ps []any) []any {
	ids := make([]any, len(ps))
	for i, p := range ps {
		ids[i] = p.(*platform.Object).Get("userId")
	}
	return ids
}

func (h *handlers) participants(ctx context.Context, id any) ([]any, error) {
	rows, err := h.db.Rows(ctx,
		`SELECT cp.user_id, cp.role, cp.joined_at, cp.last_read_at,
              u.username, u.display_name, u.avatar_url, u.is_online
       FROM conversation_participants cp
       LEFT JOIN users u ON cp.user_id = u.id
       WHERE cp.conversation_id = ?`, platform.SQLParam(id))
	if err != nil {
		return nil, err
	}
	out := make([]any, len(rows))
	for i, p := range rows {
		out[i] = participantFrom(p)
	}
	return out, nil
}

// convByID renvoie la conversation complète, ou nil.
func (h *handlers) convByID(ctx context.Context, id any) (*platform.Object, error) {
	row, err := h.db.First(ctx, "SELECT * FROM conversations WHERE id = ?", platform.SQLParam(id))
	if err != nil || row == nil {
		return nil, err
	}
	ps, err := h.participants(ctx, id)
	if err != nil {
		return nil, err
	}
	return platform.O("id", row.Get("id"), "type", convType(row.Get("type")), "name", row.Get("name"),
		"avatarUrl", row.Get("avatar_url"), "ownerId", row.Get("owner_id"), "isOpen", row.Get("is_open") != int64(0),
		"participants", ps, "participantIds", participantIDs(ps),
		"createdAt", row.Get("created_at"), "updatedAt", row.Get("updated_at")), nil
}

// createConversation insère la conversation et ses participants.
func (h *handlers) createConversation(ctx context.Context, typ any, participantIDs []string, name, avatar any, ownerID string, isOpen any) (*platform.Object, error) {
	id := uuid.NewString()
	if ownerID == "" && len(participantIDs) > 0 {
		ownerID = participantIDs[0]
	}
	open := int64(1)
	if typ == "group" && isOpen != false {
		open = 1
	} else if typ == "group" {
		open = 0
	}
	var owner any
	if typ == "group" {
		owner = ownerID
	}
	if _, err := h.db.Exec(ctx, `INSERT INTO conversations (id, type, name, avatar_url, owner_id, is_open) VALUES (?, ?, ?, ?, ?, ?)`,
		id, platform.SQLParam(typ), nilIfFalsy(name), nilIfFalsy(avatar), owner, open); err != nil {
		return nil, err
	}
	for _, uid := range participantIDs {
		role := "member"
		if typ == "group" && uid == ownerID {
			role = "owner"
		}
		if _, err := h.db.Exec(ctx, `INSERT INTO conversation_participants (conversation_id, user_id, role)
         VALUES (?, ?, ?)`, id, uid, role); err != nil {
			return nil, err
		}
	}
	return h.convByID(ctx, id)
}

func nilIfFalsy(v any) any { return platform.SQLParam(platform.Or(v, nil)) }

func (h *handlers) isParticipantOf(ctx context.Context, convID, userID string) (bool, error) {
	rows, err := h.db.Rows(ctx, "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?", convID, userID)
	return len(rows) > 0, err
}

func (h *handlers) participantRole(ctx context.Context, convID, userID string) (string, bool, error) {
	row, err := h.db.First(ctx, "SELECT role FROM conversation_participants WHERE conversation_id = ? AND user_id = ?", convID, userID)
	if err != nil || row == nil {
		return "", false, err
	}
	return row.Str("role"), true, nil
}

func (h *handlers) countParticipants(ctx context.Context, convID string) (int64, error) {
	row, err := h.db.First(ctx, "SELECT COUNT(*) as count FROM conversation_participants WHERE conversation_id = ?", convID)
	if err != nil || row == nil {
		return 0, err
	}
	return row.Int("count"), nil
}

// byUser charge les conversations d'un utilisateur en 3 requêtes (pas de N+1).
func (h *handlers) byUser(ctx context.Context, userID string) ([]*platform.Object, error) {
	rows, err := h.db.Rows(ctx,
		`SELECT c.id, c.type, c.name, c.avatar_url, c.owner_id, c.is_open,
              c.created_at, c.updated_at
       FROM conversations c
       JOIN conversation_participants cp ON c.id = cp.conversation_id
       WHERE cp.user_id = ?
       ORDER BY c.updated_at DESC`, userID)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.Str("id")
	}
	ph, args := placeholders(len(ids)), idsToArgs(ids)

	allParticipants, err := h.db.Rows(ctx,
		`SELECT cp.conversation_id, cp.user_id, cp.role, cp.joined_at, cp.last_read_at,
              u.username, u.display_name, u.avatar_url, u.is_online
       FROM conversation_participants cp
       LEFT JOIN users u ON cp.user_id = u.id
       WHERE cp.conversation_id IN (`+ph+`)`, args...)
	if err != nil {
		return nil, err
	}
	lastMsgs, err := h.db.Rows(ctx,
		`SELECT m.conversation_id, m.id, m.content, m.sender_content, m.sender_id,
              m.e2ee_type, m.created_at
       FROM messages m
       INNER JOIN (
         SELECT conversation_id, MAX(created_at) AS max_ts
         FROM messages
         WHERE conversation_id IN (`+ph+`)
         GROUP BY conversation_id
       ) latest ON m.conversation_id = latest.conversation_id
              AND m.created_at = latest.max_ts`, args...)
	if err != nil {
		return nil, err
	}

	byConv := map[string][]any{}
	for _, p := range allParticipants {
		id := p.Str("conversation_id")
		byConv[id] = append(byConv[id], participantFrom(p))
	}
	lastByConv := map[string]*platform.Object{}
	for _, lm := range lastMsgs {
		lastByConv[lm.Str("conversation_id")] = lm
	}

	out := make([]*platform.Object, len(rows))
	for i, c := range rows {
		ps := byConv[c.Str("id")]
		if ps == nil {
			ps = []any{}
		}
		lm := lastByConv[c.Str("id")]
		var lmContent, lmID, lmSender, lmSenderContent, lmType any
		lmAt := c.Get("updated_at")
		if lm != nil {
			lmContent, lmID, lmSender = lm.Get("content"), lm.Get("id"), lm.Get("sender_id")
			lmSenderContent, lmType = lm.Get("sender_content"), lm.Get("e2ee_type")
			lmAt = lm.Get("created_at")
		}
		out[i] = platform.O("id", c.Get("id"), "type", convType(c.Get("type")), "name", c.Get("name"),
			"avatarUrl", c.Get("avatar_url"), "ownerId", c.Get("owner_id"), "isOpen", c.Get("is_open") != int64(0),
			"participants", ps, "participantIds", participantIDs(ps),
			"createdAt", c.Get("created_at"), "updatedAt", c.Get("updated_at"),
			"lastMessage", lmContent, "lastMessageId", lmID, "lastMessageSenderId", lmSender,
			"lastMessageSenderContent", lmSenderContent, "lastMessageE2eeType", lmType, "lastMessageAt", lmAt)
	}
	return out, nil
}

func (h *handlers) findOrCreateDM(ctx context.Context, a, b string) (*platform.Object, error) {
	row, err := h.db.First(ctx,
		`SELECT c.id FROM conversations c
       JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.user_id = ?
       JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id = ?
       WHERE c.type IN ('dm', 'direct')`, a, b)
	if err != nil {
		return nil, err
	}
	if row != nil {
		return h.convByID(ctx, row.Get("id"))
	}
	return h.createConversation(ctx, "dm", []string{a, b}, nil, nil, "", nil)
}

func (h *handlers) removeParticipantRow(ctx context.Context, convID, userID string) error {
	if _, err := h.db.Exec(ctx, "DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = ?", convID, userID); err != nil {
		return err
	}
	_, err := h.db.Exec(ctx, "UPDATE conversations SET updated_at = NOW() WHERE id = ?", convID)
	return err
}

func (h *handlers) leaveGroup(ctx context.Context, convID, userID string) (*platform.Object, error) {
	role, ok, err := h.participantRole(ctx, convID, userID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("Utilisateur non participant")
	}
	count, err := h.countParticipants(ctx, convID)
	if err != nil {
		return nil, err
	}
	if count <= 1 {
		if _, err := h.db.Exec(ctx, "DELETE FROM conversations WHERE id = ?", convID); err != nil {
			return nil, err
		}
		return platform.O("deleted", true), nil
	}
	var newOwner any
	if role == "owner" {
		row, err := h.db.First(ctx, `SELECT user_id FROM conversation_participants
         WHERE conversation_id = ? AND user_id != ?
         ORDER BY joined_at ASC LIMIT 1`, convID, userID)
		if err != nil {
			return nil, err
		}
		if row != nil {
			newOwner = row.Get("user_id")
			id := row.Str("user_id")
			for _, q := range []struct {
				sql  string
				args []any
			}{
				{"UPDATE conversations SET owner_id = ?, updated_at = NOW() WHERE id = ?", []any{id, convID}},
				{"UPDATE conversation_participants SET role = 'owner' WHERE conversation_id = ? AND user_id = ?", []any{convID, id}},
				{"UPDATE conversation_participants SET role = 'member' WHERE conversation_id = ? AND user_id != ? AND role = 'owner'", []any{convID, id}},
			} {
				if _, err := h.db.Exec(ctx, q.sql, q.args...); err != nil {
					return nil, err
				}
			}
		}
	}
	if err := h.removeParticipantRow(ctx, convID, userID); err != nil {
		return nil, err
	}
	res := platform.O("deleted", false)
	if newOwner != nil {
		res.Set("newOwnerId", newOwner)
	}
	return res, nil
}

// blockedAmong : candidats qui ont bloqué `requester` ou que `requester` a bloqués.
func (h *handlers) blockedAmong(ctx context.Context, requester string, candidates []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(candidates) == 0 {
		return out, nil
	}
	ph := placeholders(len(candidates))
	args := append(append(idsToArgs(candidates), requester, requester), idsToArgs(candidates)...)
	rows, err := h.db.Rows(ctx,
		`SELECT user_id, friend_id FROM friends
     WHERE status = 'blocked'
       AND ((user_id IN (`+ph+`) AND friend_id = ?) OR (user_id = ? AND friend_id IN (`+ph+`)))`, args...)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		if r.Str("user_id") == requester {
			out[r.Str("friend_id")] = true
		} else {
			out[r.Str("user_id")] = true
		}
	}
	return out, nil
}

// ── Handlers ──────────────────────────────────────────────────────────────

// GET /conversations
func (h *handlers) listConversations(w http.ResponseWriter, r *http.Request) {
	userID := platform.UserID(r)
	if userID == "" {
		platform.Error(w, 401, "Non authentifié")
		return
	}
	convs, err := h.byUser(r.Context(), userID)
	if err != nil {
		fail(w, "Erreur récupération conversations:", err)
		return
	}
	out := make([]any, len(convs))
	for i, c := range convs {
		item := platform.O("id", c.Get("id"), "type", c.Get("type"), "name", c.Get("name"), "avatarUrl", c.Get("avatarUrl"), "ownerId", c.Get("ownerId"))
		if c.Get("type") == "dm" {
			for _, id := range c.Get("participantIds").([]any) {
				if id != userID {
					item.Set("recipientId", id)
					break
				}
			}
		}
		item.Set("participantIds", c.Get("participantIds")).Set("participants", c.Get("participants")).
			Set("createdAt", c.Get("createdAt")).Set("updatedAt", c.Get("updatedAt")).
			Set("lastMessage", c.Get("lastMessage")).Set("lastMessageId", c.Get("lastMessageId")).
			Set("lastMessageSenderId", c.Get("lastMessageSenderId")).Set("lastMessageSenderContent", c.Get("lastMessageSenderContent")).
			Set("lastMessageE2eeType", c.Get("lastMessageE2eeType")).Set("lastMessageAt", platform.Or(c.Get("lastMessageAt"), c.Get("updatedAt")))
		out[i] = item
	}
	platform.JSON(w, 200, out)
}

// POST /conversations
func (h *handlers) createConv(w http.ResponseWriter, r *http.Request) {
	ctx, body, userID := r.Context(), platform.Body(r), platform.UserID(r)
	if userID == "" {
		platform.Error(w, 401, "Non authentifié")
		return
	}
	typ := body.Get("type")

	// Le créateur fait partie de la conversation ; seuls les UUID valides sont gardés.
	seen := map[string]bool{}
	var participants []string
	add := func(v any) {
		if s, ok := v.(string); ok && uuidRe.MatchString(s) && !seen[s] {
			seen[s] = true
			participants = append(participants, s)
		}
	}
	add(userID)
	if list, ok := body.Get("participantIds").([]any); ok {
		for _, v := range list {
			add(v)
		}
	}
	var others []string
	for _, id := range participants {
		if id != userID {
			others = append(others, id)
		}
	}
	blocked, err := h.blockedAmong(ctx, userID, others)
	if err != nil {
		fail(w, "Erreur création conversation:", err)
		return
	}
	var kept []string
	for _, id := range participants {
		if !blocked[id] {
			kept = append(kept, id)
		}
	}
	participants = kept
	if len(participants) < 2 {
		platform.Error(w, 400, "Au moins deux participants sont requis")
		return
	}
	if len(participants) > maxGroupSize {
		platform.Error(w, 400, "Un groupe compte au plus 100 participants")
		return
	}
	if typ == "dm" && len(participants) != 2 {
		platform.Error(w, 400, "Un MP compte exactement deux participants")
		return
	}
	owner := ""
	if typ == "group" {
		owner = userID
	}
	conv, err := h.createConversation(ctx, typ, participants, body.Get("name"), body.Get("avatarUrl"), owner, body.Get("isOpen"))
	if err != nil {
		fail(w, "Erreur création conversation:", err)
		return
	}
	slog.Info("Conversation créée: " + conv.Str("id") + " (type: " + platform.JSString(typ) + ")")
	platform.JSON(w, 201, conv)
}

// POST /conversations/dm — trouver ou créer un MP.
func (h *handlers) dm(w http.ResponseWriter, r *http.Request) {
	userID := platform.UserID(r)
	if userID == "" {
		platform.Error(w, 401, "Non authentifié")
		return
	}
	recipient := platform.JSString(platform.Body(r).Get("recipientId"))
	conv, err := h.findOrCreateDM(r.Context(), userID, recipient)
	if err != nil {
		fail(w, "Erreur création DM:", err)
		return
	}
	platform.JSON(w, 200, platform.O("id", conv.Get("id"), "type", "dm", "participantIds", conv.Get("participantIds"),
		"participants", conv.Get("participants"), "createdAt", conv.Get("createdAt")))
}

// GET /conversations/user/:userId
func (h *handlers) convsOfUser(w http.ResponseWriter, r *http.Request) {
	ctx, userID := r.Context(), platform.UserID(r)
	if r.PathValue("userId") != userID {
		platform.Error(w, 403, "Accès non autorisé")
		return
	}
	convs, err := h.byUser(ctx, userID)
	if err != nil {
		fail(w, "Erreur récupération conversations:", err)
		return
	}
	out := make([]any, len(convs))
	for i, c := range convs {
		row, err := h.db.First(ctx, `SELECT COUNT(*) as count FROM messages m
       JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id
       WHERE m.conversation_id = ? AND cp.user_id = ?
       AND m.created_at > COALESCE(cp.last_read_at, '1970-01-01')
       AND m.sender_id != ?`, c.Str("id"), userID, userID)
		if err != nil {
			fail(w, "Erreur récupération conversations:", err)
			return
		}
		var unread any = int64(0)
		if row != nil && platform.Truthy(row.Get("count")) {
			unread = row.Get("count")
		}
		c.Set("unreadCount", unread)
		out[i] = c
	}
	platform.JSON(w, 200, out)
}

// GET /conversations/pinned
func (h *handlers) pinned(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.Rows(r.Context(), "SELECT conversation_id, pin_order FROM pinned_conversations WHERE user_id = ? ORDER BY pin_order ASC", platform.UserID(r))
	if err != nil {
		serverError(w)
		return
	}
	out := make([]any, len(rows))
	for i, p := range rows {
		out[i] = platform.O("conversationId", p.Get("conversation_id"), "pinOrder", p.Get("pin_order"))
	}
	platform.JSON(w, 200, out)
}

// GET /conversations/:conversationId
func (h *handlers) getConv(w http.ResponseWriter, r *http.Request) {
	ctx, id, userID := r.Context(), r.PathValue("conversationId"), platform.UserID(r)
	if userID == "" {
		platform.Error(w, 401, "Non authentifié")
		return
	}
	conv, err := h.convByID(ctx, id)
	if err != nil {
		fail(w, "Erreur récupération conversation:", err)
		return
	}
	if conv == nil {
		platform.Error(w, 404, "Conversation non trouvée")
		return
	}
	ok, err := h.isParticipantOf(ctx, id, userID)
	if err != nil {
		fail(w, "Erreur récupération conversation:", err)
		return
	}
	if !ok {
		platform.Error(w, 403, "Accès non autorisé")
		return
	}
	platform.JSON(w, 200, conv)
}

// PATCH /conversations/:conversationId
func (h *handlers) updateConv(w http.ResponseWriter, r *http.Request) {
	ctx, id, userID, body := r.Context(), r.PathValue("conversationId"), platform.UserID(r), platform.Body(r)
	f := func(err error) { fail(w, "Erreur mise à jour conversation:", err) }
	ok, err := h.isParticipantOf(ctx, id, userID)
	if err != nil {
		f(err)
		return
	}
	if !ok {
		platform.Error(w, 403, "Accès non autorisé")
		return
	}
	isOpen := platform.GetPath(body, "isOpen")
	if isOpen != platform.Undefined {
		role, _, err := h.participantRole(ctx, id, userID)
		if err != nil {
			f(err)
			return
		}
		if role != "owner" {
			platform.Error(w, 403, "Seul le propriétaire peut ouvrir ou fermer le groupe")
			return
		}
	}
	var fields []string
	var args []any
	if v := platform.GetPath(body, "name"); v != platform.Undefined {
		fields, args = append(fields, "name = ?"), append(args, platform.SQLParam(v))
	}
	if v := platform.GetPath(body, "avatarUrl"); v != platform.Undefined {
		fields, args = append(fields, "avatar_url = ?"), append(args, platform.SQLParam(v))
	}
	if isOpen != platform.Undefined {
		n := 0
		if platform.Truthy(isOpen) {
			n = 1
		}
		fields, args = append(fields, "is_open = ?"), append(args, n)
	}
	if len(fields) > 0 {
		fields = append(fields, "updated_at = NOW()")
		q := "UPDATE conversations SET "
		for i, s := range fields {
			if i > 0 {
				q += ", "
			}
			q += s
		}
		if _, err := h.db.Exec(ctx, q+" WHERE id = ?", append(args, id)...); err != nil {
			f(err)
			return
		}
	}
	updated, err := h.convByID(ctx, id)
	if err != nil {
		f(err)
		return
	}
	platform.JSON(w, 200, updated)
}

// GET /conversations/:conversationId/participants (interne)
func (h *handlers) participantsList(w http.ResponseWriter, r *http.Request) {
	ps, err := h.participants(r.Context(), r.PathValue("conversationId"))
	if err != nil {
		serverError(w)
		return
	}
	out := make([]any, len(ps))
	for i, p := range ps {
		out[i] = platform.O("userId", p.(*platform.Object).Get("userId"))
	}
	platform.JSON(w, 200, platform.O("participants", out))
}

// GET /conversations/:conversationId/participants/:userId/check (interne)
func (h *handlers) participantCheck(w http.ResponseWriter, r *http.Request) {
	ok, err := h.isParticipantOf(r.Context(), r.PathValue("conversationId"), r.PathValue("userId"))
	if err != nil {
		serverError(w)
		return
	}
	platform.JSON(w, 200, platform.O("isParticipant", ok))
}

// POST /conversations/:conversationId/participants
func (h *handlers) addParticipant(w http.ResponseWriter, r *http.Request) {
	ctx, id, requester, body := r.Context(), r.PathValue("conversationId"), platform.UserID(r), platform.Body(r)
	f := func(err error) { fail(w, "Erreur ajout participant:", err) }
	ok, err := h.isParticipantOf(ctx, id, requester)
	if err != nil {
		f(err)
		return
	}
	if !ok {
		platform.Error(w, 403, "Accès non autorisé")
		return
	}
	conv, err := h.convByID(ctx, id)
	if err != nil {
		f(err)
		return
	}
	if conv == nil || conv.Get("type") != "group" {
		platform.Error(w, 400, "Seuls les groupes acceptent de nouveaux membres")
		return
	}
	if conv.Get("isOpen") == false && conv.Str("ownerId") != requester {
		platform.Error(w, 403, "Ce groupe est fermé. Seul le propriétaire peut ajouter des membres.")
		return
	}
	userID, isStr := body.Get("userId").(string)
	if !isStr || !uuidRe.MatchString(userID) {
		platform.Error(w, 400, "userId invalide")
		return
	}
	blocked, err := h.blockedAmong(ctx, requester, []string{userID})
	if err != nil {
		f(err)
		return
	}
	if len(blocked) > 0 {
		platform.Error(w, 403, "Impossible d'ajouter cet utilisateur")
		return
	}
	count, err := h.countParticipants(ctx, id)
	if err != nil {
		f(err)
		return
	}
	if count >= maxGroupSize {
		platform.Error(w, 400, "Un groupe compte au plus 100 participants")
		return
	}
	if _, err := h.db.Exec(ctx, `INSERT IGNORE INTO conversation_participants (conversation_id, user_id, role)
       VALUES (?, ?, 'member')`, id, userID); err != nil {
		f(err)
		return
	}
	if _, err := h.db.Exec(ctx, "UPDATE conversations SET updated_at = NOW() WHERE id = ?", id); err != nil {
		f(err)
		return
	}
	slog.Info("Participant ajouté: " + userID + " -> " + id)
	updated, err := h.convByID(ctx, id)
	if err != nil {
		f(err)
		return
	}
	platform.JSON(w, 200, updated)
}

// DELETE /conversations/:conversationId/participants/:userId
func (h *handlers) removeParticipant(w http.ResponseWriter, r *http.Request) {
	ctx, id, userID, requester := r.Context(), r.PathValue("conversationId"), r.PathValue("userId"), platform.UserID(r)
	role, ok, err := h.participantRole(ctx, id, requester)
	if err != nil {
		fail(w, "Erreur retrait participant:", err)
		return
	}
	if !ok {
		platform.Error(w, 403, "Accès non autorisé")
		return
	}
	if requester != userID && role != "owner" && role != "admin" {
		platform.Error(w, 403, "Permissions insuffisantes")
		return
	}
	if err := h.removeParticipantRow(ctx, id, userID); err != nil {
		fail(w, "Erreur retrait participant:", err)
		return
	}
	slog.Info("Participant retiré: " + userID + " <- " + id)
	platform.JSON(w, 200, platform.O("success", true))
}

// POST /conversations/:conversationId/leave
func (h *handlers) leave(w http.ResponseWriter, r *http.Request) {
	res, err := h.leaveGroup(r.Context(), r.PathValue("conversationId"), platform.UserID(r))
	if err != nil {
		fail(w, "Erreur quitter groupe:", err)
		return
	}
	slog.Info("Utilisateur " + platform.UserID(r) + " a quitté le groupe " + r.PathValue("conversationId"))
	platform.JSON(w, 200, res)
}

// DELETE /conversations/:conversationId — propriétaire seulement.
func (h *handlers) deleteConv(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), r.PathValue("conversationId")
	role, _, err := h.participantRole(ctx, id, platform.UserID(r))
	if err != nil {
		fail(w, "Erreur suppression conversation:", err)
		return
	}
	if role != "owner" {
		platform.Error(w, 403, "Seul le propriétaire peut supprimer le groupe")
		return
	}
	if _, err := h.db.Exec(ctx, "DELETE FROM conversations WHERE id = ?", id); err != nil {
		fail(w, "Erreur suppression conversation:", err)
		return
	}
	slog.Info("Conversation supprimée: " + id)
	platform.JSON(w, 200, platform.O("success", true))
}

// POST /conversations/:conversationId/pin
func (h *handlers) pin(w http.ResponseWriter, r *http.Request) {
	ctx, userID := r.Context(), platform.UserID(r)
	row, err := h.db.First(ctx, "SELECT COALESCE(MAX(pin_order),-1) as maxOrd FROM pinned_conversations WHERE user_id = ?", userID)
	if err != nil {
		serverError(w)
		return
	}
	maxOrd := int64(-1)
	if row != nil && row.Get("maxOrd") != nil {
		maxOrd = row.Int("maxOrd")
	}
	pinOrder := maxOrd + 1
	if _, err := h.db.Exec(ctx, "INSERT IGNORE INTO pinned_conversations (user_id, conversation_id, pin_order) VALUES (?, ?, ?)",
		userID, r.PathValue("conversationId"), pinOrder); err != nil {
		serverError(w)
		return
	}
	platform.JSON(w, 200, platform.O("success", true, "pinOrder", pinOrder))
}

// DELETE /conversations/:conversationId/pin
func (h *handlers) unpin(w http.ResponseWriter, r *http.Request) {
	if _, err := h.db.Exec(r.Context(), "DELETE FROM pinned_conversations WHERE user_id = ? AND conversation_id = ?",
		platform.UserID(r), r.PathValue("conversationId")); err != nil {
		serverError(w)
		return
	}
	platform.JSON(w, 200, platform.O("success", true))
}

var _ = sort.Strings
