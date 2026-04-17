"use strict";
// ==========================================
// ALFYCHAT - MIDDLEWARE APPELS INTERNES
// ==========================================
// Protège les routes inter-services (gateway → messages).
// Vérifie le header X-Internal-Secret avec une comparaison timing-safe.
Object.defineProperty(exports, "__esModule", { value: true });
exports.internalOnly = internalOnly;
const crypto_1 = require("crypto");
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
function safeCompare(a, b) {
    if (!a || !b)
        return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length)
        return false;
    return (0, crypto_1.timingSafeEqual)(bufA, bufB);
}
function internalOnly(req, res, next) {
    const secret = req.headers['x-internal-secret'];
    if (!INTERNAL_SECRET || !safeCompare(secret || '', INTERNAL_SECRET)) {
        res.status(403).json({ error: 'Accès interdit — réservé aux services internes' });
        return;
    }
    next();
}
//# sourceMappingURL=internal.js.map