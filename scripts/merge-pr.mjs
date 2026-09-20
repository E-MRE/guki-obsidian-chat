#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const REQUIRED_CHECKS = ['Quality', 'Conventional Commits'];
const ACTIONS_APP_ID = 15368;

function usage() {
  console.error('Usage: npm run merge-pr -- <pull-request-number>');
  process.exit(2);
}

function runGh(args, input) {
  try {
    return execFileSync('gh', ['api', ...args], {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    const stdout = error.stdout?.toString().trim();
    throw new Error(stderr || stdout || error.message);
  }
}

function ghJson(endpoint, args = [], input) {
  const raw = runGh([endpoint, ...args], input);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`GitHub API returned non-JSON output for ${endpoint}`);
  }
}

function ghGraphql(query, variables) {
  const args = ['graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push('-F', `${key}=${value}`);
  }
  const raw = runGh(args);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('GitHub GraphQL API returned non-JSON output');
  }
}

function currentUserLogin() {
  return execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
}

function repoName() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (repo) return repo;

  const raw = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    encoding: 'utf8',
  }).trim();
  if (!raw) throw new Error('Could not determine the GitHub repository. Set GH_REPO.');
  return raw;
}

function splitRepo(repo) {
  const match = /^([^/]+)\/([^/]+)$/.exec(repo);
  if (!match) throw new Error(`Invalid repository name: ${repo}`);
  return { owner: match[1], name: match[2] };
}

function validatePrTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string' || rawTitle.trim().length === 0) return false;
  const title = rawTitle.trim();
  if (/^[^\s:]+\s+:/.test(title)) return false;

  const match = title.match(/^([a-zA-Z0-9_-]+)(?:\(([^()\r\n]*)\))?(!)?(:)(\s*)(.*)$/s);
  if (!match) return false;

  const [, type, scope, , , whitespace, description] = match;
  const allowedTypes = new Set([
    'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert',
  ]);
  return type === type.toLowerCase()
    && allowedTypes.has(type)
    && (scope === undefined || scope.trim().length > 0)
    && whitespace.length > 0
    && description.trim().length > 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function latestReviews(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    if (!review.user?.id) continue;
    const previous = latest.get(review.user.id);
    if (!previous || new Date(review.submitted_at || 0) > new Date(previous.submitted_at || 0)) {
      latest.set(review.user.id, review);
    }
  }
  return [...latest.values()];
}

function checkStatus(checkRuns, name) {
  const matching = checkRuns.filter((check) => (
    check.name === name && check.app?.id === ACTIONS_APP_ID
  ));
  assert(matching.length > 0, `Required check "${name}" was not reported by GitHub Actions (app ${ACTIONS_APP_ID}).`);

  matching.sort((a, b) => new Date(b.completed_at || b.started_at || 0) - new Date(a.completed_at || a.started_at || 0));
  const latest = matching[0];
  assert(latest.status === 'completed' && latest.conclusion === 'success',
    `Required check "${name}" is not successful: ${latest.status}/${latest.conclusion}.`);
}

function main() {
  const prNumber = process.argv[2];
  if (!/^\d+$/.test(prNumber || '')) usage();

  const repo = repoName();
  const { owner, name } = splitRepo(repo);
  const prEndpoint = `repos/${repo}/pulls/${prNumber}`;
  const pr = ghJson(prEndpoint);

  assert(pr.state === 'open', `PR #${prNumber} is ${pr.state}; only open PRs can be merged.`);
  assert(pr.draft !== true, `PR #${prNumber} is still a draft.`);
  assert(pr.base?.ref === 'main', `PR #${prNumber} targets ${pr.base?.ref || '(unknown)'}, not main.`);
  const selfAuthored = pr.user?.login === currentUserLogin();
  assert(pr.mergeable === true, `PR #${prNumber} is not currently mergeable (${pr.mergeable}).`);
  if (selfAuthored) {
    // GitHub cannot record a self-approval, so a solo-maintainer PR is permanently
    // "blocked" on the review requirement alone. Every other invariant below (required
    // checks, no changes requested, resolved threads, SHA lock) still applies in full.
    assert(pr.mergeable_state === 'clean' || pr.mergeable_state === 'blocked',
      `PR #${prNumber} merge state is ${pr.mergeable_state}, not clean or review-blocked.`);
  } else {
    assert(pr.mergeable_state === 'clean', `PR #${prNumber} merge state is ${pr.mergeable_state}, not clean.`);
  }
  assert(validatePrTitle(pr.title), `PR title is not a valid Conventional Commit: ${pr.title}`);

  const headSha = pr.head?.sha;
  assert(/^[0-9a-f]{40}$/.test(headSha || ''), 'PR head SHA is missing or invalid.');

  const checkRuns = ghJson(`repos/${repo}/commits/${headSha}/check-runs`, ['--method', 'GET', '-f', 'per_page=100']).check_runs || [];
  for (const requiredCheck of REQUIRED_CHECKS) checkStatus(checkRuns, requiredCheck);

  const reviews = ghJson(`${prEndpoint}/reviews`, ['--method', 'GET', '-f', 'per_page=100']);
  const latest = latestReviews(reviews);
  assert(!latest.some((review) => review.state === 'CHANGES_REQUESTED'), 'A reviewer has requested changes.');
  if (!selfAuthored) {
    assert(latest.some((review) => review.state === 'APPROVED'), 'At least one current approving review is required.');
  }

  const reviewThreads = ghGraphql(
    `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$number){
          reviewThreads(first:100){
            nodes{isResolved}
            pageInfo{hasNextPage}
          }
        }
      }
    }`,
    { owner, name, number: Number(prNumber) },
  ).data?.repository?.pullRequest?.reviewThreads;
  assert(reviewThreads, 'Could not inspect pull request review threads.');
  assert(reviewThreads.pageInfo.hasNextPage !== true, 'Pull request has more than 100 review threads; inspect them before merging.');
  assert(reviewThreads.nodes.every((thread) => thread.isResolved), 'Pull request has unresolved review threads.');

  console.log(`Preflight passed for ${repo}#${prNumber} at ${headSha}.`);
  console.log(`Merging with squash, explicit empty body, and optimistic-lock SHA ${headSha}.`);

  const merge = ghJson(`${prEndpoint}/merge`, [
    '--method', 'PUT',
    '--input', '-',
  ], JSON.stringify({
    sha: headSha,
    merge_method: 'squash',
    commit_title: `${pr.title} (#${prNumber})`,
    commit_message: '',
  }));

  assert(merge.merged === true, `GitHub did not merge the PR: ${merge.message || 'unknown response'}`);
  console.log(`Merged PR #${prNumber}: ${merge.sha || '(merge SHA not returned)'}`);
}

try {
  main();
} catch (error) {
  console.error(`merge-pr: ${error.message}`);
  process.exit(1);
}
