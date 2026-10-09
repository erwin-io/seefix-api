# SEEFIX API — Claude development automation (opt-in)

The cross-repository ChatGPT review watcher assesses API PRs and files API follow-up issues at https://github.com/erwin-io/seefix-api/issues. This GitHub Actions workflow is a **separate** Claude Code developer, not the ChatGPT reviewer. It does not run until this PR is merged, required secrets exist, and the repository owner explicitly triggers an issue.

## Enable
1. Review the workflow and merge its PR, subject to required review/CI.
2. Add repository Actions secret `ANTHROPIC_API_KEY` in Settings → Secrets and variables → Actions. Claude GitHub App connection alone does not populate this secret; Anthropic API use can incur charges.
3. Protect `main` (required checks, non-bypass review); issue-to-code tasks must always open a reviewable PR.
4. To trigger, the **erwin-io** account labels a bounded open issue `claude-build` or posts a comment starting with `@claude`.
5. Ensure the generated PR includes green `npm run check`, `npm test` and relevant DB-aware acceptance evidence before human approval.

Do not trigger from untrusted issue comments automatically. Review every backend auth/RBAC/schema/transaction/workflow PR before merging. GitHub Actions cannot independently confirm live DB or external API integration without configured test services and credentials.

Existing durable OutboxEvents and production data must not be modified destructively without a separately reviewed migration.
