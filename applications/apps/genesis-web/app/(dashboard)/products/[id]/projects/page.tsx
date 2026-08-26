// RFC-0003 F3 / U#6: o drilldown "projetos do produto" foi unificado no layout canônico de
// "Meus apps" (/projects), que já filtra por produto via ?product=<id> — exibindo a mesma
// lista/cards com o cabeçalho "🧩 <produto> · N projeto(s)". Manter dois layouts divergentes
// (rollup + ondas aqui, cards lá) quebrava o padrão visual; a fonte de verdade agora é uma só.
// "Promover à fábrica" continua disponível por card em /products.
import { redirect } from "next/navigation";

export default function ProductProjectsRedirect({ params }: { params: { id: string } }) {
  redirect(`/projects?product=${params.id}`);
}
