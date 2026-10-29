// ==========================================
// ALFYCHAT - SERVICE MESSAGES
// Chiffrement multi-niveaux pour messages privés
// ==========================================

package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/alfychat/messages/internal/messages"
	"github.com/alfychat/messages/internal/platform"
)

func main() {
	platform.LoadEnv()
	platform.InitLogger()

	if len(platform.Env("ARCHIVE_DB_ENCRYPTION_KEY", "")) != 64 {
		slog.Warn("ARCHIVE_DB_ENCRYPTION_KEY absente ou invalide (64 caractères hex attendus) — la configuration de bases externes est désactivée.")
	}

	srv := platform.NewServer()
	// cors({ origin: GATEWAY_URL, credentials: true }) : une origine fixe pour tous.
	srv.CORSOrigin = platform.Env("GATEWAY_URL", "http://localhost:3000")
	auth := platform.NewAuth()
	auth.AllowNoUser = true

	voice := platform.Env("UPLOADS_DIR", "/uploads") + "/voice"
	if err := os.MkdirAll(voice, 0o755); err != nil {
		platform.Fatal("Création du dossier "+voice, err)
	}

	db, err := platform.OpenDatabaseSized("alfychat", "alfychat", 10)
	if err != nil {
		platform.Fatal("Erreur au démarrage", err)
	}
	if err := messages.Migrate(context.Background(), db); err != nil {
		platform.Fatal("Erreur au démarrage", err)
	}
	rdb, err := platform.NewRedis()
	if err != nil {
		platform.Fatal("Erreur au démarrage", err)
	}

	h := messages.Register(srv, db, rdb, auth)

	port := platform.Env("PORT", "3002")
	err = srv.Listen(port, func() {
		slog.Info("🚀 Service Messages démarré sur le port " + port)
		platform.StartServiceRegistration("messages")
		h.StartMaintenance()
	})
	if err != nil {
		platform.Fatal("Erreur au démarrage", err)
	}
}
