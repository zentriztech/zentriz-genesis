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

/**
 * G1-T19: token de callback escopado por deployment.
 *
 * O callback do backend_deploy_runner (host) NÃO deve usar a role admin genérica
 * (GENESIS_API_TOKEN). Em vez disso, o orquestrador assina um token de escopo restrito,
 * válido só para UM deployment e por tempo curto. Se vazar, só permite reportar
 * progresso daquele deployment — não dá acesso admin a nada.
 *
 * Payload DEDICADO (não estende TokenPayload, que é fixo e usado em todo lugar).
 */
export type DeployCallbackPayload = {
  scope: "deploy-callback";
  deploymentId: string;
  projectId: string;
};

/** Assina um token de callback escopado a um deployment (default 2h — cobre build+push longo). */
export function signDeployCallbackToken(
  deploymentId: string,
  projectId: string,
  expiresIn: string = "2h",
): string {
  const payload: DeployCallbackPayload = { scope: "deploy-callback", deploymentId, projectId };
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions);
}

/**
 * Decodifica um token e devolve o payload SÓ se o claim `scope` for 'deploy-callback'
 * (sem checar deploymentId). Usado pelo middleware para reconhecer o token; a checagem
 * de binding (deploymentId/projectId) é feita na rota via verifyDeployCallbackToken.
 */
export function decodeDeployCallbackToken(token: string): DeployCallbackPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as Partial<DeployCallbackPayload>;
    if (decoded?.scope !== "deploy-callback" || !decoded.deploymentId || !decoded.projectId) return null;
    return decoded as DeployCallbackPayload;
  } catch {
    return null;
  }
}

/**
 * Verifica um token de callback e devolve o payload SÓ se o claim `scope` for
 * 'deploy-callback' e o `deploymentId`/`projectId` casarem com os esperados.
 * Token de outro deployment (ou admin genérico) → null.
 */
export function verifyDeployCallbackToken(
  token: string,
  expected: { deploymentId: string; projectId: string },
): DeployCallbackPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as Partial<DeployCallbackPayload>;
    if (decoded?.scope !== "deploy-callback") return null;
    if (decoded.deploymentId !== expected.deploymentId) return null;
    if (decoded.projectId !== expected.projectId) return null;
    return decoded as DeployCallbackPayload;
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
