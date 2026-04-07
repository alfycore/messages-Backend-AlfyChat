"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRedisClient = getRedisClient;
const ioredis_1 = __importDefault(require("ioredis"));
let client = null;
function getRedisClient(config) {
    if (!client && config) {
        client = new ioredis_1.default({
            host: config.host,
            port: config.port,
            password: config.password,
        });
    }
    if (!client)
        throw new Error('Redis not initialized');
    return {
        async get(key) {
            return client.get(key);
        },
        async set(key, value, ttl) {
            if (ttl) {
                await client.setex(key, ttl, value);
            }
            else {
                await client.set(key, value);
            }
        },
        async del(key) {
            await client.del(key);
        },
    };
}
//# sourceMappingURL=redis.js.map