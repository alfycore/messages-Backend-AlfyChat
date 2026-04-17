import { Request, Response } from 'express';
export declare class MessageController {
    search(req: Request, res: Response): Promise<void>;
    create(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    getByConversation(req: Request, res: Response): Promise<void>;
    getById(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    update(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    delete(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    addReaction(req: Request, res: Response): Promise<void>;
    removeReaction(req: Request, res: Response): Promise<void>;
    markAsRead(req: Request, res: Response): Promise<void>;
}
export declare const messageController: MessageController;
//# sourceMappingURL=messages.controller.d.ts.map