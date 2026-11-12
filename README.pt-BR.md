# gearness

[![CI](https://github.com/TomazAlexandre/gearness/actions/workflows/ci.yml/badge.svg)](https://github.com/TomazAlexandre/gearness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gearness)](https://www.npmjs.com/package/gearness)
[![license](https://img.shields.io/github/license/TomazAlexandre/gearness)](LICENSE)

**Harness engineering como código.** Crie, valide, pontue e evolua o *harness* que torna agentes de IA confiáveis no seu repositório.

🇺🇸 [Read in English](README.md)

## Por quê

`Agente = Modelo + Harness`. O modelo é o mesmo para todo mundo; o harness - instruções, documentação, checagens,
ciclos de feedback e guardrails ao redor dele - é o que faz o agente acertar **no seu código**. A maioria das equipes
monta isso no improviso: um `AGENTS.md` que só cresce, um `CLAUDE.md` que diverge das regras do Cursor, links quebrados
e o mesmo erro do agente corrigido à mão pela décima vez.

O gearness transforma o harness em um artefato que você **declara, verifica, mede e bloqueia no CI**, como testes ou infraestrutura.

- **Determinístico.** Sem chamadas a LLM nem rede. Roda no CI em menos de um segundo.
- **Agnóstico de agente.** `AGENTS.md` é a fonte única; os arquivos do Claude Code, Cursor e Copilot são gerados a partir dele. O Codex lê o `AGENTS.md` nativamente.
- **Não destrutivo.** Nunca sobrescreve arquivos escritos à mão. Instruções existentes são importadas, não perdidas.
- **Mede, não só gera.** Nota de 0 a 100 em seis pilares, com as correções de maior impacto primeiro.
- **Prova que funciona.** O `gearness eval` roda tarefas reais com o seu agente e compara versões do harness sobre o mesmo código.
- **Impõe a arquitetura.** Fronteiras entre camadas são verificadas nos imports reais (TS/JS, Python, Go).
- **Atua durante o trabalho do agente.** Um hook do Claude Code e um servidor MCP dão feedback segundos após cada edição, não minutos depois no CI.
- **Detecta e corrige documentação desatualizada.** Caminhos, links e âncoras mortos são apontados; renomeações são corrigidas automaticamente pelo histórico do git.
- **Infere a sua arquitetura.** Propõe as fronteiras entre camadas que o código já respeita, verificadas, e desenha o grafo.
- **Aprende com os erros.** Violações capturadas durante o trabalho viram regras aprendidas, para os agentes não repetirem.
- **Escala para monorepos e equipes.** Harness por workspace, regras customizadas e pacotes de regras compartilháveis.

## Começando

```bash
npx gearness init       # detecta a stack e gera o harness
# preencha os marcadores TODO(gearness) com conhecimento real do seu código
npx gearness doctor     # nota + principais correções
npx gearness lint       # problemas no estilo eslint (sai com 1 se houver erros)
npx gearness install    # hook do Claude Code + pre-commit + servidor MCP
```

Requer Node.js 18+ em Linux, macOS ou Windows. Detecta projetos Node, Python, Go, Java, Rust e .NET, além de
Makefile, justfile e Taskfile. Monorepo? `npx gearness init --workspaces`.

## Comandos

| Comando | O que faz |
|---|---|
| `gearness init` | Gera o harness. `--workspaces`, `--stack`, `--agents`, `--no-ci`, `--dry-run`, `--force` |
| `gearness lint` | Lista problemas. `--fix` regenera adaptadores desatualizados. `--json` |
| `gearness doctor` | Nota por pilar e principais correções. `--ci` bloqueia, `--markdown` para resumo no PR |
| `gearness sync` | Regenera os adaptadores a partir do `AGENTS.md`. `--check` para CI |
| `gearness ratchet add` | Registra uma falha do agente e o guardrail que agora a impede |
| `gearness ratchet list` | Mostra o histórico e a proporção de guardrails mecânicos |
| `gearness check [arquivos]` | Checagem rápida dos arquivos alterados. `--staged` (pre-commit), `--hook claude` |
| `gearness install` | Instala hooks e o servidor MCP no repositório. `--only`, `--command`, `--uninstall` |
| `gearness mcp` | Servidor MCP (stdio) para os agentes consultarem o harness |
| `gearness eval` | Roda tarefas de avaliação com um agente. `--runs`, `--parallel`, `--baseline <ref>`, `--min-pass-rate` |
| `gearness eval new <id>` / `list` / `report` | Cria, lista tarefas ou mostra a tendência da taxa de acerto |
| `gearness boundaries suggest` | Infere as fronteiras de arquitetura pelos imports, verificadas no código. `--write` |
| `gearness graph` | Grafo de dependências entre módulos (Mermaid, DOT, JSON) com violações e ciclos |
| `gearness context [caminho]` | Raio-X de contexto: o que cada agente carrega para um caminho, custo em tokens, duplicações |
| `gearness learn` | Transforma erros repetidos dos agentes em regras aprendidas. `--apply` |
| `gearness explain <regra>` | Explica uma regra e mostra o que ela encontrou no repositório |
| `gearness badge` | Gera um badge com a nota para o README |
| `gearness rules` | Lista as regras (nativas e customizadas), pilares e pesos |

## A catraca (ratchet)

O hábito central do harness engineering: quando o agente erra duas vezes, não corrija a saída - mude o sistema para que
o erro fique difícil de repetir, e nunca deixe essa correção sumir em silêncio.

```bash
# Melhor: um guardrail mecânico (regra de lint, teste, tipo, hook, CI). Ele precisa já existir.
gearness ratchet add --fix lint --artifact eslint.config.js \
  --failure "Agente importou a camada de banco direto no controller"

# Quando ainda não dá para automatizar: uma regra aprendida, escrita no AGENTS.md e sincronizada.
gearness ratchet add --fix doc \
  --failure "Agente editou código gerado" --rule "Nunca edite src/generated; rode npm run codegen"
```

O `lint` falha se um artefato registrado for apagado ou se uma regra aprendida for removida do `AGENTS.md`.

## Durante o trabalho do agente

`gearness install` configura um hook no Claude Code: segundos depois de o agente editar um arquivo que cruza uma
fronteira de arquitetura ou vaza uma chave, ele recebe o erro e corrige antes de seguir. Pelo servidor MCP, o agente
também pode perguntar `harness_can_import` antes de escrever um import e `harness_check_files` antes de dar a tarefa
como concluída. Veja [docs/integrations.md](docs/integrations.md).

## Inferência de arquitetura

`gearness boundaries suggest --write` lê o grafo de imports, propõe que "camadas de baixo nunca importam as de cima"
para cada dependência de mão única, verifica que cada proposta tem zero violações hoje e aponta ciclos em vez de
escondê-los. Ninguém precisa escrever regras de camadas à mão. `gearness graph --markdown` desenha tudo em Mermaid,
com as violações em vermelho. Veja [docs/architecture.md](docs/architecture.md).

## Raio-X de contexto

`gearness context <caminho>` mostra o que cada agente realmente carrega ao trabalhar num arquivo - arquivos aninhados,
`@imports`, regras por glob, `applyTo` - com o custo em tokens, instruções duplicadas e lacunas.

## Um harness que aprende

Cada violação capturada pelos hooks e pelo MCP é registrada localmente. `gearness learn` encontra o que os agentes
erram repetidamente e `--apply` transforma isso em regras aprendidas no `AGENTS.md`. Veja [docs/learning.md](docs/learning.md).

## Gate de regressão

Nos pull requests, o workflow gerado compara o harness com o da branch base e falha se ele piorou
(`doctor --base origin/main --no-regress`).

## Evals: prove que o harness ajuda

```bash
gearness eval new adicionar-healthcheck   # cria a tarefa em .harness/evals/
gearness eval --baseline main --runs 3    # compara o harness atual com o da main
```

Cada execução acontece em um git worktree descartável, com o **mesmo código** e um **harness diferente**. Assim, a
diferença na taxa de acerto vem da mudança no harness. Funciona com Claude Code, Codex, Aider, Gemini CLI ou qualquer
comando. Veja [docs/eval.md](docs/eval.md).

## Fronteiras de arquitetura

```yaml
boundaries:
  - from: "src/ui/**"
    deny: ["src/db/**"]
    message: a UI passa pelos services, nunca direto no banco
```

## Regras customizadas

Coloque um arquivo em `.harness/rules/` ou publique regras como pacote npm - veja [docs/plugins.md](docs/plugins.md).

## Pontuação

Vinte e uma regras em seis pilares: **contexto**, **verificação**, **arquitetura**, **ferramentas de agente**, **segurança** e **ciclo de feedback**.
Um harness recém-criado tira cerca de 75: a estrutura existe, o conhecimento ainda não. Veja [docs/rules.md](docs/rules.md)
e [docs/principles.md](docs/principles.md).

## Contribuindo

Issues e PRs são bem-vindos - veja [CONTRIBUTING.md](CONTRIBUTING.md). Este repositório usa o próprio gearness:
comece pelo [AGENTS.md](AGENTS.md).

## Licença

MIT © [Tomaz Alexandre](https://github.com/TomazAlexandre)
