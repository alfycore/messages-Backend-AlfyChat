"use strict";
// ==========================================
// ALFYCHAT - SERVICE MESSAGES
// Chiffrement multi-niveaux pour messages privés
// ==========================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const dotenv_1 = __importDefault(require("dotenv"));
const messages_1 = require("./routes/messages");
const conversations_1 = require("./routes/conversations");
const archive_1 = require("./routes/archive");
const database_1 = require("./database");
const redis_1 = require("./redis");
const dm_archive_service_1 = require("./services/dm-archive.service");
const logger_1 = require("./utils/logger");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)({
    origin: process.env.GATEWAY_URL || 'http://localhost:3000',
    credentials: true,
}));
app.use((0, helmet_1.default)());
app.use(express_1.default.json());
// Routes
app.use('/messages', messages_1.messagesRouter);
app.use('/conversations', conversations_1.conversationsRouter);
app.use('/archive', archive_1.archiveRouter);
// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'messages' });
});
async function start() {
    try {
        const db = (0, database_1.getDatabaseClient)({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '3306'),
            user: process.env.DB_USER || 'alfychat',
            password: process.env.DB_PASSWORD || 'alfychat',
            database: process.env.DB_NAME || 'alfychat',
        });
        await (0, database_1.runMigrations)(db);
        (0, redis_1.getRedisClient)({
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD,
        });
        const PORT = process.env.PORT || 3002;
        app.listen(PORT, () => {
            logger_1.logger.info(`🚀 Service Messages démarré sur le port ${PORT}`);
            // Lancer la maintenance quotidienne DM (toutes les 24h)
            const MAINTENANCE_INTERVAL = 24 * 60 * 60 * 1000; // 24h
            setInterval(async () => {
                try {
                    logger_1.logger.info('⏰ Démarrage maintenance DM programmée...');
                    await dm_archive_service_1.dmArchiveService.runDailyMaintenance();
                }
                catch (error) {
                    logger_1.logger.error('Erreur maintenance DM programmée:', error);
                }
            }, MAINTENANCE_INTERVAL);
            logger_1.logger.info('📦 Système hybride DM activé (quota 20k/30j + P2P)');
        });
    }
    catch (error) {
        logger_1.logger.error('Erreur au démarrage:', error);
        process.exit(1);
    }
}
start();
exports.default = app;
//# sourceMappingURL=index.js.map