"use strict";
// ==========================================
// ALFYCHAT - INDEX DES ROUTES (MESSAGES)
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationsRouter = exports.archiveRouter = exports.conversationsRouter = exports.messagesRouter = void 0;
var messages_1 = require("./messages");
Object.defineProperty(exports, "messagesRouter", { enumerable: true, get: function () { return messages_1.messagesRouter; } });
var conversations_1 = require("./conversations");
Object.defineProperty(exports, "conversationsRouter", { enumerable: true, get: function () { return conversations_1.conversationsRouter; } });
var archive_1 = require("./archive");
Object.defineProperty(exports, "archiveRouter", { enumerable: true, get: function () { return archive_1.archiveRouter; } });
var notifications_1 = require("./notifications");
Object.defineProperty(exports, "notificationsRouter", { enumerable: true, get: function () { return notifications_1.notificationsRouter; } });
//# sourceMappingURL=index.js.map