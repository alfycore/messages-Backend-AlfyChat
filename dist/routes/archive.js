"use strict";
// ==========================================
// ALFYCHAT - ROUTES ARCHIVAGE DM
// API REST pour le système hybride MP
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.archiveRouter = void 0;
const express_1 = require("express");
const express_validator_1 = require("express-validator");
const validate_1 = require("../middleware/validate");
const auth_1 = require("../middleware/auth");
const dm_archive_service_1 = require("../services/dm-archive.service");
const logger_1 = require("../utils/logger");
const dmArchiveService = new dm_archive_service_1.DMArchiveService();
exports.archiveRouter = (0, express_1.Router)();
// Récupérer le statut d'archive d'une conversation DM
exports.archiveRouter.get('/status/:conversationId', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString().notEmpty(), validate_1.validateRequest, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const status = await dmArchiveService.getArchiveStatus(conversationId);
        res.json(status);
    }
    catch (error) {
        logger_1.logger.error('Erreur récupération statut archive:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Récupérer les stats d'une conversation DM
exports.archiveRouter.get('/stats/:conversationId', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString().notEmpty(), validate_1.validateRequest, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const stats = await dmArchiveService.getConversationStats(conversationId);
        res.json(stats);
    }
    catch (error) {
        logger_1.logger.error('Erreur récupération stats:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Vérifier le quota d'une conversation DM
exports.archiveRouter.get('/quota/:conversationId', auth_1.authMiddleware, (0, express_validator_1.param)('conversationId').isString().notEmpty(), validate_1.validateRequest, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const quota = await dmArchiveService.checkQuota(conversationId);
        res.json(quota);
    }
    catch (error) {
        logger_1.logger.error('Erreur vérification quota:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Confirmer la réception d'un archivage par un peer
exports.archiveRouter.post('/confirm', auth_1.authMiddleware, (0, express_validator_1.body)('conversationId').isString().notEmpty(), (0, express_validator_1.body)('archiveLogId').isString().notEmpty(), validate_1.validateRequest, async (req, res) => {
    try {
        const userId = req.userId;
        const { conversationId, archiveLogId } = req.body;
        const allConfirmed = await dmArchiveService.confirmArchive(conversationId, archiveLogId, userId);
        res.json({
            success: true,
            allConfirmed,
            message: allConfirmed
                ? 'Tous les peers ont confirmé, messages supprimés du serveur'
                : 'Confirmation enregistrée, en attente des autres peers'
        });
    }
    catch (error) {
        logger_1.logger.error('Erreur confirmation archive:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Récupérer un message archivé (cherche dans cache Redis d'abord)
exports.archiveRouter.get('/message/:messageId', auth_1.authMiddleware, (0, express_validator_1.param)('messageId').isString().notEmpty(), validate_1.validateRequest, async (req, res) => {
    try {
        const { messageId } = req.params;
        const cached = await dmArchiveService.getCachedArchivedMessage(messageId);
        if (cached) {
            res.json({ source: 'cache', message: cached });
        }
        else {
            // Le message n'est pas en cache → il faut demander aux peers via WebSocket
            res.json({ source: 'peer_needed', message: null });
        }
    }
    catch (error) {
        logger_1.logger.error('Erreur récupération message archivé:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Mettre en cache un message récupéré d'un peer (appelé par le gateway)
exports.archiveRouter.post('/cache', (0, express_validator_1.body)('messages').isArray({ min: 1 }), validate_1.validateRequest, async (req, res) => {
    try {
        const { messages } = req.body;
        await dmArchiveService.cacheBulkArchivedMessages(messages);
        res.json({ success: true, cached: messages.length });
    }
    catch (error) {
        logger_1.logger.error('Erreur mise en cache:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Déclencher la maintenance manuelle (admin only)
exports.archiveRouter.post('/maintenance', auth_1.authMiddleware, async (req, res) => {
    try {
        const result = await dmArchiveService.runDailyMaintenance();
        res.json({
            success: true,
            ...result,
        });
    }
    catch (error) {
        logger_1.logger.error('Erreur maintenance:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
//# sourceMappingURL=archive.js.map