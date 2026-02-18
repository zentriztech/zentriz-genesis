import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const JWT_SECRET = process.env.JWT_SECRET ?? "zentriz-genesis-dev-secret";
const SALT_ROUNDS = 10;

/** Mínimos aceitáveis para senha (segurança) */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): boolean {
  return typeof email === "string" && EMAIL_REGEX.test(email.trim());
}

export function validatePassword(password: string): { ok: boolean; message?: string } {
  if (typeof password !== "string") return { ok: false, message: "Senha inválida" };
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, message: `Senha deve ter no mínimo ${PASSWORD_MIN_LENGTH} caracteres` };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, message: `Senha deve ter no máximo ${PASSWORD_MAX_LENGTH} caracteres` };
  }
  return { ok: true };
}

export type TokenPayload = {
  sub: string;
  email: string;
  role: string;
  tenantId: string | null;
};

export function signToken(payload: TokenPayload, expiresIn: string = "7d"): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions);
}

/** Token de curta duração para o runner (ex.: 1h). */
export function signTokenWithExpiry(payload: TokenPayload, expiresIn: string = "1h"): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
    return decoded;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
