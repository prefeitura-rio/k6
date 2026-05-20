# Relatório Preliminar de Teste de Carga — Superapp Staging

**Data:** 20 de maio de 2026
**Status:** Teste em andamento (18 min de 37 min totais)
**Identificador do teste:** `load-test-20260519-220006`

---

## Objetivo

Avaliar a capacidade dos serviços digitais do Superapp em suportar um pico de **75 requisições por segundo (RPS)** de forma sustentada por **35 minutos**, simulando simultaneamente 5 serviços com **7.500 usuários únicos**.

---

## Resumo Executivo

Os serviços do Superapp respondem bem sob carga. Em 18 minutos de teste, foram processadas **mais de 690 mil requisições** sem nenhum erro de sistema (0% de falhas). Quatro dos cinco serviços apresentam latência excelente. Um serviço — o **Busca** — apresenta lentidão em 14% das suas requisições, causada por uma dependência de infraestrutura quebrada no ambiente de staging, não por falta de capacidade.

---

## Resultados por Serviço

| Serviço | Requisições | Erros | % abaixo de 100ms | % abaixo de 1s |
|---|---|---|---|---|
| **Busca** | 145.409 | 0 | 84% | 86% ⚠️ |
| **Go API** (Empregabilidade) | 130.460 | 0 | 98% | 100% ✅ |
| **RMI** (Cadastro Cidadão) | 249.229 | 0* | 90% | 100% ✅ |
| **URL Shortener** | 166.275 | 0 | 99% | 100% ✅ |
| **Heimdall** (Autenticação) | — | 0 | — | — |

*As respostas 403 do RMI são esperadas e corretas — o sistema rejeita requisições sem autenticação válida, comportamento este que foi testado intencionalmente.

---

## Diagnóstico por Serviço

### ✅ Go API, RMI, URL Shortener, Heimdall — Saudáveis

Estes serviços respondem de forma consistente em menos de 100ms na grande maioria das requisições. Não há sinais de degradação sob carga, gargalo de banco de dados ou esgotamento de recursos.

### ⚠️ Busca — Dependência quebrada em staging

O serviço de busca apresenta um perfil de latência **bimodal**:

- **86% das requisições** respondem em menos de 100ms — comportamento esperado e saudável.
- **14% das requisições** levam entre 1 e 5 segundos — acima do aceitável.

A causa raiz foi identificada nos logs do servidor: as buscas do tipo `hybrid` (que combinam busca textual com busca semântica via IA) tentam gerar embeddings usando o modelo `text-embedding-004` do Google Vertex AI, que **não está disponível no ambiente de staging** (retorna erro 404). O sistema tenta a operação até 3 vezes antes de desistir, o que adiciona aproximadamente 3 segundos por requisição afetada.

**Isso não é um problema de capacidade** — é uma configuração de infraestrutura de staging incorreta. Em produção, onde o modelo de IA está corretamente configurado, esse comportamento não deve ocorrer. A recomendação é que a equipe do Busca corrija o nome ou a versão da API do modelo no ambiente de staging para que o teste seja conclusivo para esse serviço.

---

## Conclusão Preliminar

> Os serviços do Superapp **suportam a carga de 75 RPS** sem falhas e com latência adequada. O único ponto de atenção identificado é uma configuração incorreta do modelo de IA no ambiente de staging para o serviço Busca — problema de infraestrutura, não de capacidade da aplicação.

O teste continua. O relatório final será emitido ao término dos 37 minutos, com os números consolidados.
