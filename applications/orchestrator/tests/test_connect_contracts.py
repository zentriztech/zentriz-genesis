"""
Smoke tests for connect_contracts.py — validates that build_* functions
produce payloads that pass schema validation for all three stages.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from orchestrator.connect_contracts import (
    CONNECT_SCHEMA_VERSION,
    build_connect_artifacts_for_stage,
    build_system_passport,
    build_ownership_manifest,
    build_service_manifests,
    build_observability_baseline_manifest,
    build_runtime_passport,
    build_known_safe_actions_pack,
    build_integration_ready_contract,
    build_reconciliation_report,
    validate_connect_artifact,
)


def _ctx(**kwargs):
    defaults = dict(
        project_id="test-project-001",
        product_spec="# API Voucher Service\n\nA simple voucher management API.",
        spec_raw="# API Voucher Service\n\nA simple voucher management API.",
        charter="CTO approved. Backend squad: 2 devs. REST API with PostgreSQL.",
        backlog="Tasks: implement voucher CRUD, auth, tests, Docker.",
        engineer_proposal="Node.js backend + PostgreSQL. CI via GitHub Actions.",
        current_module="backend",
        artifacts={"apps/api/index.js": "// entry", "Dockerfile": "FROM node:18"},
        connect_artifacts={},
        connect_version=CONNECT_SCHEMA_VERSION,
    )
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


class TestBuildFunctions:
    def test_system_passport_has_required_fields(self):
        payload = build_system_passport(_ctx())
        assert payload["schemaVersion"] == CONNECT_SCHEMA_VERSION
        assert "systemId" in payload
        assert "owners" in payload
        assert isinstance(payload["owners"], list)

    def test_ownership_manifest_has_required_fields(self):
        payload = build_ownership_manifest(_ctx())
        assert payload["schemaVersion"] == CONNECT_SCHEMA_VERSION
        assert "systemId" in payload
        assert "owners" in payload

    def test_service_manifests_returns_list(self):
        manifests = build_service_manifests(_ctx())
        assert isinstance(manifests, list)
        assert len(manifests) >= 1
        for m in manifests:
            assert "schemaVersion" in m
            assert "serviceId" in m

    def test_observability_baseline_manifest_has_required_fields(self):
        payload = build_observability_baseline_manifest(_ctx())
        assert payload["schemaVersion"] == CONNECT_SCHEMA_VERSION
        assert "systemId" in payload
        assert "requiredSignals" in payload

    def test_runtime_passport_has_required_fields(self):
        payload = build_runtime_passport(_ctx())
        assert payload["schemaVersion"] == CONNECT_SCHEMA_VERSION
        assert "systemId" in payload
        assert "runtimeType" in payload

    def test_known_safe_actions_pack_has_required_fields(self):
        payload = build_known_safe_actions_pack(_ctx())
        assert payload["schemaVersion"] == CONNECT_SCHEMA_VERSION
        assert "systemId" in payload
        assert "actions" in payload


class TestSchemaValidation:
    def test_validate_connect_artifact_pass(self):
        payload = build_system_passport(_ctx())
        errors = validate_connect_artifact("SystemPassport", payload)
        assert errors == [], f"SystemPassport validation errors: {errors}"

    def test_validate_connect_artifact_ownership(self):
        payload = build_ownership_manifest(_ctx())
        errors = validate_connect_artifact("OwnershipManifest", payload)
        assert errors == [], f"OwnershipManifest validation errors: {errors}"

    def test_validate_connect_artifact_observability(self):
        payload = build_observability_baseline_manifest(_ctx())
        errors = validate_connect_artifact("ObservabilityBaselineManifest", payload)
        assert errors == [], f"ObservabilityBaselineManifest validation errors: {errors}"

    def test_validate_connect_artifact_runtime_passport(self):
        payload = build_runtime_passport(_ctx())
        errors = validate_connect_artifact("RuntimePassport", payload)
        assert errors == [], f"RuntimePassport validation errors: {errors}"

    def test_validate_connect_artifact_known_safe_actions(self):
        payload = build_known_safe_actions_pack(_ctx())
        errors = validate_connect_artifact("KnownSafeActionsPack", payload)
        assert errors == [], f"KnownSafeActionsPack validation errors: {errors}"


class TestBuildConnectArtifactsForStage:
    def test_charter_stage_emits_system_and_ownership(self):
        artifacts = build_connect_artifacts_for_stage(_ctx(), "charter")
        contracts = {a.contract for a in artifacts}
        assert "SystemPassport" in contracts
        assert "OwnershipManifest" in contracts

    def test_backlog_stage_emits_service_manifests(self):
        artifacts = build_connect_artifacts_for_stage(_ctx(), "backlog")
        assert all(a.contract == "ServiceManifest" for a in artifacts)
        assert len(artifacts) >= 1

    def test_devops_stage_emits_observability_runtime_safe_actions(self):
        artifacts = build_connect_artifacts_for_stage(_ctx(), "devops")
        contracts = {a.contract for a in artifacts}
        assert "ObservabilityBaselineManifest" in contracts
        assert "RuntimePassport" in contracts
        assert "KnownSafeActionsPack" in contracts

    def test_unknown_stage_raises(self):
        with pytest.raises(ValueError, match="Connect stage desconhecido"):
            build_connect_artifacts_for_stage(_ctx(), "unknown_stage")

    def test_artifacts_have_valid_json_paths(self):
        for stage in ("charter", "backlog", "devops"):
            artifacts = build_connect_artifacts_for_stage(_ctx(), stage)
            for a in artifacts:
                assert a.project_relative_path.startswith("project/connect/")
                assert a.project_relative_path.endswith(".json")

    def test_artifacts_serialize_to_json(self):
        import json
        for stage in ("charter", "backlog", "devops"):
            artifacts = build_connect_artifacts_for_stage(_ctx(), stage)
            for a in artifacts:
                json_str = a.to_json()
                parsed = json.loads(json_str)
                assert isinstance(parsed, dict)


class TestCanonicalIdentityR4PR1:
    """R4 PR1 — pré-requisito zero: systemId/serviceId canônicos vencem o 1º heading da spec."""

    def test_system_id_canonico_vence_heading(self):
        ctx = _ctx(system_id="controle-financeiro", service_id="cf-backend", product_name="Controle Financeiro")
        passport = build_system_passport(ctx)
        assert passport["systemId"] == "controle-financeiro"          # não "api-voucher-service"
        assert passport["displayName"] == "Controle Financeiro"
        for builder in (build_ownership_manifest, build_observability_baseline_manifest,
                        build_runtime_passport, build_known_safe_actions_pack, build_integration_ready_contract):
            assert builder(ctx)["systemId"] == "controle-financeiro"
        for m in build_service_manifests(ctx):
            assert m["systemId"] == "controle-financeiro"

    def test_fallback_product_name_depois_heading(self):
        assert build_system_passport(_ctx(product_name="Meu Produto"))["systemId"] == "meu-produto"
        # legado (sem produto): 1º heading
        assert build_system_passport(_ctx())["systemId"] == "api-voucher-service"

    def test_service_canonico_vem_primeiro_e_e_http(self):
        ctx = _ctx(system_id="controle-financeiro", service_id="cf-backend")
        manifests = build_service_manifests(ctx)
        assert manifests[0]["serviceId"] == "cf-backend"
        assert manifests[0]["interfaces"][0]["type"] == "http"
        assert build_system_passport(ctx)["services"][0] == "cf-backend"

    def test_solo_app_servico_e_o_sistema(self):
        ctx = _ctx(system_id="meu-app", service_id=None)
        assert build_service_manifests(ctx)[0]["serviceId"] == "meu-app"

    def test_sem_cap_de_tres_servicos(self):
        charter = " ".join(f"pagamentos-{i}-service" for i in range(6))
        manifests = build_service_manifests(_ctx(charter=charter, backlog="", engineer_proposal=""))
        assert len(manifests) >= 6

    def test_tier_declarado_conservador(self):
        passport = build_system_passport(_ctx())
        assert passport["integrationTier"] == "tier1-integration-ready"
        # coerência: não afirmar deadpoolReady enquanto declaramos tier1 (adversarial PR1 #3)
        assert passport["capabilityProfile"]["deadpoolReady"] is False

    def test_path_do_artefato_segue_versao_do_contexto(self):
        # adversarial PR1 #4: path registrado == versão que o runner passa ao storage
        artifacts = build_connect_artifacts_for_stage(_ctx(connect_version="9.9.9"), "charter")
        assert all(a.project_relative_path.startswith("project/connect/v9.9.9/") for a in artifacts)


class TestIntegrationReadyContractR4PR1:
    def test_emitido_no_estagio_devops(self):
        artifacts = build_connect_artifacts_for_stage(_ctx(), "devops")
        contracts = {a.contract: a for a in artifacts}
        assert "IntegrationReadyContract" in contracts
        assert contracts["IntegrationReadyContract"].filename == "integration-ready-contract.json"

    def test_valida_contra_schema_real(self):
        payload = build_integration_ready_contract(_ctx(system_id="x-sys"))
        errors = validate_connect_artifact("IntegrationReadyContract", payload)
        assert errors == [], errors
        assert payload["declaredTier"] == "tier1-integration-ready"
        assert payload["contactPoints"] and all("id" in c and "name" in c for c in payload["contactPoints"])


DECL = {
    "schemaVersion": "1.3.0", "systemId": "controle-financeiro", "serviceId": "cf-backend",
    "serviceName": "Controle Financeiro — Backend", "responsibility": "Lançamentos e contas (lado de escrita).",
    "interfaces": [
        {"name": "commands-http", "type": "http", "contractRef": "contratos.md#openapi"},
        {"name": "domain-events", "type": "event"},
        {"name": "nightly-close", "type": "cron"},
    ],
    "dependencies": ["cf-infra"],
    "events": {"publishes": ["lancamento.registrado"], "subscribes": []},
    "runtimeType": "container", "queues": ["cf.domain-events"],
    "healthModel": {"hasHealthEndpoint": True, "signals": ["custom_business_metric"], "sloCritical": True},
    "environments": [{"name": "prod", "type": "prod", "criticality": "high"}],
    "owners": {"technicalOwner": {"id": "cf-tech", "name": "Tech Lead", "email": "tech@x.com.br", "role": "tech-lead"},
               "productOwner": {"id": "cf-po", "name": "PO"}, "escalationPath": [{"id": "cf-cto", "name": "CTO"}]},
    "integrationTierTarget": "tier2-deadpool-ready",
}


def _dctx(**kw):
    base = dict(system_id="controle-financeiro", service_id="cf-backend", product_name="Controle Financeiro",
                project_type="backend_api", connect_declaration=dict(DECL))
    base.update(kw)  # kwargs do teste sobrescrevem (evita "multiple values for keyword")
    return _ctx(**base)


class TestSpecFirstRenderersR4PR4:
    """R4 PR4 — com connect.yaml, os manifests são RENDERIZADOS da declaração (não do regex)."""

    def test_service_manifest_unico_vem_da_declaracao(self):
        ms = build_service_manifests(_dctx())
        assert len(ms) == 1
        m = ms[0]
        assert m["serviceId"] == "cf-backend" and m["systemId"] == "controle-financeiro"
        assert m["responsibility"] == DECL["responsibility"]          # não o placeholder do Genesis
        assert m["dependencies"] == ["cf-infra"]                        # não project-storage/pipeline-context
        assert [i["type"] for i in m["interfaces"]] == ["http", "event", "cron"]
        assert m["healthModel"]["hasHealthEndpoint"] is True and m["healthModel"]["sloCritical"] is True
        assert "custom_business_metric" in m["healthModel"]["signals"] and "http_5xx_rate" in m["healthModel"]["signals"]
        assert "task_success_rate" not in m["healthModel"]["signals"]  # métrica do pipeline do Genesis banida

    def test_owners_reais_em_passport_ownership_e_irc(self):
        ctx = _dctx()
        passport = build_system_passport(ctx)
        assert passport["owners"][0]["id"] == "cf-tech" and passport["owners"][0]["email"] == "tech@x.com.br"
        assert not any("Genesis" in o["name"] for o in passport["owners"])
        own = build_ownership_manifest(ctx)["owners"][0]
        assert own["scope"] == "cf-backend" and own["technicalOwner"]["id"] == "cf-tech" and own["productOwner"]["id"] == "cf-po"
        irc = build_integration_ready_contract(ctx)
        assert irc["contactPoints"][0]["id"] == "cf-tech"
        assert any("declarados" in n for n in irc["notes"])
        assert passport["environments"] == [{"name": "prod", "type": "prod", "criticality": "high"}]
        assert passport["services"] == ["cf-backend", "cf-infra"]
        assert "tier-target://tier2-deadpool-ready" in passport["policyReferences"]

    def test_runtime_e_observabilidade_do_produto_nao_do_genesis(self):
        rt = build_runtime_passport(_dctx())
        assert rt["runtimeType"] == "container"
        assert rt["queues"] == ["cf.domain-events"] and rt["jobs"] == ["nightly-close"]
        assert rt["criticalServices"] == ["cf-infra"]
        assert "monitor-loop" not in rt["jobs"] and "project-storage" not in rt["criticalServices"]
        types = {e["type"] for e in rt["entrypoints"]}
        assert {"http", "cron"} <= types and "webhook" not in types
        obs = build_observability_baseline_manifest(_dctx())
        assert "pipeline-overview" not in obs["requiredDashboards"]
        assert "http_5xx_rate_high" in obs["requiredAlerts"] and "queue_lag_high" in obs["requiredAlerts"]

    def test_safe_actions_por_forma_do_servico_sem_acao_do_genesis(self):
        pack = build_known_safe_actions_pack(_dctx())
        ids = {a["actionId"] for a in pack["actions"]}
        assert "replay-monitor-loop" not in ids
        assert {"cf-backend-restart", "cf-backend-requeue-dlq", "cf-backend-invalidate-cache"} <= ids
        assert all(a["requiresApproval"] is True for a in pack["actions"])

    def test_todos_os_manifests_spec_first_validam_no_schema_real(self):
        for stage in ("charter", "backlog", "devops"):
            for a in build_connect_artifacts_for_stage(_dctx(), stage):
                if a.contract == "ReconciliationReport":
                    continue
                assert validate_connect_artifact(a.contract, a.payload) == [], (a.contract, validate_connect_artifact(a.contract, a.payload))

    def test_legado_sem_declaracao_mantem_heuristica_mas_sem_metricas_do_genesis(self):
        ms = build_service_manifests(_ctx())
        assert len(ms) >= 1
        assert ms[0]["serviceId"] == "backend-core" or "voucher" in ms[0]["serviceId"]  # regex legado (fallback ou candidato)
        obs = build_observability_baseline_manifest(_ctx())
        assert "task_success_rate" not in obs["requiredSignals"]
        pack = build_known_safe_actions_pack(_ctx())
        assert all(a["actionId"] != "replay-monitor-loop" for a in pack["actions"])
        irc = build_integration_ready_contract(_ctx())
        assert any("SINTÉTICOS" in n for n in irc["notes"])


class TestReconciliationR4PR4:
    def test_sem_declaracao_not_applicable(self):
        r = build_reconciliation_report(_ctx())
        assert r["status"] == "not-applicable"

    def test_pending_sem_artefatos(self):
        assert build_reconciliation_report(_dctx(artifacts={}))["status"] == "pending"

    def test_clean_quando_codigo_evidencia_tudo(self):
        code = {"apps/api/app.ts": "const app = express(); app.get('/health'); eventBus.publish(x); cron.schedule('0 0 * * *', f)"}
        r = build_reconciliation_report(_dctx(artifacts=code))
        assert r["status"] == "clean" and r["declaredButMissing"] == [] and r["foundButUndeclared"] == []

    def test_divergent_faltando_e_nao_declarado(self):
        code = {"apps/api/app.ts": "const app = express(); app.get('/health'); const q = new Queue('x'); consume(q)"}
        r = build_reconciliation_report(_dctx(artifacts=code))
        assert r["status"] == "divergent"
        assert {m["type"] for m in r["declaredButMissing"]} == {"event", "cron"}
        assert [u["type"] for u in r["foundButUndeclared"]] == ["queue"]

    def test_emitido_no_estagio_devops(self):
        arts = build_connect_artifacts_for_stage(_dctx(), "devops")
        assert any(a.contract == "ReconciliationReport" and a.filename == "reconciliation.json" for a in arts)

    def test_sem_falsos_positivos_de_prosa_e_streams_de_arquivo(self):
        # adversarial PR4 #C: README com "Assess the cron jobs… Readable" + EventEmitter/createReadStream
        # em código NÃO podem virar divergência; e docs fora de apps/ não entram no corpus.
        decl = dict(DECL); decl["interfaces"] = [{"name": "commands-http", "type": "http"}]
        code = {
            "README.md": "Assess the cron jobs. Readable docs. sse. emit(",
            "docs/infra-deploy.md": "node-cron cron.schedule( new Queue(",
            "apps/api/app.ts": "const app = express(); app.get('/health'); emitter.emit('x'); fs.createReadStream(p); setInterval(f, 1000)",
        }
        r = build_reconciliation_report(_dctx(connect_declaration=decl, artifacts=code))
        assert r["status"] == "clean", r


class TestAdversarialPR4Fixes:
    def test_owners_parciais_nao_caem_no_sintetico(self):
        decl = dict(DECL); decl["owners"] = {"productOwner": {"id": "po-1", "name": "PO Real", "email": "po@x.com.br"}}
        ctx = _dctx(connect_declaration=decl)
        own = build_ownership_manifest(ctx)["owners"][0]
        assert own["technicalOwner"]["id"] == "po-1"  # PO responde como technicalOwner (fallback), não "Genesis CTO"
        assert build_system_passport(ctx)["owners"][0]["id"] == "po-1"
        assert validate_connect_artifact("OwnershipManifest", build_ownership_manifest(ctx)) == []

    def test_interfaces_vazias_ficam_vazias_e_infra_nao_ganha_http(self):
        decl = dict(DECL); decl["interfaces"] = []; decl.pop("healthModel", None)
        ctx = _dctx(connect_declaration=decl, project_type="other", current_module="backend", service_id="cf-infra")
        m = build_service_manifests(ctx)[0]
        assert m["interfaces"] == []
        assert m["healthModel"]["hasHealthEndpoint"] is False   # infra (`other`) não tem /health por inferência de módulo
        assert validate_connect_artifact("ServiceManifest", m) == []

    def test_gate_hard_lanca_e_warn_nao(self, monkeypatch):
        import orchestrator.runner as runner
        from orchestrator.pipeline_context import PipelineContext
        ctx = PipelineContext("p")
        monkeypatch.setattr(runner, "load_connect_declaration", lambda pid: (dict(DECL), ["x fora do enum"]))
        monkeypatch.setenv("CONNECT_DECLARATION_GATE", "warn")
        runner._apply_connect_declaration(ctx, "p")
        assert ctx.connect_declaration["serviceId"] == "cf-backend"
        monkeypatch.setenv("CONNECT_DECLARATION_GATE", "hard")
        with pytest.raises(runner.ConnectDeclarationGateError):
            runner._apply_connect_declaration(ctx, "p")

    def test_declaracao_do_disco_vence_checkpoint_stale(self, monkeypatch):
        import orchestrator.runner as runner
        from orchestrator.pipeline_context import PipelineContext
        ctx = PipelineContext("p")
        ctx.connect_declaration = {"serviceId": "cf-backend", "interfaces": [{"name": "old", "type": "http"}]}
        new = dict(DECL)
        monkeypatch.setattr(runner, "load_connect_declaration", lambda pid: (new, []))
        runner._apply_connect_declaration(ctx, "p")
        assert ctx.connect_declaration == new
        # disco sem declaração → mantém a do checkpoint
        monkeypatch.setattr(runner, "load_connect_declaration", lambda pid: (None, []))
        runner._apply_connect_declaration(ctx, "p")
        assert ctx.connect_declaration == new


class TestLoadConnectDeclarationR4PR4:
    """runner.load_connect_declaration: lê connect.yaml de project_spec_files via API; nunca lança."""

    def _patch(self, monkeypatch, entries):
        import orchestrator.runner as runner
        monkeypatch.setattr(runner, "_api_get", lambda path: (entries, 200))
        return runner

    def test_ausente_retorna_none_sem_erros(self, monkeypatch):
        runner = self._patch(monkeypatch, [{"filename": "01-spec.md", "mimeType": "text/markdown", "filePath": "/nope.md"}])
        assert runner.load_connect_declaration("p") == (None, [])

    def test_valido_retorna_declaracao_sem_erros(self, monkeypatch, tmp_path):
        import yaml
        f = tmp_path / "connect.yaml"
        f.write_text(yaml.safe_dump(DECL, sort_keys=False, allow_unicode=True), encoding="utf-8")
        runner = self._patch(monkeypatch, [{"filename": "connect.yaml", "mimeType": "application/yaml", "filePath": str(f)}])
        decl, errors = runner.load_connect_declaration("p")
        assert decl["serviceId"] == "cf-backend" and errors == []

    def test_invalido_no_schema_retorna_erros_mas_nao_lanca(self, monkeypatch, tmp_path):
        import yaml
        bad = dict(DECL); bad["interfaces"] = [{"name": "x", "type": "grpc-invalido"}]; bad["campoEstranho"] = 1
        f = tmp_path / "connect.yaml"
        f.write_text(yaml.safe_dump(bad), encoding="utf-8")
        runner = self._patch(monkeypatch, [{"filename": "connect.yaml", "mimeType": "application/yaml", "filePath": str(f)}])
        decl, errors = runner.load_connect_declaration("p")
        assert decl is not None and errors
        assert any("fora do enum" in e for e in errors) and any("campoEstranho" in e for e in errors)

    def test_yaml_quebrado_retorna_none_com_erro(self, monkeypatch, tmp_path):
        f = tmp_path / "connect.yaml"
        f.write_text("- isto: [não fecha", encoding="utf-8")
        runner = self._patch(monkeypatch, [{"filename": "connect.yaml", "mimeType": "application/yaml", "filePath": str(f)}])
        decl, errors = runner.load_connect_declaration("p")
        assert decl is None and errors


class TestPipelineContextIdentityRoundtrip:
    def test_checkpoint_preserva_identidade_connect(self, tmp_path):
        from orchestrator.pipeline_context import PipelineContext
        ctx = PipelineContext("p1")
        assert ctx.connect_version == CONNECT_SCHEMA_VERSION  # constante única
        ctx.system_id, ctx.service_id, ctx.product_name, ctx.product_id = "sys-a", "svc-b", "Produto A", "prod-uuid"
        ctx.connect_declaration = {"serviceId": "svc-b", "interfaces": []}
        ctx.save_checkpoint(tmp_path)
        restored = PipelineContext.load_checkpoint(tmp_path, "p1")
        assert (restored.system_id, restored.service_id, restored.product_name, restored.product_id) == ("sys-a", "svc-b", "Produto A", "prod-uuid")
        assert restored.connect_declaration == {"serviceId": "svc-b", "interfaces": []}
        # inputs dos agentes carregam a declaração (CTO/Engineer/PM)
        assert restored.build_inputs_for_cto("spec_intake_and_normalize")["connect_declaration"]["serviceId"] == "svc-b"
        assert restored.build_inputs_for_engineer()["connect_declaration"]["serviceId"] == "svc-b"
        assert restored.build_inputs_for_pm()["connect_declaration"]["serviceId"] == "svc-b"

    def test_checkpoint_legado_sem_identidade(self, tmp_path):
        import json
        from orchestrator.pipeline_context import PipelineContext
        (tmp_path / "p2").mkdir()
        (tmp_path / "p2" / "checkpoint.json").write_text(json.dumps({"project_id": "p2", "connect_version": "0.0.1"}))
        restored = PipelineContext.load_checkpoint(tmp_path, "p2")
        assert restored.system_id == "" and restored.service_id is None and restored.product_name == ""
        # connect_version NÃO é restaurada do checkpoint — sempre a constante do emissor (adversarial PR1 #4)
        assert restored.connect_version == CONNECT_SCHEMA_VERSION
