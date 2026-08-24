import Redis from 'ioredis';

interface RedisConfig {
  host: string;
  port: number;
  password?: string;
}

let client: Redis | null = null;

export function getRedisClient(config?: RedisConfig) {
  if (!client && config) {
    client = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
    });
  }

  if (!client) throw new Error('Redis not initialized');

  return {
    async get(key: string): Promise<string | null> {
      return client!.get(key);
    },

    async set(key: string, value: string, ttl?: number): Promise<void> {
      if (ttl) {
        await client!.setex(key, ttl, value);
      } else {
        await client!.set(key, value);
      }
    },

    async del(...keys: string[]): Promise<void> {
      if (keys.length) await client!.del(...keys);
    },

    /**
     * Incrémente le compteur de version d'une conversation.
     *
     * Remplace l'invalidation par motif : `KEYS msg:<conv>:*` parcourait tout
     * l'espace de clés en BLOQUANT Redis — partagé par le gateway (adapter
     * Socket.IO, présence, rate limiting) et par tous les microservices. La
     * clé de cache embarque désormais la version : un simple INCR périme
     * l'ancienne, qui expire ensuite d'elle-même via son TTL.
     */
    async bumpCacheVersion(conversationId: string): Promise<number> {
      const v = await client!.incr(`msgver:${conversationId}`);
      // Le compteur n'a pas à vivre éternellement : une conversation inactive
      // repart de zéro sans risque, ses clés de cache ayant déjà expiré.
      await client!.expire(`msgver:${conversationId}`, 86400);
      return v;
    },

    async getCacheVersion(conversationId: string): Promise<string> {
      return (await client!.get(`msgver:${conversationId}`)) ?? '0';
    },
  };
}
