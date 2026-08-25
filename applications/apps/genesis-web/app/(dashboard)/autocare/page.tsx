/**
 * /autocare — RFC-0003 F5: rótulo EXTERNO do plano de sustentação ("Auto Care").
 * "Deadpool" é o codinome INTERNO — o gateway (`/api/deadpool/*`) e a subárvore
 * operacional (incidentes, base de conhecimento) permanecem sob `/deadpool`. Esta
 * rota reexporta o mesmo dashboard para que a entrada de menu não exponha o codinome.
 */
export { default } from "../deadpool/page";
