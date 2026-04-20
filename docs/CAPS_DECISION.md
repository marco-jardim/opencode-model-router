# Tool-Call Caps Decision

Preencha os valores que quer aplicar. Serão usados para atualizar `tiers.json` e `src/index.ts`.

## 1. Caps por tier

Máximo de chamadas read-only (grep, glob, read, ls, bash-read) antes de:
- subagente **retornar** (mesmo que parcial) ou
- orquestrador ser **obrigado** a dispatch @fast.

| Alvo            | Conservador | Balanceado | Agressivo | SUA ESCOLHA |
|-----------------|-------------|------------|-----------|-------------|
| @fast           | 12          | 8          | 5         | 8 |
| @medium         | 6           | 4          | 2         | 5 |
| @heavy          | 4           | 3          | 2         | 3 |
| Orquestrador    | 3           | 2          | 1         | 2 |

## 2. Dureza da linguagem

Escolha UMA:

- [ ] **hard**   — "Hard cap: exceder = violação. Pare e retorne mesmo sem resposta completa; devolva `NEED CONTEXT` se precisar de mais."
- [ x] **target** — "Target cap: exceda apenas com justificativa explícita de 1 linha no retorno (`reason: ...`)."

## 3. Exceções opcionais

- [x ] Modo `quality` ignora caps (permite exploração mais profunda)
- [x ] Modo `deep` ignora caps para @heavy
- [x ] Modo `budget` usa variante MAIS AGRESSIVA que a escolhida acima

## 4. Notas livres

quero q os agentes detectem se já estão realizando leituras ou tarefas redundantes. se estiverem, parem e retornem com o resultado ate o momento e decida se pede mais uma rodada ao principal, se pede pro principal terminar ou se dá por encerrado com o q já tem pois já atendeu ao pedido do prompt de lançamento do subagente.
