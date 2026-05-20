set quiet
set shell := ["bash", "-euo", "pipefail", "-c"]

error   := '\033[31m[✗]\033[0m'
context := "gke_rj-superapp-staging_us-central1_application"
namespace := "k6-operator-system"
run_id  := `date +%Y%m%d-%H%M%S`

default: run

[private]
check-deps:
    #!/usr/bin/env bash
    command -v kubectl &>/dev/null \
        || { echo -e "{{ error }} kubectl not found"; exit 1; }
    kubectl config get-contexts "{{ context }}" &>/dev/null \
        || { echo -e "{{ error }} context '{{ context }}' not found — run: just k8s"; exit 1; }

[private]
check-script:
    #!/usr/bin/env bash
    [[ -f "{{ justfile_directory() }}/load-test.js" ]] \
        || { echo -e "{{ error }} load-test.js not found"; exit 1; }

smoke: check-deps check-script
    #!/usr/bin/env bash
    set -euo pipefail
    ID="smoke-{{ run_id }}"
    python3 -m k6.submit "$ID" --smoke
    just tail "$ID"

run: check-deps check-script
    #!/usr/bin/env bash
    set -euo pipefail
    ID="load-test-{{ run_id }}"
    python3 -m k6.submit "$ID"
    just tail "$ID"

tail id:
    K6_CONTEXT="{{ context }}" K6_NAMESPACE="{{ namespace }}" \
        python3 -m k6.tail "{{ id }}"

list:
    kubectl --context="{{ context }}" -n "{{ namespace }}" get testruns -o wide

status id:
    kubectl --context="{{ context }}" -n "{{ namespace }}" get testrun "{{ id }}" -o yaml

[confirm("Delete TestRun and ConfigMap '{{id}}'?")]
delete id:
    kubectl --context="{{ context }}" -n "{{ namespace }}" delete testrun "{{ id }}" --ignore-not-found \
        && kubectl --context="{{ context }}" -n "{{ namespace }}" delete configmap "{{ id }}" --ignore-not-found \
        || true

[confirm("Delete ALL load-test-* TestRuns and ConfigMaps?")]
clean:
    kubectl --context="{{ context }}" -n "{{ namespace }}" delete testruns --all --ignore-not-found || true \
        && kubectl --context="{{ context }}" -n "{{ namespace }}" get configmaps -o name \
            | grep -v 'istio-ca-root-cert\|kube-root-ca' \
            | xargs -r kubectl --context="{{ context }}" -n "{{ namespace }}" delete || true

signoz:
    kubectl --context="{{ context }}" -n signoz port-forward svc/signoz-frontend 8080:8080

k8s:
    gcloud container clusters get-credentials application --region=us-central1 --project=rj-superapp-staging
