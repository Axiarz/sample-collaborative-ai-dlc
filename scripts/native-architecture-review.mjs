#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hasArchitectureReview, semanticReviewRequired } from './lib/native-architecture.mjs';

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
if (event.pull_request) {
  const pr = event.pull_request;
  const api = (path) =>
    JSON.parse(
      execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8' }),
    ).flat();
  const files = api(`repos/${process.env.GITHUB_REPOSITORY}/pulls/${pr.number}/files`).map(
    (file) => file.filename,
  );
  if (semanticReviewRequired(files)) {
    const { reviewers } = JSON.parse(readFileSync('architecture/native-owners.json', 'utf8'));
    const reviews = api(`repos/${process.env.GITHUB_REPOSITORY}/pulls/${pr.number}/reviews`);
    if (!hasArchitectureReview({ head: pr.head.sha, author: pr.user.login, reviews, reviewers }))
      throw new Error(
        'A declared architecture reviewer must approve this exact PR head. Review owners, transitions/failure cases and replay/compatibility evidence in the PR description.',
      );
  }
}
