// RFC-0003 U#7: rota descontinuada. "Projetos do tenant" foi unificado em "Meus projetos"
// (/projects), que já escopa por tenant (seletor do topo para o master). Mantemos a rota
// como redirect para não quebrar links/bookmarks antigos.
import { redirect } from "next/navigation";

export default function DeprecatedTenantProjectsRedirect() {
  redirect("/projects");
}
