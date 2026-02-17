# Kubernetes — Zentriz Genesis

Manifests para o namespace **zentriz-genesis**. Uso local (minikube/kind) ou em cluster gerenciado (EKS, AKS, GKE).

## Aplicar

```bash
# Ordem: namespace primeiro, depois demais recursos
kubectl apply -f namespace.yaml
kubectl apply -f api-deployment.yaml

# Ou tudo de uma vez (namespace deve vir antes)
kubectl apply -f k8s/
```

## Integração com Terraform

Em cloud (AWS), o Terraform em [infra/aws/](../infra/aws/) pode provisionar o cluster EKS e, opcionalmente, aplicar estes manifests ou usar Helm. O namespace `zentriz-genesis` deve ser usado em todos os recursos.
