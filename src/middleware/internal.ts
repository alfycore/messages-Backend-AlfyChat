// ==========================================
// ALFYCHAT - MIDDLEWARE APPELS INTERNES
// ==========================================
// Protège les routes inter-services (gateway → messages).
// Vérifie le header X-Internal-Secret avec une comparaison timing-safe.

import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function internalOnly(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-internal-secret'] as string | undefined;
  if (!INTERNAL_SECRET || !safeCompare(secret || '', INTERNAL_SECRET)) {
    res.status(403).json({ error: 'Accès interdit — réservé aux services internes' });
    return;
  }
  next();
}
