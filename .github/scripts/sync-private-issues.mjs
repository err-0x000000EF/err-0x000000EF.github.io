import { createHmac } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const temp = process.env.RUNNER_TEMP;
const outputFile = process.env.GITHUB_OUTPUT;
const owner = required('ISSUE_SOURCE_OWNER');
const repo = required('ISSUE_SOURCE_REPO');
const token = required('ISSUE_SOURCE_TOKEN');
const key = required('SYNC_HMAC_KEY');
const contentDir = path.join(temp, 'issue-sync-content');
const cacheDir = path.join(temp, 'issue-sync-state');
const candidateFile = path.join(temp, 'issue-sync-candidate');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('missing required configuration');
  return value;
}

function hmac(value) {
  return createHmac('sha256', key).update(value).digest('hex');
}

function slugify(value) {
  const slug = value.toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'issue';
}

function yamlString(value) {
  return JSON.stringify(value ?? '');
}

async function getPublishedIssues() {
  const results = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`);
    url.searchParams.set('state', 'open');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'beyond-errors-issue-publisher',
      },
    });
    if (!response.ok) throw new Error('GitHub API request failed');
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('Unexpected API response');
    results.push(...batch.filter((item) => !item.pull_request));
    if (batch.length < 100) break;
  }

  return results.flatMap((issue) => {
    const labels = (issue.labels ?? []).map((label) => label.name);
    if (!labels.includes('publish') || labels.some((label) => /^(draft|private|no-publish)$/i.test(label))) return [];
    const tags = labels
      .filter((label) => /^tag:/i.test(label))
      .map((label) => label.replace(/^tag:\s*/i, '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return [{
      number: issue.number,
      title: issue.title ?? 'Untitled',
      date: issue.created_at,
      body: issue.body ?? '',
      tags,
    }];
  }).sort((a, b) => a.number - b.number);
}

async function main() {
  await rm(contentDir, { recursive: true, force: true });
  await mkdir(contentDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  const articles = await getPublishedIssues();
  const snapshot = JSON.stringify({ owner, repo, articles });
  const digest = hmac(snapshot);
  const previousPath = path.join(cacheDir, 'snapshot.hmac');
  let previous = '';
  try { previous = (await readFile(previousPath, 'utf8')).trim(); } catch { /* First run. */ }
  const changed = digest !== previous;
  await writeFile(candidateFile, `${digest}\n`, { mode: 0o600 });

  if (changed) {
    for (const article of articles) {
      const privateId = hmac(`${owner}/${repo}#${article.number}`).slice(0, 12);
      const slug = `${slugify(article.title)}-${privateId}`;
      const frontMatter = [
        '---',
        `title: ${yamlString(article.title)}`,
        `date: ${yamlString(article.date)}`,
        `slug: ${yamlString(slug)}`,
        `tags: ${JSON.stringify(article.tags)}`,
        '---',
        '',
        article.body,
        '',
      ].join('\n');
      await writeFile(path.join(contentDir, `${privateId}.md`), frontMatter, { mode: 0o600 });
    }
  }

  await appendFile(outputFile, `changed=${changed}\n`);
  console.log(changed ? 'Private issue snapshot changed.' : 'No publishable changes.');
}

main().catch(() => {
  console.error('Issue synchronization failed; details are suppressed.');
  process.exitCode = 1;
});
