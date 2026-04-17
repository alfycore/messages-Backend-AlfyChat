import { Request, Response } from 'express';
export declare class ConversationController {
    /** POST / — Créer une conversation (DM ou groupe) */
    create(req: Request, res: Response): Promise<void>;
    /** GET /:conversationId — Récupérer une conversation par ID */
    getById(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /** GET /user/:userId — Conversations de l'utilisateur authentifié */
    getByUser(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /** POST /dm — Trouver ou créer un DM */
    findOrCreateDM(req: Request, res: Response): Promise<void>;
    /** PATCH /:conversationId — Mettre à jour (nom, avatar) */
    update(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /** POST /:conversationId/participants — Ajouter un participant */
    addParticipant(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /** DELETE /:conversationId/participants/:userId — Retirer un participant */
    removeParticipant(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    /** POST /:conversationId/leave — Quitter un groupe */
    leave(req: Request, res: Response): Promise<void>;
    /** DELETE /:conversationId — Supprimer une conversation (owner only) */
    delete(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
}
export declare const conversationController: ConversationController;
//# sourceMappingURL=conversations.controller.d.ts.map