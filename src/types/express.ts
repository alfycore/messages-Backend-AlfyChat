// ==========================================
// ALFYCHAT - TYPES EXPRESS ÉTENDUS (MESSAGES)
// ==========================================

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
