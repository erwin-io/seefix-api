# SEEFIX — automated Claude issue development

Requires **manual owner configuration before activation**:
1. Confirm the Claude GitHub App is installed for this exact repository (not merely another SEEFIX repository).
2. Add the repository GitHub Actions secret `ANTHROPIC_API_KEY` from Anthropic Console. Never include it in issues, PRs or source files; paid API usage may apply.
3. Protect `main`: require pull requests, verified passing required test CI, no force pushes or bypass, review for security/permissions/database changes. Configure Actions permissions for the authenticated Claude App to create **draft PRs**.
4. Review and merge this workflow PR. Confirm required CI workflow completes successfully on a harmless smoke-test PR.
5. To dispatch one bounded approved issue, the trusted `erwin-io` account either adds the `claude-build` label to its issue (create label first) OR posts an issue comment whose first characters are `@claude`. ChatGPT's scheduled GitHub reviewer may submit that comment from an authorized identity only when a concrete issue is approved for implementation.
6. Verify Actions → SEEFIX Claude implementation executes, creates a fresh branch/draft PR, and downstream CI runs. The action never merges or closes issues automatically.

Runs are owner/issue-author gated, serialized per repository, limited to 35 Claude turns and 65 minutes, and pinned to immutable Claude and checkout commits. The API key and GitHub app installation are required independently of a Claude browser session.

No automatic merge for authentication, authorization, migrations, procurement, Pusher external delivery, worker safety, or AI business decisions. ChatGPT hourly review is a separate scheduler; GitHub triggers run promptly after authorized issue comments. New issue creation without a trusted dispatch comment or label does not start Claude.

**CI prerequisite:** This PR adds a native project test workflow with appropriate package installation and checks. A passing GitGuardian or Vercel annotation alone does not count as application CI.

**If the action is denied:** verify GitHub Actions enabled, repo secret configured, Claude GitHub App repository access, issue owner and trigger actor, branch protection and draft-PR GitHub permissions.
