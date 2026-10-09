# Project Instructions

## 役割分担とオーケストレーション方針

Claude CodeとCodexは利用量に制限があるため、実作業（コードの生成・修正そのものを細かく実行する作業）は基本的にOrnithへ細分化して依頼し、Claude CodeとCodexは「頭」として設計・指示・検証に専念すること。

- **Claude CodeとCodexを「頭」とする2層構成。** どちらか一方がその時々のオーケストレーション（作業の分解・Ornithへの指示・とりまとめ）を担当する。
- **オーケストレーション担当でない方の頭は、コード検証担当のsubagentとして動く。** 例: Claude Codeがオーケストレーションを担当するときはCodexがsubagentとしてコード検証（レビュー）を担当する。逆にCodexがオーケストレーションを担当するときはClaude Codeが検証担当のsubagentとなる。
- **複雑な編集や、Ornithで解決できない場合は、もう片方の頭に依頼する。** 対象は次のいずれか: 編集が複雑・リスクが高い、Ornithから反応が返らない、Ornithが同じ内容を繰り返すループに陥る、Ornithでは問題が解決しない。これらの場合、オーケストレーション担当はOrnithに再度投げるのではなく、もう片方の頭（Codexまたは Claude Code）にコード編集そのものを依頼すること。
- **Ornithは同時に2体まで起動して依頼してよい。**
- 各ツールの具体的な呼び出し方法は、本ファイル内の「Local coding worker」「Codexをサブエージェントとして利用する」「Codex側からClaude Codeをサブエージェントとして呼び出す場合」を参照。

## バージョン管理ルール

- コードにバージョン表記があることを確認する。
- コードを編集したら、バージョンを0.01加算する。
- バージョンは、コード先頭付近とトップ画面の片隅の両方に表記する。

## Local coding worker

A local coding worker is available through:

```bash
ornith-worker "<prompt>"
```

It runs Ornith-1.5-9B Q4_K_M locally through Ollama.

Use Ornith when useful for:

- independent code review
- bug hunting
- implementation suggestions
- parallel investigation
- second opinions on non-trivial changes

Rules:

- Ornith does not automatically know the repository contents.
- Include all necessary source code, filenames, error messages, and context in the prompt.
- Treat Ornith's output as advisory.
- Verify its conclusions before applying changes.
- Prefer Claude or Codex for final architectural decisions.
- Do not invoke Ornith for trivial tasks where direct inspection is faster.

## Ornith呼び出しの実践知見（失敗から学んだ運用ルール）

2,400行超のJSファイル全体を一度にプロンプトへ渡したところ、Ornithの応答が同じ段落を50回以上繰り返すループに陥り、コンテキスト上限で強制終了し、依頼した4項目中1項目しか完了しなかった。この失敗を踏まえ、以降Ornithに依頼する際は次を守ること。

- **大きな入力をそのまま丸ごと渡さない。** ファイル全体ではなく、レビュー対象を絞る（例: 修正のレビューなら全文ではなく `git diff` のみ、新規コードのレビューなら本質的なロジック部分のみを渡し、純粋なデータ配列などはコメントで要約して省略する）。
- **出力形式をプロンプトで明示的に制約する。** 「最終回答は簡潔な箇条書きのみ」「同じ内容を繰り返さない」「各セクション最大5項目まで」を明記すると、暴走的な繰り返し出力を防げる。
- **Ollama API呼び出し時の推奨オプション:** `repeat_penalty: 1.3` 程度、`repeat_last_n: 256` 程度を指定して繰り返しループを抑制する。`num_ctx` は入力量に見合うだけ確保しつつ、`num_predict` にも上限を設け、万一ループしても暴走・長時間化しないようにする。
- **それでも大きい場合は分割して依頼する。** 「バグ・可読性・改善案・複雑さ」を一度に全部聞くのではなく、入力が大きい場合はセクションごとに分けて依頼する方が完走率が高い。

## Codexをサブエージェントとして利用する

Codexは`codex`という単体コマンドとしてPATHには入っていないが、VSCode拡張機能「openai.chatgpt」に実行ファイルが同梱されており、フルパスを直接叩けば動作する（認証・設定は`~/.codex/`に既存）。

```bash
CODEX_BIN=$(ls -d ~/.vscode/extensions/openai.chatgpt-*-darwin-arm64/bin/macos-aarch64/codex 2>/dev/null | sort -V | tail -1)
"$CODEX_BIN" exec --sandbox read-only "<prompt>"          # 非対話的に質問・レビューさせる
"$CODEX_BIN" exec --sandbox read-only review              # 現在のリポジトリに対してコードレビューさせる
```

- 拡張機能はバージョンアップで頻繁にディレクトリ名（バージョン番号部分）が変わるため、固定パスを書かずに上記のように`ls -d ... | sort -V | tail -1`で最新版を動的に検出すること。
- デフォルトの`--sandbox`は`workspace-write`のためファイル変更が起こり得る。単なる質問・レビュー目的なら`--sandbox read-only`を明示し、意図しない変更を防ぐこと。
- Ornithと同様、Codexの出力もadvisory（参考意見）として扱い、結論は適用前に検証すること。

## Codex側からClaude Codeをサブエージェントとして呼び出す場合

同様に、Claude Code本体もVSCode拡張機能「anthropic.claude-code」に実行ファイルが同梱されている。

```bash
CLAUDE_BIN=$(ls -d ~/.vscode/extensions/anthropic.claude-code-*-darwin-arm64/resources/native-binary/claude 2>/dev/null | sort -V | tail -1)
"$CLAUDE_BIN" -p "<prompt>"     # -p/--print で非対話的に実行
```

- こちらも拡張機能のバージョンアップでパスが変わるため、`sort -V | tail -1`で最新版を動的に検出すること。
- 上記コマンドで見つからない場合は、Codex自身が同じ手順（`~/.vscode/extensions/`配下を`claude`という名前で探索）でパスを探すこと。
