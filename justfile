set quiet
set shell := ["bash", "-euo", "pipefail", "-c"]

env_name := env("ENV", "staging")
namespace := "k6-operator-system"
run_id := `date +%y%m%d%H%M`

run +scripts:
    #!/usr/bin/env bash
    : "${KUBE_CONTEXT:?KUBE_CONTEXT is not set}"
    SCRIPTS=({{ scripts }})
    PREFIX="${SCRIPTS[0]%%--*}"
    BASE_ID="${PREFIX}--{{ env_name }}--$([ "${SMOKE:-false}" = "true" ] && echo sm || echo lt)--{{ run_id }}"
    echo "[→] BASE_ID: ${BASE_ID}"
    SCENARIO_COUNT="${#SCRIPTS[@]}" python3 -m scripts.submit "${BASE_ID}" {{ scripts }}

report base_id +scripts:
    #!/usr/bin/env bash
    ENV="{{ env_name }}" python3 -m scripts.report "{{ base_id }}" {{ scripts }}

tail base_id +scripts:
    #!/usr/bin/env bash
    : "${KUBE_CONTEXT:?KUBE_CONTEXT is not set}"
    : "${TAIL_WAIT_TIMEOUT:=120s}"
    LOG_DIR="${LOG_DIR:-reports/logs}"
    mkdir -p "${LOG_DIR}"
    for script in {{ scripts }}; do
        SUFFIX="${script#*--}"
        TESTRUN="{{ base_id }}--${SUFFIX}"
        kubectl --context="${KUBE_CONTEXT}" -n "{{ namespace }}" wait \
            --for=condition=Ready \
            --timeout="${TAIL_WAIT_TIMEOUT}" \
            pod -l "k6_cr=${TESTRUN},runner=true"
        POD=$(kubectl --context="${KUBE_CONTEXT}" -n "{{ namespace }}" get pods \
            -l "k6_cr=${TESTRUN},runner=true" --field-selector=status.phase=Running \
            -o jsonpath='{.items[0].metadata.name}')
        kubectl --context="${KUBE_CONTEXT}" -n "{{ namespace }}" logs -f "${POD}" \
            | tee "${LOG_DIR}/${TESTRUN}.log" &
    done

    wait

list:
    #!/usr/bin/env bash
    : "${KUBE_CONTEXT:?KUBE_CONTEXT is not set}"
    kubectl --context="${KUBE_CONTEXT}" -n "{{ namespace }}" get testruns -o wide
