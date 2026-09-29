#!/usr/bin/env bash
# Gate de testes do deploy (npm run test:deploy), em grupos que rodam ao mesmo tempo:
#
# - puros: em paralelo e SEM DATABASE_URL, nas mesmas condições do Mac local.
#   Um teste que tocasse o banco sem citar isso no arquivo não alcança o banco
#   aqui, então não atropela os de banco;
# - de banco (o arquivo cita getDb( ou DATABASE_URL): um arquivo por vez, porque
#   dividem o mesmo DATABASE_URL e, em paralelo, um apagava o dado do outro;
# - --com-meal-breaks: tests/telegram-meal-breaks.test.ts, que trava sob
#   isolamento e roda com isolation=none (CI de PR).
#
# Cada grupo grava a saída num arquivo; ao fim, imprime os três em ordem e sai
# com falha se qualquer um falhou.
set -uo pipefail
cd "$(dirname "$0")/.."

puros=()
banco=()
while IFS= read -r arquivo; do
    if grep -qE 'getDb\(|DATABASE_URL' "$arquivo"; then
        banco+=("$arquivo")
    else
        puros+=("$arquivo")
    fi
done < <(find tests -name '*.test.ts' ! -name 'telegram-meal-breaks.test.ts' | sort)

saida=$(mktemp -d)
grupos=()
pids=()

env -u DATABASE_URL node --test --import tsx "${puros[@]}" >"$saida/puros.log" 2>&1 &
grupos+=("puros (${#puros[@]} arquivos, em paralelo)")
pids+=($!)

node --test --test-concurrency=1 --import tsx "${banco[@]}" >"$saida/banco.log" 2>&1 &
grupos+=("banco (${#banco[@]} arquivos, um por vez)")
pids+=($!)

if [[ "${1:-}" == "--com-meal-breaks" ]]; then
    # A flag virou --test-isolation (estável) só no Node 23+.
    if [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 23 ]]; then
        isolamento=--test-isolation=none
    else
        isolamento=--experimental-test-isolation=none
    fi
    node --test --import tsx "$isolamento" tests/telegram-meal-breaks.test.ts >"$saida/meal.log" 2>&1 &
    grupos+=("meal-breaks (isolation=none)")
    pids+=($!)
fi

logs=("$saida/puros.log" "$saida/banco.log" "$saida/meal.log")
falhou=0
for i in "${!pids[@]}"; do
    status=0
    wait "${pids[$i]}" || status=$?
    echo "::group::${grupos[$i]} — saída $status"
    cat "${logs[$i]}"
    echo "::endgroup::"
    if [[ $status -ne 0 ]]; then
        echo "FALHOU: ${grupos[$i]}"
        grep -E '^ℹ (tests|pass|fail)' "${logs[$i]}" || true
        falhou=1
    fi
done
rm -rf "$saida"
exit $falhou
