// RFC-0003 U#7: rota descontinuada. O Splitter deixou de ser um MENU — virou a ação VIVA
// "Decompor" dentro da Bancada (/specs): decompor uma SPEC salva ou "Decompor uma ideia"
// (texto cru). Mantemos a rota como redirect para não quebrar links/bookmarks antigos.
import { redirect } from "next/navigation";

export default function DeprecatedSplitterRedirect() {
  redirect("/specs");
}
