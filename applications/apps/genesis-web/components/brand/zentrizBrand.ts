/**
 * zentrizBrand.ts — a IDENTIDADE da Zentriz dentro do portal Genesis.
 *
 * Fonte única dos valores: o Manual de Marca v1.0 materializado em
 * `zentriz-landpage/src/brand/tokens.ts` (paleta) e nos assets do Drive
 * (`zentriz-landpage/drive-zentriz/Zentriz/{Marca,Grafismos}` → normalizados em
 * `zentriz-landpage/src/brand/{marca,grafismos}`). Aqui os hexes são LITERAIS de propósito:
 * o portal Genesis não consome o pacote de marca da landpage (repos separados, sem npm privado),
 * então copiar o valor com a procedência anotada é honesto — inventar tom próximo não seria.
 *
 * ⚠️ Regra de ouro da marca: texto claro exige fundo escuro. Toda tela que usa `INK` como fundo
 * precisa fixar as cores do texto (não herdar `text.primary`, que vira escuro no tema claro).
 */

/** Paleta (tokens `color.*` da landpage). */
export const zentrizColor = {
  /** `tinta` — fundo institucional (herói sempre em tinta). */
  ink: "#0D0916",
  /** `fio` — linha estrutural sobre tinta (1,15:1 — só grafismo, nunca texto). */
  thread: "#201636",
  /** `markInk` — tinta da marca (usada na aguada do símbolo). */
  markInk: "#150F24",
  /** `papel` / `markPaper` — o claro da marca, para texto e marca negativa sobre tinta. */
  paper: "#F7F7FA",
  markPaper: "#F2F0F7",
  /** Estados semânticos: construção (Genesis), conexão (Connect), cura (Auto Care). */
  construcaoOnInk: "#8A71F9",
  conexao: "#3FA0F0",
  cura: "#28D2AA",
  /** Rampa de neutros do kit (ADR-007). */
  neutro100: "#C9C3D8",
  neutro400: "#A79FC0",
  neutro500: "#6E6788",
  neutro600: "#6B62A0",
  neutro800: "#4A4270",
} as const;

/**
 * As três peças da Autonomy Suite, **nesta ordem** (Genesis → Connect → Auto Care), com a cor de
 * estado que a marca lhes atribui (`SuiteCards.tsx` da landpage: genesis=construção,
 * connect=conexão, autoCare=cura). O laço não tem fim: Auto Care realimenta o Genesis.
 */
export const suiteStations = [
  { id: "genesis", name: "Genesis", role: "Constrói", color: zentrizColor.construcaoOnInk },
  { id: "connect", name: "Connect", role: "Contrata", color: zentrizColor.conexao },
  { id: "autoCare", name: "Auto Care", role: "Cura", color: zentrizColor.cura },
] as const;

/** Posicionamento oficial da marca (Manifesto de Marca, Drive → Conceito do Nome). */
export const ZENTRIZ_TAGLINE = "A porta de entrada para tecnologia inteligente";
