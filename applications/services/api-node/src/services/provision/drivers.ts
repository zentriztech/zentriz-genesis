/**
 * drivers.ts — G1-T13 (Fase C). Barrel de REGISTRO dos drivers da cadeia.
 *
 * Importar este módulo (side-effect) garante que todos os drivers chamem
 * registerDriver() antes de runProvisionChain() percorrer a cadeia. Cada tarefa
 * T13-T20 adiciona UMA linha de import aqui — sem tocar o motor (provisionChain).
 *
 * Ordem de import é irrelevante: a ordem de EXECUÇÃO vem de CHAIN_ORDER.
 */

import "./iam.js";        // G1-T13
import "./networking.js"; // G1-T14
import "./rds.js";        // G1-T15
import "./secrets.js";    // G1-T15
import "./migrating.js";  // G1-T16
// import "./ecs.js";        // G1-T17
// import "./alb.js";        // G1-T18
