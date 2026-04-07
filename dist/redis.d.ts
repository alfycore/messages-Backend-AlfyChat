interface RedisConfig {
    host: string;
    port: number;
    password?: string;
}
export declare function getRedisClient(config?: RedisConfig): {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttl?: number): Promise<void>;
    del(key: string): Promise<void>;
};
export {};
//# sourceMappingURL=redis.d.ts.map