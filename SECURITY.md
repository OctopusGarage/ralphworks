# Security Policy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/OctopusGarage/ralphworks/security/advisories/new). Do not post credentials or exploitable details in public issues.

RalphWorks executes task instructions and optional check commands with the permissions of its selected host, container, or GitHub Actions runner. Run only trusted tasks and checks. Credentials belong in Pi's authentication store or GitHub Actions secrets, never in task files or commits.
