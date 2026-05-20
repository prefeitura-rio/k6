set quiet
set shell := ["bash", "-euo", "pipefail", "-c"]

error := '\033[31m[✗]\033[0m'
env_name := env("ENV", "staging")
namespace := "k6-operator-system"
run_id := `date +%Y%m%d-%H%M%S`

[private]
check-deps:
    #!/usr/bin/env bash
    if ! command -v kubectl &>/dev/null; then
        echo -e "{{ error }} kubectl not found"
        exit 1
    fi

[private]
check-scripts scripts:
    #!/usr/bin/env bash
    IFS=',' read -ra SCRIPTS <<< "{{ scripts }}"

    if [[ ${#SCRIPTS[@]} -eq 0 ]]; then
        echo -e "{{ error }} scripts= must not be empty"
        exit 1
    fi

    PREFIX=""
    for script in "${SCRIPTS[@]}"; do
        p="${script%%--*}"
        if [[ -z "$PREFIX" ]]; then
            PREFIX="$p"
        elif [[ "$PREFIX" != "$p" ]]; then
            echo -e "{{ error }} mixed prefixes: '$PREFIX' and '$p' — all scripts must share the same prefix"
            exit 1
        fi
    done

    context=$(python3 -m scripts.clusters "$PREFIX" "{{ env_name }}")

    if ! kubectl config get-contexts "$context" &>/dev/null; then
        echo -e "{{ error }} context '$context' not found — check your credentials"
        exit 1
    fi

# Submit a load test and tail logs. Pass smoke=true for a single smoke iteration.
run scripts smoke="false": check-deps (check-scripts scripts)
    #!/usr/bin/env bash
    IFS=',' read -ra SCRIPTS <<< "{{ scripts }}"
    PREFIX="${SCRIPTS[0]%%--*}"
    [[ "{{ smoke }}" == "true" ]] && KIND="smoke" || KIND="load-test"
    BASE_ID="${PREFIX}--{{ env_name }}--${KIND}--{{ run_id }}"
    python3 -m scripts.submit "$BASE_ID" "{{ scripts }}" {{ if smoke == "true" { "--smoke" } else { "" } }}
    python3 -m scripts.tail "$BASE_ID" "{{ scripts }}"

# Regenerate a combined report from a past testrun without resubmitting.
report base_id scripts testrun="" interpret="true":
    #!/usr/bin/env bash
    TESTRUN="{{ if testrun != "" { testrun } else { base_id } }}"
    INTERP="{{ if interpret == "true" { "" } else { "--no-interpretation" } }}"
    ENV="{{ env_name }}" python3 -m scripts.report "{{ base_id }}" "{{ scripts }}" "$TESTRUN" $INTERP

# Stream logs from all TestRun pods for a given base ID and scripts list.
tail base_id scripts:
    ENV="{{ env_name }}" python3 -m scripts.tail "{{ base_id }}" "{{ scripts }}"

# List all TestRuns in the namespace.
list:
    #!/usr/bin/env bash
    context=$(python3 -m scripts.clusters "${PREFIX:-superapp}" "{{ env_name }}")
    kubectl --context="$context" -n "{{ namespace }}" get testruns -o wide

# Show the full YAML status of a TestRun.
status id:
    #!/usr/bin/env bash
    context=$(python3 -m scripts.clusters "${PREFIX:-superapp}" "{{ env_name }}")
    kubectl --context="$context" -n "{{ namespace }}" get testrun "{{ id }}" -o yaml
