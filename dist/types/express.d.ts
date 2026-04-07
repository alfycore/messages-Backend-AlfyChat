import { Request } from 'express';
export interface AuthRequest extends Request {
    userId?: string;
}
declare global {
    namespace Express {
        interface Request {
            userId?: string;
        }
    }
}
//# sourceMappingURL=express.d.ts.map