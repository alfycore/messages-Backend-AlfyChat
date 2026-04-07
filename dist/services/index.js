"use strict";
// ==========================================
// ALFYCHAT - INDEX DES SERVICES (MESSAGES)
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.DMArchiveService = exports.dmArchiveService = exports.ConversationService = exports.conversationService = exports.MessageService = exports.messageService = void 0;
var messages_service_1 = require("./messages.service");
Object.defineProperty(exports, "messageService", { enumerable: true, get: function () { return messages_service_1.messageService; } });
Object.defineProperty(exports, "MessageService", { enumerable: true, get: function () { return messages_service_1.MessageService; } });
var conversations_service_1 = require("./conversations.service");
Object.defineProperty(exports, "conversationService", { enumerable: true, get: function () { return conversations_service_1.conversationService; } });
Object.defineProperty(exports, "ConversationService", { enumerable: true, get: function () { return conversations_service_1.ConversationService; } });
var dm_archive_service_1 = require("./dm-archive.service");
Object.defineProperty(exports, "dmArchiveService", { enumerable: true, get: function () { return dm_archive_service_1.dmArchiveService; } });
Object.defineProperty(exports, "DMArchiveService", { enumerable: true, get: function () { return dm_archive_service_1.DMArchiveService; } });
//# sourceMappingURL=index.js.map