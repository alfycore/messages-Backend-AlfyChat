import { ResultSetHeader, RowDataPacket, PoolConnection } from 'mysql2/promise';
interface DatabaseConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}
export declare function getDatabaseClient(config?: DatabaseConfig): {
    query<T extends RowDataPacket[]>(sql: string, params?: any[]): Promise<T[]>;
    execute(sql: string, params?: any[]): Promise<ResultSetHeader>;
    transaction<T>(callback: (conn: PoolConnection) => Promise<T>): Promise<T>;
};
export declare function runMigrations(db: ReturnType<typeof getDatabaseClient>): Promise<void>;
export {};
//# sourceMappingURL=database.d.ts.map