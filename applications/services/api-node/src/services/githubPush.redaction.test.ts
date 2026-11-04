/**
 * githubPush.redaction.test.ts — M-01 (revisão adversarial da Fase 1'): o token da instalação do GitHub NUNCA pode
 * aparecer em mensagem de erro do `git fetch` (gravada em `projects.extra`, devolvida na resposta e logada).
 *
 * Hermético: um servidor HTTP local faz de "GitHub", recusa tudo com 401 e registra o cabeçalho `Authorization`
 * recebido — prova que (1) a autenticação AINDA chega ao remote (via GIT_CONFIG_*), e (2) o token falso não aparece
 * em nenhuma saída (error de gitLinkProjectFolder / fetchAndResetBranch, nem no argv do processo git).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redactSecrets } from "../lib/redactSecrets.js";

const execFileAsync = promisify(execFile);
const FAKE_TOKEN = "ghs_FAKEFAKEFAKEFAKEFAKEFAKE0123456789";
const FAKE_B64 = Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString("base64");

vi.mock("./github.js", () => ({
  getInstallationTokenForClone: async () => "ghs_FAKEFAKEFAKEFAKEFAKEFAKE0123456789",
  repoShortName: (f: string) => (f.split("/").pop() ?? f),
}));

let server: http.Server;
let remoteUrl = "";
const seenAuth: string[] = [];
let ROOT = "";
let gitLinkProjectFolder: typeof import("./githubPush.js").gitLinkProjectFolder;
let fetchAndResetBranch: typeof import("./githubPush.js").fetchAndResetBranch;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="x"');
    res.end("denied");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  remoteUrl = `http://127.0.0.1:${port}/org/repo.git`;
  const base = await mkdtemp(join(tmpdir(), "gitredact-"));
  ROOT = join(base, "uploads");
  process.env.PROJECT_FILES_ROOT = ROOT;
  ({ gitLinkProjectFolder, fetchAndResetBranch } = await import("./githubPush.js"));
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

function expectNoSecret(s: unknown) {
  const text = JSON.stringify(s ?? "");
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain(FAKE_B64);
  expect(text).not.toMatch(/x-access-token:[A-Za-z0-9_]/);
  expect(text).not.toMatch(/Basic [A-Za-z0-9+/=]{16,}/);
}

describe("M-01 — token fora do argv e fora das mensagens de erro", () => {
  it("controle: o estilo antigo (-c http.extraheader=… no argv) VAZA na mensagem do execFile (o teste enxerga o defeito)", async () => {
    let msg = "";
    try {
      await execFileAsync("git", ["-C", tmpdir(), "-c", `http.extraheader=Authorization: Basic ${FAKE_B64}`, "ls-remote", remoteUrl], { timeout: 20_000 });
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(FAKE_B64);
  });

  it("fetchAndResetBranch: falha de fetch ⇒ erro sem token, e o servidor recebeu o cabeçalho (auth continua funcionando)", async () => {
    const projectId = "p-redact-1";
    const apps = join(ROOT, projectId, "apps");
    await mkdir(apps, { recursive: true });
    await execFileAsync("git", ["-C", apps, "init", "-q", "-b", "dev"]);
    await execFileAsync("git", ["-C", apps, "remote", "add", "origin", remoteUrl]);
    seenAuth.length = 0;
    const res = await fetchAndResetBranch({ localPath: apps, branch: "dev", token: FAKE_TOKEN });
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toMatch(/fetch/);
    expectNoSecret(res);
    expect(seenAuth.some((h) => h === `Basic ${FAKE_B64}`)).toBe(true);
  });

  it("gitLinkProjectFolder: todo o caminho de erro está limpo", async () => {
    const projectId = "p-redact-2";
    await mkdir(join(ROOT, projectId, "apps"), { recursive: true });
    const res = await gitLinkProjectFolder({ projectId, fullName: "org/repo", installationId: 1, branch: "dev", remoteUrl });
    expect(res.ok).toBe(false);
    expectNoSecret(res);
  });
});

describe("redactSecrets", () => {
  it("mascara Authorization/Basic/Bearer/x-access-token/ghs_/URL com credencial/extraheader/literais", () => {
    const raw = [
      `Command failed: git -c http.extraheader=Authorization: Basic ${FAKE_B64} fetch origin dev`,
      `Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789`,
      `https://x-access-token:${FAKE_TOKEN}@github.com/o/r.git`,
      `fatal: ${FAKE_TOKEN} e ${FAKE_B64}`,
      `https://user:s3nh4@host.example/x`,
      `github_pat_11ABCDEFG0123456789_abcdefghijklmnop`,
    ].join("\n");
    const out = redactSecrets(raw, [FAKE_TOKEN]);
    expectNoSecret(out);
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("s3nh4");
    expect(out).not.toContain("github_pat_11ABCDEFG");
    expect(out).toContain("[REDACTED]");
  });
  it("não altera texto sem segredo e aceita não-string", () => {
    expect(redactSecrets("fatal: couldn't find remote ref dev")).toBe("fatal: couldn't find remote ref dev");
    expect(redactSecrets("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
    expect(redactSecrets(undefined)).toBe("");
    expect(redactSecrets(new Error("Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ== x"))).toContain("[REDACTED]");
  });
});
