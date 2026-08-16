import { Request, Response } from "express";
import { verifyToken, TokenPayload } from "./auth.js";

export interface Context {
  req: Request;
  res: Response;
  user: TokenPayload | null;
}

export async function createContext({ req, res }: { req: Request; res: Response }): Promise<Context> {
  let user: TokenPayload | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      user = verifyToken(token);
    } catch {
      // Invalid token — user stays null
    }
  }

  return { req, res, user };
}
