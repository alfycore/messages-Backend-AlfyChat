# AlfyChat — Service Messages

Microservice de gestion des messages pour AlfyChat.

![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go)
![License](https://img.shields.io/badge/License-Source_Available-blue)

## Rôle

Ce service gère l'ensemble de la messagerie : messages directs (DM), messages de salons de serveur, notifications persistantes, recherche et archivage. Il supporte plusieurs niveaux de chiffrement.

## Stack technique

| Catégorie | Technologies |
|-----------|-------------|
| Langage | Go 1.26 |
| API | net/http (stdlib) |
| Auth | JWT |
| Cache | Redis |
| Base de données | MySQL 8 |

## Architecture globale

```
Frontend (:4000)  →  Gateway (:3000)  →  Microservices
                                          ├── users    (:3001)
                                          ├── messages  (:3002)  ← ce service
                                          ├── friends   (:3003)
                                          ├── calls     (:3004)
                                          ├── servers   (:3005)
                                          ├── bots      (:3006)
                                          └── media     (:3007)
```

## Démarrage

### Prérequis

- [Go](https://go.dev/) ≥ 1.26
- MySQL 8
- Redis 7

### Variables d'environnement

```env
PORT=3002
DB_HOST=localhost
DB_PORT=3306
DB_USER=alfychat
DB_PASSWORD=
DB_NAME=alfychat_messages
REDIS_URL=redis://localhost:6379
JWT_SECRET=
SERVICE_REGISTRY_URL=http://gateway:3000
```

### Développement

```bash
go run .
```

### Build production

```bash
go build -o bin/service .
./bin/service
```

### Tests

```bash
go test ./...
```

### Docker

```bash
docker compose up messages
```

## Structure du projet

```
main.go                  # Point d'entrée
internal/
├── messages/            # Messages, conversations, notifications, archivage, base externe
└── platform/            # Socle commun aux services Go
```

## Contribution

Voir [CONTRIBUTING.md](./CONTRIBUTING.md).
